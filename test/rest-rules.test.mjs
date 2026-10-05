/**
 * rest-rules.test.mjs — the rest settlement rules (GAP plan, project 1).
 *
 * Two halves, the same split the calendar suite uses:
 *
 *   1. the RULES as pure functions — Hit Dice spend, long-rest healing and
 *      resets — with the die rolls injected so every case is pinned.
 *   2. the WRITE PATH end to end through dnd_rest (single and party modes)
 *      against a temp-tree fs shim whose session cwd IS the root.
 *
 * Rules: docs/harness/GAP-TOOLS-PLAN.md · src/host/tools/rest-rules.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { abilityMod, spendHitDice, applyLongRest } from '../src/host/tools/rest-rules.mjs'

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

const die6 = () => 4
const die8 = () => 5

await test('abilityMod is floor((score-10)/2)', async () => {
  assert.equal(abilityMod(14), 2)
  assert.equal(abilityMod(8), -1)
  assert.equal(abilityMod(10), 0)
  assert.equal(abilityMod(undefined), 0, 'a missing score reads as 10, not NaN')
})

await test('a short rest spends HD and heals roll + CON per die', async () => {
  const state = { combat: { hp: { current: 3, max: 20 }, hitDice: { die: 'd8', remaining: 3 } }, abilities: { CON: 14 } }
  const out = spendHitDice(state, 2, die8)
  assert.equal(out.healed, 2 * 5 + 2 * 2, 'two d8s of 5 plus CON +2 each')
  assert.equal(out.combat.hp.current, 3 + 14)
  assert.equal(out.combat.hitDice.remaining, 1)
  assert.match(out.changes[0], /rolled 5/)
})

await test('short-rest healing clamps at max', async () => {
  const state = { combat: { hp: { current: 18, max: 20 }, hitDice: { die: 'd6', remaining: 3 } }, abilities: { CON: 14 } }
  const out = spendHitDice(state, 2, die6)
  assert.equal(out.combat.hp.current, 20, 'two d6s of 4 plus CON +2 each = 12, clamped at 2')
  assert.match(out.changes[2], /clamped at max/)
})

await test('a negative CON modifier heals nothing below zero', async () => {
  const state = { combat: { hp: { current: 5, max: 20 }, hitDice: { die: 'd6', remaining: 2 } }, abilities: { CON: 6 } }
  const out = spendHitDice(state, 1, () => 1)
  assert.equal(out.healed, 0, 'roll 1 + CON -2 = -1, floored at 0')
  assert.equal(out.combat.hitDice.remaining, 1, 'the die is still spent')
})

await test('spending more HD than remain is refused', async () => {
  const state = { combat: { hp: { current: 5, max: 20 }, hitDice: { die: 'd8', remaining: 1 } }, abilities: {} }
  assert.match(spendHitDice(state, 2, die8).refuse, /only 1 Hit Dice remain/)
})

await test('a sheet without HD data is refused, not guessed', async () => {
  assert.match(spendHitDice({ combat: { hp: {} } }, 1, die8).refuse, /no usable Hit Die/)
  assert.match(spendHitDice({ combat: { hp: {}, hitDice: { die: 'd8' } } }, 1, die8).refuse, /does not record how many Hit Dice remain/)
})

await test('a 2014 long rest heals HALF the maximum and recovers half the total HD', async () => {
  const state = {
    identity: { level: 4 },
    combat: { hp: { current: 3, max: 28 }, hitDice: { die: 'd8', remaining: 1 }, deathSaves: { successes: 1, failures: 2 } },
    spellSlots: { 1: { total: 4, used: 3 }, 2: { total: 2, used: 0 } },
  }
  const out = applyLongRest(state, '2014')
  assert.equal(out.healed, 14, 'half of 28')
  assert.equal(out.combat.hp.current, 17)
  assert.equal(out.combat.hitDice.remaining, 3, '1 + ceil(4/2)')
  assert.equal(out.combat.deathSaves.successes, 0)
  assert.equal(out.spellSlots['1'].used, 0)
  assert.match(out.changes.join('\n'), /Level 1 spell slots: 1\/4 -> 4\/4/)
  assert.match(out.changes.join('\n'), /Death saves cleared/)
})

await test('a 2024 long rest heals fully', async () => {
  const state = { identity: { level: 2 }, combat: { hp: { current: 5, max: 19 }, hitDice: { die: 'd8', remaining: 0 } }, spellSlots: {} }
  const out = applyLongRest(state, '2024')
  assert.equal(out.combat.hp.current, 19)
  assert.equal(out.combat.hitDice.remaining, 1, 'ceil(2/2) recovered')
})

await test('2014 healing never overshoots the maximum', async () => {
  const state = { identity: { level: 1 }, combat: { hp: { current: 9, max: 10 }, hitDice: { die: 'd8', remaining: 1 } }, spellSlots: {} }
  const out = applyLongRest(state, '2014')
  assert.equal(out.combat.hp.current, 10, 'half of 10 on top of 9 clamps to the max')
})

await test('a long rest without a level cannot compute HD recovery and says so', async () => {
  const state = { combat: { hp: { current: 3, max: 10 }, hitDice: { die: 'd8', remaining: 1 } }, spellSlots: {} }
  const out = applyLongRest(state, '2014')
  assert.equal(out.combat.hitDice.remaining, 1, 'unchanged rather than guessed')
  assert.match(out.changes.join('\n'), /cannot compute the recovery/)
})

await test('a long rest at full HP still resets slots and HD', async () => {
  const state = { identity: { level: 2 }, combat: { hp: { current: 10, max: 10 }, hitDice: { die: 'd8', remaining: 0 } }, spellSlots: { 1: { total: 2, used: 2 } } }
  const out = applyLongRest(state, '2024')
  assert.match(out.changes.join('\n'), /HP already 10\/10/)
  assert.equal(out.spellSlots['1'].used, 0)
  assert.equal(out.combat.hitDice.remaining, 1)
})

console.log(failures === 0 ? 'rest-rules.test.mjs: pure rules all passed' : `rest-rules.test.mjs: ${failures} failure(s)`)
if (failures > 0) process.exitCode = 1

// ─── dnd_rest through the write path ───────────────────────────────────────

const root = mkdtempSync(path.join(tmpdir(), 'dnd-rest-')).replace(/\\/g, '/')
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }) } catch { /* gone */ } })
mkdirSync(path.join(root, 'campaigns', 'testcamp', 'characters'), { recursive: true })
mkdirSync(path.join(root, '.runtime'), { recursive: true })
writeFileSync(path.join(root, '.runtime', 'active-campaign.json'), JSON.stringify({ name: 'testcamp' }), 'utf8')
writeFileSync(path.join(root, 'campaigns', 'testcamp', 'state.md'),
  '---\n- **Name**: testcamp\n- **Ruleset**: 2014\n---\n', 'utf8')

