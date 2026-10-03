/**
 * character-create tests.
 *
 * dnd_character_create is the answer to the empty-campaign failure: a fresh
 * workspace gave the GM no format to work from and no write path that was
 * guaranteed parseable. These tests pin both halves:
 *
 *   1. the TEMPLATE answers the "what does a sheet look like" question, and
 *   2. the STRUCTURED create derives every derivable number and produces a
 *      card the reader accepts on the first read — no migration step, no
 *      hand-written format risk.
 *
 * The fs shim maps the tool's paths into a temp tree; the session cwd IS the
 * temp root, which is exactly the production rule (root = session workspace)
 * with no remapping at all.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTools } from '../src/host/tools/character-create.mjs'
import { readCharacter } from '../src/host/tools/state-io.mjs'

async function test(name, fn) {
  try {
    await fn()
    console.log('  ok ' + name)
  } catch (error) {
    console.log('  FAIL ' + name)
    console.log('       ' + (error && error.message ? error.message.split('\n')[0] : error))
    process.exitCode = 1
  }
}
const section = (title) => console.log('\n' + title)

// ─── the fs shim ───────────────────────────────────────────────────────────

const tempRoot = mkdtempSync(path.join(tmpdir(), 'dnd-create-')).replace(/\\/g, '/')
process.on('exit', () => { try { rmSync(tempRoot, { recursive: true, force: true }) } catch { /* gone */ } })

mkdirSync(path.join(tempRoot, 'campaigns', 'testcamp', 'characters'), { recursive: true })
mkdirSync(path.join(tempRoot, '.runtime'), { recursive: true })
writeFileSync(path.join(tempRoot, '.runtime', 'active-campaign.json'), JSON.stringify({ name: 'testcamp' }), 'utf8')

/** The package's real data/ directory, reachable READ-ONLY through the shim:
 * the class skeleton comes from the shipped SRD dataset, which is package
 * property, not workspace data. Everything else must stay in the temp tree. */
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data').replace(/\\/g, '/')
const DATA_PREFIX = 'D:/DND/dsh-dnd-bundle/data'

const guard = (p, method) => {
  const norm = String(p).replace(/\\/g, '/')
  if (norm.startsWith(DATA_PREFIX + '/')) return norm.replace(DATA_PREFIX, DATA_DIR)
  if (!norm.startsWith(tempRoot)) throw new Error('LEAK: fs.' + method + '() outside the temp tree: ' + norm)
  return norm
}
const nodePath = (p) => String(p).replace(/\//g, path.sep)
const makeTarget = (displayPath) => ({ targetKey: String(displayPath).toLowerCase(), displayPath: String(displayPath) })

const fs = {
  async resolve(p) { return makeTarget(guard(p, 'resolve')) },
  async stat(t) {
    const real = guard(String(t.displayPath), 'stat')
    try { const s = statSync(nodePath(real)); return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs } } catch { return undefined }
  },
  async readText(t) { return readFileSync(nodePath(guard(String(t.displayPath), 'readText')), 'utf8') },
  async writeText(t, text) { writeFileSync(nodePath(guard(String(t.displayPath), 'writeText')), text, 'utf8') },
  async listDir(t) {
    const real = guard(String(t.displayPath), 'listDir')
    return readdirSync(nodePath(real), { withFileTypes: true }).map((e) => ({
      name: e.name, target: makeTarget(guard(real + '/' + e.name, 'listDir')), type: e.isDirectory() ? 'directory' : 'file',
    }))
  },
}

/** The session workspace IS the temp root — the production rule, no remap. */
const ctx = {
  get: (n) => {
    if (n === 'fs') return fs
    if (n === 'sessions') return { get: () => ({ header: { cwd: tempRoot } }) }
    if (n === 'sandboxPolicy') return { resolve: ({ session }) => ({ workspaceRoot: session.header.cwd, mode: 'workspace-write', sessionId: 'session-1' }) }
    return undefined
  },
}
const exec = { agent: { id: 'session-1' } }
const tool = buildTools(ctx).find((x) => x.name === 'dnd_character_create')
const charactersDir = tempRoot + '/campaigns/testcamp/characters'

// ─── template ──────────────────────────────────────────────────────────────
section('the template answers the format question')

await test('template:true returns the canonical sheet format', async () => {
  const out = await tool.execute({ template: true })
  assert.ok(out.includes('## Combat Stats') && out.includes('**Race:**') && out.includes('## Spell Slots'))
})

