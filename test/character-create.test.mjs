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

await test('ability keys are case-insensitive ("str" means STR)', async () => {
  const out = await tool.execute({
    name: 'CaseTest', klass: 'Fighter', level: 1, hp: 12, ac: 16,
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 8 },
  }, exec)
  assert.match(out, /Created CaseTest/)
  const c = await readCharacter(fs, charactersDir, 'casetest')
  const s = c.state
  assert.equal(s.abilities.STR, 16, 'lowercase keys must land as scores, not vanish into the default 10')
  assert.equal(s.abilities.CHA, 8)
  assert.equal(s.saves.STR, 5, 'derived saves must see the normalized score')
  assert.equal(s.combat.initiative, 1, 'DEX +1 drives initiative')
})

await test('an unrecognized ability key refuses the WHOLE create — no silent 10s', async () => {
  const before = new Set(readdirSync(nodePath(charactersDir)))
  const out = await tool.execute({
    name: 'SilentTen', klass: 'Fighter', level: 1,
    abilities: { STR: 16, strength: 18, DEX: 12 },
  }, exec)
  assert.match(out, /refused/)
  assert.match(out, /unrecognized ability key "strength"/)
  assert.match(out, /Nothing was written/)
  const after = new Set(readdirSync(nodePath(charactersDir)))
  assert.deepEqual([...after].filter((f) => !before.has(f)), [], 'no file may appear for a refused create')
})

await test('a non-numeric ability value refuses the create too', async () => {
  const out = await tool.execute({ name: 'NaN', abilities: { STR: 'sixteen' } }, exec)
  assert.match(out, /refused/)
  assert.match(out, /is not a number/)
})

await test('an unknown skill name warns instead of vanishing', async () => {
  const out = await tool.execute({ name: 'SkillWarn', skills: ['Arcana', 'Dragonology'] }, exec)
  assert.match(out, /WARNING: these skill names were not recognized/)
  assert.match(out, /Dragonology/)
  assert.match(out, /Arcana \+2/)
})

// ─── ruleset follows the campaign ──────────────────────────────────────────
section('the campaign\'s declared ruleset picks the class dataset')

await test('a 2024 campaign builds its casters from the 2024 class table', async () => {
  // The regression: the tool hardcoded ruleset 2014, so a wizard in a 2024
  // campaign was born a spellbook caster (3 cantrips, no prepared line) even
  // though state.md declared **Ruleset**: 2024 and the 2024 skeleton was in
  // the dataset all along.
  writeFileSync(nodePath(tempRoot + '/campaigns/testcamp/state.md'),
    '---\n- **Name**: testcamp\n- **Ruleset**: 2024\n---\n', 'utf8')
  try {
    const out = await tool.execute({ name: 'Modernist', klass: 'Wizard', level: 1, abilities: { INT: 16 } }, exec)
    assert.match(out, /Class table \(2024\)/, out)
    assert.match(out, /3 cantrips known/, out)
    assert.match(out, /4 spells prepared/, out)
    const state = JSON.parse(readFileSync(nodePath(charactersDir + '/modernist.state.json'), 'utf8'))
    assert.equal(state.spellcasting.ability, 'INT', 'the 2024 wizard skeleton casts with INT')
    assert.equal(state.spellSlots['1'].total, 2, '2024 wizard lv1 has two 1st-level slots')
  } finally {
    rmSync(nodePath(tempRoot + '/campaigns/testcamp/state.md'), { force: true })
  }
})

await test('a 2014 campaign still reads the 2014 table', async () => {
  writeFileSync(nodePath(tempRoot + '/campaigns/testcamp/state.md'),
    '---\n- **Name**: testcamp\n- **Ruleset**: 2014\n---\n', 'utf8')
  try {
    const out = await tool.execute({ name: 'Traditionalist', klass: 'Wizard', level: 1, abilities: { INT: 16 } }, exec)
    assert.match(out, /Class table \(2014\)/, out)
  } finally {
    rmSync(nodePath(tempRoot + '/campaigns/testcamp/state.md'), { force: true })
  }
})

console.log(process.exitCode === 1 ? '\ncharacter-create.test.mjs: FAILURE(S)' : '\ncharacter-create.test.mjs: all assertions passed')
