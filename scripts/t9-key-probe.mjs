/**
 * T9 acceptance probe: does the advertised `key` idempotency parameter
 * actually do anything on the three T9 tools?
 *
 * The schemas advertise it ("Repeating a call with the same key changes nothing
 * the second time"). This probe calls each tool TWICE with the SAME key and
 * reports whether the second call was a no-op.
 *
 * Evidence only - not part of the check chain.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildTools } from '../src/host/tools/effects.mjs'

const tempRoot = mkdtempSync(path.join(tmpdir(), 'dnd-t9-key-')).replace(/\\/g, '/')
const CHAR_DIR = tempRoot + '/campaigns/testcamp/characters'
mkdirSync(path.join(tempRoot, 'campaigns', 'testcamp', 'characters'), { recursive: true })
mkdirSync(path.join(tempRoot, '.runtime'), { recursive: true })
process.on('exit', () => { try { rmSync(tempRoot, { recursive: true, force: true }) } catch {} })

writeFileSync(path.join(tempRoot, 'campaigns', 'testcamp', 'state.md'), '# T\n\n**Ruleset:** 2024\n', 'utf8')
writeFileSync(path.join(tempRoot, '.runtime', 'active-campaign.json'), JSON.stringify({ name: 'testcamp' }), 'utf8')

const DATA_ROOT = ['D:', 'DND'].join('/')
const remap = (p) => String(p).replace(new RegExp('^' + DATA_ROOT.replace(/[/]/g, '\\/') + '\\/(campaigns|\.runtime)', 'i'), tempRoot + '/$1')
const nodePath = (p) => String(p).replace(/\//g, path.sep)
const makeTarget = (d) => ({ targetKey: String(d).toLowerCase(), displayPath: String(d), toString() { return String(d) } })
const fsService = {
  async resolve(p) { return makeTarget(remap(p)) },
  async stat(t) { try { const s = (await import('node:fs')).statSync(nodePath(remap(t.displayPath))); return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs } } catch { return undefined } },
  async readText(t) { return readFileSync(nodePath(remap(t.displayPath)), 'utf8') },
  async writeText(t, text) { writeFileSync(nodePath(remap(t.displayPath)), text, 'utf8') },
  async listDir(t) { const b = remap(t.displayPath).replace(/\/$/, ''); return (await import('node:fs')).readdirSync(nodePath(b), { withFileTypes: true }).map((e) => ({ name: e.name, target: makeTarget(b + '/' + e.name), type: e.isDirectory() ? 'directory' : 'file' })) },
}

const ctx = { get: (n) => (n === 'fs' ? fsService : undefined) }
const byName = Object.fromEntries(buildTools(ctx).map((t) => [t.name, t]))

function state() {
  return { schema: 1, name: 'Alice', identity: { race: 'Elf', class: 'Wizard', level: 1 },
    abilities: { INT: 15 }, combat: { hp: { current: 4, max: 8 }, tempHp: 0, ac: 12, initiative: 2, speed: 30, hitDice: { die: 'd6', remaining: 1 }, deathSaves: { successes: 0, failures: 0 } },
    saves: { CON: 2 }, spellSlots: { 1: { total: 2, used: 0 } }, conditions: [] }
}
writeFileSync(nodePath(CHAR_DIR + '/alice.state.json'), JSON.stringify(state(), null, 2) + '\n', 'utf8')
writeFileSync(nodePath(CHAR_DIR + '/alice.md'), '# Alice\n', 'utf8')

const enc = () => existsSync(nodePath(CHAR_DIR + '/alice.encounter.json'))
  ? JSON.parse(readFileSync(nodePath(CHAR_DIR + '/alice.encounter.json'), 'utf8')) : null

const KEY = 't9-key-probe-1'
console.log('whether the SAME key makes the SECOND call a no-op:\n')

// 1. dnd_effect start
const e1 = await byName.dnd_effect.execute({ action: 'start', name: 'Mage Armor', duration: '8h', key: KEY })
const afterE1 = JSON.stringify(enc().sections.effects)
const e2 = await byName.dnd_effect.execute({ action: 'start', name: 'Mage Armor', duration: '8h', key: KEY })
const afterE2 = JSON.stringify(enc().sections.effects)
console.log('dnd_effect start      2nd reply:', JSON.stringify(e2.split('\n')[0]))
console.log('  stored before 2nd:', afterE1)
console.log('  stored after  2nd:', afterE2)
console.log('  -> idempotent?', afterE1 === afterE2 ? 'YES' : 'NO - THE SECOND CALL RE-APPLIED')

// 2. dnd_concentration start
const c1 = await byName.dnd_concentration.execute({ action: 'start', spell: 'Mage Armor', key: KEY })
const beforeC = JSON.stringify(enc().sections.concentration)
const c2 = await byName.dnd_concentration.execute({ action: 'start', spell: 'Mage Armor', key: KEY })
const afterC = JSON.stringify(enc().sections.concentration)
console.log('\ndnd_concentration     2nd reply:', JSON.stringify(c2.split('\n')[0]))
console.log('  before/after 2nd:', beforeC, '/', afterC)
console.log('  -> creates a DIFFERENT since stamp?', beforeC !== afterC ? 'YES - RE-WROTE THE RECORD' : 'no')

// 3. dnd_death_save: the dangerous one - a repeated failure would advance the tally twice
const dBefore = JSON.stringify(enc()?.sections?.deathSaves ?? null)
const d1 = await byName.dnd_death_save.execute({ action: 'failure', key: KEY })
const dMid = JSON.stringify(enc().sections.deathSaves)
const d2 = await byName.dnd_death_save.execute({ action: 'failure', key: KEY })
const dAfter = JSON.stringify(enc().sections.deathSaves)
console.log('\ndnd_death_save        1st reply:', JSON.stringify(d1.split('\n')[0]))
console.log('dnd_death_save        2nd reply:', JSON.stringify(d2.split('\n')[0]))
console.log('  tally before:', dBefore, ' after 1st:', dMid, ' after 2nd:', dAfter)
console.log('  -> idempotent?', dMid === dAfter ? 'YES' : 'NO - ONE RETRY COST A SECOND DEATH-SAVE FAILURE')