await test('a create without a name is refused, and names the template escape hatch', async () => {
  const out = await tool.execute({})
  assert.match(out, /needs a `name`/)
  assert.match(out, /template: true/)
})

// ─── structured create ─────────────────────────────────────────────────────
section('the structured create derives the numbers and writes both files')

await test('a wizard card is created and read back in one step', async () => {
  const out = await tool.execute({
    name: 'Alice', race: 'Elf (high)', klass: 'Wizard', level: 1, background: 'Sage',
    abilities: { STR: 8, DEX: 14, CON: 12, INT: 16, WIS: 10, CHA: 10 },
    hp: 8, ac: 12, spellAbility: 'INT', spellSlots: { 1: 2 },
    spells: { cantrips: ['Light'], spellbook: ['Detect Magic'], prepared: ['Mage Armor'] },
    skills: ['Arcana', 'Perception', 'Animal Handling'],
    currencyGp: 8,
    narrative: '她是一个游历世界收集法术的精灵法师。',
  }, exec)
  assert.match(out, /Created Alice/)
  assert.match(out, /DC 13/)
  assert.match(out, /attack \+5/)

  const c = await readCharacter(fs, tempRoot + '/campaigns/testcamp/characters', 'alice')
  if (c.needsMigration || !c.hasStateFile) throw new Error('card is not migrated state: ' + JSON.stringify({ needsMigration: c.needsMigration, hasStateFile: c.hasStateFile }))
  const s = c.state
  const ok = s.spellcasting.saveDC === 13 && s.spellcasting.attackBonus === 5
    && s.skills.Arcana?.bonus === 5 && s.skills.Arcana?.proficient === true
    && s.skills.AnimalHandling?.ability === 'WIS'
    && s.combat.initiative === 2
    && s.combat.hitDice.die === 'd6' && s.combat.hitDice.remaining === 1
    && s.currency === 800
    && s.saves.INT === 5 && s.saves.STR === -1
    && s.spells.cantrips.includes('Light')
  assert.ok(ok, 'derived numbers wrong: ' + JSON.stringify(s))
})

await test('a fighter takes hit die and saves from the 2024 class skeleton', async () => {
  const out = await tool.execute({ name: 'Bronn', klass: 'Fighter', level: 1, hp: 10, abilities: { STR: 16, DEX: 12, CON: 14 } }, exec)
  assert.match(out, /Created Bronn/)
  const c = await readCharacter(fs, tempRoot + '/campaigns/testcamp/characters', 'bronn')
  return c.state.combat.hitDice.die === 'd10'
    && c.state.proficientSaves.includes('STR') && c.state.proficientSaves.includes('CON')
    && c.state.saves.STR === 5 && c.state.saves.WIS === 0
    && c.state.spellcasting.saveDC === null
  assert.ok(ok, JSON.stringify(c.state))
})

await test('creating the same name again is refused until overwrite', async () => {
  const refused = await tool.execute({ name: 'Alice', overwrite: false }, exec)
  assert.match(refused, /already exists/)
  const replaced = await tool.execute({ name: 'Alice', overwrite: true, klass: 'Wizard', hp: 8 }, exec)
  assert.match(replaced, /Created Alice/)
})

await test('a non-positive hp is dropped, not written as a negative', async () => {
  const out = await tool.execute({ name: 'Bad', hp: -5 }, exec)
  assert.match(out, /Created Bad/)
  const c = await readCharacter(fs, charactersDir, 'bad')
  assert.ok(!Number.isFinite(c.state.combat.hp.max), 'an impossible hp must not reach the sheet')
})

await test('creation without an active campaign says so', async () => {
  const emptyCtx = {
    get: (n) => {
      if (n === 'fs') return { ...fs, async stat(t) { return undefined } }
      if (n === 'sessions') return { get: () => ({ header: { cwd: tempRoot } }) }
      return undefined
    },
  }
  const lonely = buildTools(emptyCtx).find((x) => x.name === 'dnd_character_create')
  const out = await lonely.execute({ name: 'X' }, exec)
  assert.match(out, /No active campaign/)
})

console.log(process.exitCode === 1 ? '\ncharacter-create.test.mjs: FAILURE(S)' : '\ncharacter-create.test.mjs: all assertions passed')
