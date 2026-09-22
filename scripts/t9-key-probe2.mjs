import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildTools } from '../src/host/tools/effects.mjs'

const tempRoot = mkdtempSync(path.join(tmpdir(), 'dnd-t9-key2-')).replace(/\\/g, '/')
const CHAR_DIR = tempRoot + '/campaigns/testcamp/characters'
mkdirSync(path.join(tempRoot, 'campaigns', 'testcamp', 'characters'), { recursive: true })
mkdirSync(path.join(tempRoot, '.runtime'), { recursive: true })
process.on('exit', () => { try { rmSync(tempRoot, { recursive: true, force: true }) } catch {} })
writeFileSync(path.join(tempRoot, 'campaigns', 'testcamp', 'state.md'), '# T\n\n**Ruleset:** 2024\n', 'utf8')
writeFileSync(path.join(tempRoot, '.runtime', 'active-campaign.json'), JSON.stringify({ name: 'testcamp' }), 'utf8')

const DATA_ROOT = ['D:', 'DND'].join('/')
const remap = (p) => String(p).replace(new RegExp('^' + DATA_ROOT.replace(/[/]/g, '\\/') + '\\/(campaigns|\\.runtime)', 'i'), tempRoot + '/$1')
const nodePath = (p) => String(p).replace(/\//g, path.sep)
const makeTarget = (d) => ({ targetKey: String(d).toLowerCase(), displayPath: String(d), toString() { return String(d) } })
const nfs = await import('node:fs')
const fsService = {
  async resolve(p) { return makeTarget(remap(p)) },
  async stat(t) { try { const s = nfs.statSync(nodePath(remap(t.displayPath))); return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs } } catch { return undefined } },
  async readText(t) { return readFileSync(nodePath(remap(t.displayPath)), 'utf8') },
  async writeText(t, text) { writeFileSync(nodePath(remap(t.displayPath)), text, 'utf8') },
  async listDir(t) { const b = remap(t.displayPath).replace(/\/$/, ''); return nfs.readdirSync(nodePath(b), { withFileTypes: true }).map((e) => ({ name: e.name, target: makeTarget(b + '/' + e.name), type: e.isDirectory() ? 'directory' : 'file' })) },
}
const ctx = { get: (n) => (n === 'fs' ? fsService : undefined) }
const T = Object.fromEntries(buildTools(ctx).map((t) => [t.name, t]))
const state = { schema: 1, name: 'Alice', identity: { race: 'Elf', class: 'Wizard', level: 1 }, abilities: { INT: 15 },
  combat: { hp: { current: 0, max: 8 }, tempHp: 0, ac: 12, initiative: 2, speed: 30, hitDice: { die: 'd6', remaining: 1 }, deathSaves: { successes: 0, failures: 0 } },
  saves: { CON: 2 }, spellSlots: { 1: { total: 2, used: 0 } }, conditions: [] }
writeFileSync(nodePath(CHAR_DIR + '/alice.state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8')
writeFileSync(nodePath(CHAR_DIR + '/alice.md'), '# Alice\n', 'utf8')
const enc = () => existsSync(nodePath(CHAR_DIR + '/alice.encounter.json')) ? JSON.parse(readFileSync(nodePath(CHAR_DIR + '/alice.encounter.json'), 'utf8')) : null

console.log('EACH TOOL WITH ITS OWN KEY - is the 2nd call a no-op?\n')

// death save: the dangerous retry. 3 x failure-with-same-key must NOT kill.
const dA = await T.dnd_death_save.execute({ action: 'failure', key: 'k-death-1' })
const dT1 = JSON.stringify(enc().sections.deathSaves)
const dB = await T.dnd_death_save.execute({ action: 'failure', key: 'k-death-1' })
const dT2 = JSON.stringify(enc().sections.deathSaves)
console.log('dnd_death_save 1st:', JSON.stringify(dA.split('\n')[0]))
console.log('dnd_death_save 2nd:', JSON.stringify(dB.split('\n')[0]))
console.log('  tally after 1st:', dT1, '| after 2nd:', dT2, '=>', dT1 === dT2 ? 'NO-OP OK' : 'RE-APPLIED (BUG)')

// a DIFFERENT key must still apply
const dC = await T.dnd_death_save.execute({ action: 'failure', key: 'k-death-2' })
console.log('  different key applies:', JSON.stringify(enc().sections.deathSaves), '(expect failures 2)')

// no key must apply every time (the correct default)
await T.dnd_death_save.execute({ action: 'failure' })
console.log('  no key applies every time:', JSON.stringify(enc().sections.deathSaves), '(expect failures 3, verdict DEAD)')

// concentration
await T.dnd_concentration.execute({ action: 'start', spell: 'Bless', key: 'k-conc-1' })
const c1 = JSON.stringify(enc().sections.concentration)
await T.dnd_concentration.execute({ action: 'start', spell: 'Bless', key: 'k-conc-1' })
const c2 = JSON.stringify(enc().sections.concentration)
console.log('\ndnd_concentration 1st/2nd concentration:', c1, '/', c2, '=>', c1 === c2 ? 'NO-OP OK' : 'RE-WROTE (BUG)')

// effect end retry
await T.dnd_effect.execute({ action: 'start', name: 'Shield', duration: '1r', key: 'k-eff-1' })
const e1 = JSON.stringify(enc().sections.effects)
await T.dnd_effect.execute({ action: 'start', name: 'Shield', duration: '1r', key: 'k-eff-1' })
const e2 = JSON.stringify(enc().sections.effects)
const eEnd1 = await T.dnd_effect.execute({ action: 'end', name: 'Shield', key: 'k-end-1' })
const afterEnd = JSON.stringify(enc().sections.effects)
const eEnd2 = await T.dnd_effect.execute({ action: 'end', name: 'Shield', key: 'k-end-1' })
console.log('\ndnd_effect start retry:', e1 === e2 ? 'NO-OP OK' : 'RE-APPLIED')
console.log('dnd_effect end 1st:', JSON.stringify(eEnd1.split('\n')[0]), '-> effects:', afterEnd)
console.log('dnd_effect end 2nd:', JSON.stringify(eEnd2.split('\n')[0]))

// tick
await T.dnd_effect.execute({ action: 'start', name: 'Bless', duration: '3r', key: 'k-bless' })
const t1 = JSON.stringify(enc().sections.effects.find((x) => x.name === 'Bless').duration)
await T.dnd_effect.execute({ action: 'tick', rounds: 1, key: 'k-tick-1' })
const t2 = JSON.stringify(enc().sections.effects.find((x) => x.name === 'Bless').duration)
await T.dnd_effect.execute({ action: 'tick', rounds: 1, key: 'k-tick-1' })
const t3 = JSON.stringify(enc().sections.effects.find((x) => x.name === 'Bless').duration)
console.log('\ndnd_effect tick: start', t1, '| after tick', t2, '| after SAME-key tick', t3, '=>', t2 === t3 ? 'NO-OP OK' : 'RE-TICKED (BUG)')

// the ledger must be capped, newest-last
console.log('\nledger section:', JSON.stringify(enc().sections.appliedKeys))
console.log('ledger section keys count:', enc().sections.appliedKeys.length)