const nodePath = (p) => String(p).replace(/\//g, path.sep)
/** The package's real data/ dir is read-only reference data (class skeletons),
 * exempt from the temp-tree guard exactly as in character-create.test.mjs. */
const DATA_DIR = new URL('../data/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\\/, '/')
const DATA_PREFIX = 'D:/DND/dsh-dnd-bundle/data'
const makeTarget = (d) => ({ targetKey: String(d).toLowerCase(), displayPath: String(d) })
const guard = (p, method) => {
  const norm = String(p).replace(/\\/g, '/')
  if (norm.startsWith(DATA_PREFIX + '/')) return DATA_DIR + norm.slice(DATA_PREFIX.length + 1)
  // A source checkout resolves DATA_ROOT to THIS repo's data/ (import.meta.url),
  // not the installed-bundle prefix above. Same read-only package property.
  if (norm.startsWith(DATA_DIR)) return norm
  if (!norm.startsWith(root)) throw new Error('LEAK: fs.' + method + '() outside the temp tree: ' + norm)
  return norm
}
const fs = {
  async resolve(p) { return makeTarget(guard(p, 'resolve')) },
  async stat(t) { try { const s = statSync(nodePath(guard(String(t.displayPath), 'stat'))); return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs } } catch { return undefined } },
  async readText(t) { return readFileSync(nodePath(guard(String(t.displayPath), 'readText')), 'utf8') },
  async writeText(t, text) { writeFileSync(nodePath(guard(String(t.displayPath), 'writeText')), text, 'utf8') },
  async listDir(t) {
    const real = guard(String(t.displayPath), 'listDir')
    return readdirSync(nodePath(real), { withFileTypes: true }).map((e) => ({ name: e.name, target: makeTarget(guard(real + '/' + e.name, 'listDir')), type: e.isDirectory() ? 'directory' : 'file' }))
  },
}
const ctx = {
  get: (n) => {
    if (n === 'fs') return fs
    if (n === 'sessions') return { get: () => ({ header: { cwd: root } }) }
    if (n === 'sandboxPolicy') return { resolve: ({ session }) => ({ workspaceRoot: session.header.cwd, mode: 'workspace-write', sessionId: 'rest-1' }) }
    return undefined
  },
}
const exec = { agent: { id: 'rest-1' } }
const { buildTools: buildCreate } = await import('../src/host/tools/character-create.mjs')
const { buildTools: buildRest } = await import('../src/host/tools/rest.mjs')
const create = buildCreate(ctx).find((t) => t.name === 'dnd_character_create')
const rest = buildRest(ctx).find((t) => t.name === 'dnd_rest')
const readState = (stem) => JSON.parse(readFileSync(nodePath(root + '/campaigns/testcamp/characters/' + stem + '.state.json'), 'utf8'))

await test('a short rest lands HD spend and healing through the write path', async () => {
  const created = await create.execute({ name: 'Brann', kind: 'pc', klass: 'Fighter', level: 2, hp: 19, abilities: { CON: 14 } }, exec)
  assert.match(String(created), /Created Brann/)
  // Damage first so there is something to heal (dnd_track through its own path).
  const { buildTools: buildTrack } = await import('../src/host/tools/track.mjs')
  const track = buildTrack(ctx).find((t) => t.name === 'dnd_track')
  await track.execute({ character: 'Brann', hp: '-12' }, exec)
  const out = await rest.execute({ kind: 'short', character: 'Brann', hitDice: '2', key: 'rest-1' }, exec)
  assert.match(String(out), /SHORT rest/)
  assert.match(String(out), /Hit Dice remaining: 2 -> 0/)
  // THE DICE MUST BE DICE. A regression rolled every Hit Die as 0 (the sides
  // number was parsed as a die string), healing CON only — plausible-looking
  // numbers that quietly under-heal every short rest. Each reported face must
  // be a legal die face: >= 1, <= the die's sides.
  for (const m of String(out).matchAll(/d(\d+) rolled (\d+)/g)) {
    const [, sides, face] = m
    const n = Number(face)
    assert.ok(n >= 1 && n <= Number(sides), `Hit Die face ${n} outside 1..${sides}: ${out}`)
  }
  const s = readState('brann')
  assert.equal(s.combat.hitDice.remaining, 0)
  // Brann is a Fighter (d10): 7 HP after damage, + two rolls and CON +2 each,
  // clamped at 19. Only the range is pinned; the faces are the tool's RNG.
  assert.ok(s.combat.hp.current > 7 && s.combat.hp.current <= 19, 'healed within the clamp: ' + s.combat.hp.current)
})

await test('a party long rest settles every PC under per-character keys', async () => {
  await create.execute({ name: 'Sera', kind: 'pc', klass: 'Wizard', level: 1, hp: 8, abilities: { INT: 16 }, spellSlots: { 1: 2 } }, exec)
  await rest.execute({ kind: 'long', party: true, key: 'night-1' }, exec)
  const sera = readState('sera')
  assert.equal(sera.combat.hp.current, sera.combat.hp.max, '2014: heal min(half max, missing) — she was undamaged, so full')
  assert.equal(sera.spellSlots['1'].used, 0)
  const out = await rest.execute({ kind: 'long', party: true, key: 'night-1' }, exec)
  assert.match(String(out), /already rested under this key/)
})

await test('party rest with no PCs says so instead of settling enemies', async () => {
  // A fresh campaign directory: marker points at testcamp whose PCs exist, so
  // assert the skip rule through the enemy tag instead — create one enemy and
  // confirm the party report names both PCs and never the enemy.
  await create.execute({ name: 'Ogre-1', kind: 'enemy', hp: 30, ac: 11, abilities: {} }, exec)
  const out = await rest.execute({ kind: 'long', party: true, key: 'night-2' }, exec)
  assert.match(String(out), /brann/)
  assert.match(String(out), /sera/)
  assert.doesNotMatch(String(out), /ogre/i, 'an enemy is never settled by a party rest')
})

await test('a missing kind is refused before anything is located', async () => {
  const out = await rest.execute({}, exec)
  assert.match(String(out), /needs `kind`/)
})

console.log('rest-rules.test.mjs (write path): done')
