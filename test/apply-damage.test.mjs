/**
 * apply-damage.test.mjs — the damage-landing rules (GAP plan, project 3).
 *
 * Pure-function suite: every rule here is a property of the computation, so
 * nothing touches the filesystem or a campaign fixture. The dnd_track path is
 * exercised at the applyTrackChanges boundary, which is also pure.
 *
 * Rules: docs/harness/GAP-TOOLS-PLAN.md · src/host/tools/apply-damage.mjs
 */
import assert from 'node:assert/strict'
import { applyDamage, isEnemyTag } from '../src/host/tools/apply-damage.mjs'
import { applyTrackChanges } from '../src/host/tools/track.mjs'

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

await test('damage reduces hp.current directly when there is no temp HP', async () => {
  const out = applyDamage({ hp: { current: 10, max: 20 } }, 4)
  assert.equal(out.combat.hp.current, 6)
  assert.equal(out.combat.tempHp, 0)
  assert.equal(out.applied, 4)
  assert.equal(out.absorbed, 0)
  assert.equal(out.dead, false)
})

await test('temporary HP absorbs first; the remainder reaches hp.current', async () => {
  const out = applyDamage({ hp: { current: 10, max: 20 }, tempHp: 5 }, 8)
  assert.equal(out.absorbed, 5)
  assert.equal(out.combat.tempHp, 0)
  assert.equal(out.combat.hp.current, 7)
  assert.match(out.note, /temp HP absorbed 5 \(5 -> 0\)/)
})

await test('damage fully absorbed by temp HP never touches hp.current', async () => {
  const out = applyDamage({ hp: { current: 10, max: 20 }, tempHp: 9 }, 8)
  assert.equal(out.absorbed, 8)
  assert.equal(out.combat.tempHp, 1)
  assert.equal(out.combat.hp.current, 10)
  assert.equal(out.dead, false)
})

await test('damage clamps at 0 and reports the overflow', async () => {
  const out = applyDamage({ hp: { current: 3, max: 12 } }, 8)
  assert.equal(out.combat.hp.current, 0)
  assert.equal(out.applied, 3)
  assert.equal(out.overflow, 5)
  assert.equal(out.dead, true, 'landing ON 0 from a positive pool is the dying/dead signal')
})

await test('0 damage on an already-down character is not a fresh defeat', async () => {
  const out = applyDamage({ hp: { current: 0, max: 12 } }, 0)
  assert.equal(out.dead, false)
  assert.equal(out.combat.hp.current, 0)
})

await test('resistance halves the raw amount before temp HP absorbs', async () => {
  const out = applyDamage({ hp: { current: 10, max: 20 }, tempHp: 3 }, 7, { type: 'fire', resistance: 'fire' })
  assert.equal(out.combat.hp.current, 10 - 0, '7 halved to 3, all of it absorbed by temp HP')
  assert.equal(out.combat.tempHp, 0)
  assert.match(out.note, /resistance to fire: 7 halved to 3/)
})

await test('vulnerability doubles the raw amount', async () => {
  const out = applyDamage({ hp: { current: 10, max: 20 } }, 3, { type: 'radiant', vulnerability: 'Radiant' })
  assert.equal(out.combat.hp.current, 4)
  assert.match(out.note, /vulnerability to radiant: doubled to 6/)
})

await test('resistance and vulnerability of the same type are refused, not guessed', async () => {
  const out = applyDamage({ hp: { current: 10, max: 20 } }, 5, { type: 'fire', resistance: 'fire', vulnerability: 'FIRE' })
  assert.match(out.error, /both resisted and vulnerable/)
})

await test('resistance of a DIFFERENT type than the damage does nothing', async () => {
  const out = applyDamage({ hp: { current: 10, max: 20 } }, 5, { type: 'fire', resistance: 'cold' })
  assert.equal(out.combat.hp.current, 5)
  assert.equal(out.note, 'HP 10 -> 5')
})

await test('a negative or non-numeric amount is an argument error', async () => {
  assert.match(applyDamage({ hp: { current: 5 } }, -1).error, />= 0/)
  assert.match(applyDamage({ hp: { current: 5 } }, 'lots').error, />= 0/)
})

await test('isEnemyTag reads the kind-first frontmatter tags', async () => {
  assert.equal(isEnemyTag(['enemy']), true)
  assert.equal(isEnemyTag(['pc']), false)
  assert.equal(isEnemyTag(['npc']), false)
  assert.equal(isEnemyTag(undefined), false)
})

await test('dnd_track hp damage consumes temp HP before the real pool', async () => {
  const state = { combat: { hp: { current: 10, max: 20 }, tempHp: 4 } }
  const changes = []
  const refused = applyTrackChanges(state, { hp: '-7' }, changes)
  assert.equal(refused, undefined)
  assert.equal(state.combat.tempHp, 0)
  assert.equal(state.combat.hp.current, 7)
  assert.match(changes[0], /temp HP absorbed 4/)
  assert.match(changes[0], /HP 10 -> 7/)
})

await test('dnd_track healing does not route through the damage path', async () => {
  const state = { combat: { hp: { current: 5, max: 20 }, tempHp: 3 } }
  const changes = []
  applyTrackChanges(state, { hp: '+5' }, changes)
  assert.equal(state.combat.hp.current, 10)
  assert.equal(state.combat.tempHp, 3, 'healing leaves temp HP alone')
})

await test('dnd_track set-mode below the floor is refused, not silently clamped', async () => {
  const state = { combat: { hp: { current: 5, max: 20 } } }
  const changes = []
  const refused = applyTrackChanges(state, { hp: '=-3' }, changes)
  assert.match(refused.refuse, /below the floor/)
  assert.equal(state.combat.hp.current, 5)
})

console.log(failures === 0 ? 'apply-damage.test.mjs: pure rules all passed' : `apply-damage.test.mjs: ${failures} failure(s)`)
if (failures > 0) process.exitCode = 1

// ─── the dnd_attack target mode: the write path, end to end ────────────────
//
// The fs shim maps the tool's paths into a temp tree; the session cwd IS the
// temp root, the production rule with no remap. Pattern: character-create.test.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildTools as buildRoll } from '../src/host/tools/roll.mjs'
import { buildTools as buildCreate } from '../src/host/tools/character-create.mjs'

const root2 = mkdtempSync(path.join(tmpdir(), 'dnd-apply-')).replace(/\\/g, '/')
process.on('exit', () => { try { rmSync(root2, { recursive: true, force: true }) } catch { /* gone */ } })
mkdirSync(path.join(root2, 'campaigns', 'testcamp', 'characters'), { recursive: true })
mkdirSync(path.join(root2, '.runtime'), { recursive: true })
writeFileSync(path.join(root2, '.runtime', 'active-campaign.json'), JSON.stringify({ name: 'testcamp' }), 'utf8')

const nodePath2 = (p) => String(p).replace(/\//g, path.sep)
const makeTarget2 = (displayPath) => ({ targetKey: String(displayPath).toLowerCase(), displayPath: String(displayPath) })
const guard2 = (p, method) => {
  const norm = String(p).replace(/\\/g, '/')
  if (!norm.startsWith(root2)) throw new Error('LEAK: fs.' + method + '() outside the temp tree: ' + norm)
  return norm
}
const fs2 = {
  async resolve(p) { return makeTarget2(guard2(p, 'resolve')) },
  async stat(t) {
    try { const s = statSync2(nodePath2(guard2(String(t.displayPath), 'stat'))); return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs } } catch { return undefined }
  },
  async readText(t) { return readFileSync(nodePath2(guard2(String(t.displayPath), 'readText')), 'utf8') },
  async writeText(t, text) { writeFileSync(nodePath2(guard2(String(t.displayPath), 'writeText')), text, 'utf8') },
  async listDir(t) {
    const real = guard2(String(t.displayPath), 'listDir')
    return readdirSync2(nodePath2(real)).map((e) => ({ name: e, target: makeTarget2(real + '/' + e), type: 'file' }))
  },
}
import { statSync as statSync2, readdirSync as readdirSync2 } from 'node:fs'

const ctx2 = {
  get: (n) => {
    if (n === 'fs') return fs2
    if (n === 'sessions') return { get: () => ({ header: { cwd: root2 } }) }
    if (n === 'sandboxPolicy') return { resolve: ({ session }) => ({ workspaceRoot: session.header.cwd, mode: 'workspace-write', sessionId: 'apply-1' }) }
    return undefined
  },
}
const exec2 = { agent: { id: 'apply-1' } }
const attackTool = buildRoll(ctx2).find((t) => t.name === 'dnd_attack')
const createTool = buildCreate(ctx2).find((t) => t.name === 'dnd_character_create')
const charactersDir2 = root2 + '/campaigns/testcamp/characters'
const readState = async (stem) => JSON.parse(readFileSync(nodePath2(charactersDir2 + '/' + stem + '.state.json'), 'utf8'))

await test('an enemy card can be created through the shared write path', async () => {
  const out = await createTool.execute({ name: 'Goblin-1', kind: 'enemy', hp: 7, ac: 15, abilities: { STR: 8, DEX: 14, CON: 10 } }, exec2)
  assert.match(String(out), /Created Goblin-1/)
})

await test('a hit with a target lands the damage and marks a downed enemy dead', async () => {
  // "999" is all constants: a deterministic total that must kill a 7-HP enemy.
  const out = await attackTool.execute({
    toHit: 20, ac: 5, damage: '999', target: 'Goblin-1', label: 'Boulder',
  }, exec2)
  assert.match(String(out), /HIT/)
  // The report names the resolved stem, not the request spelling.
  assert.match(String(out), /Applied to goblin-1/)
  assert.match(String(out), /DEFEATED/)
  const s = await readState('goblin-1')
  assert.equal(s.combat.hp.current, 0)
  assert.ok(s.conditions.includes('dead'), 'enemy at 0 HP must be marked dead: ' + JSON.stringify(s.conditions))
})

await test('a miss with a target writes nothing', async () => {
  const out = await attackTool.execute({ toHit: -100, ac: 25, damage: '999', target: 'Goblin-1' }, exec2)
  assert.match(String(out), /MISS/)
  const s = await readState('goblin-1')
  assert.equal(s.combat.hp.current, 0, 'a miss must not change HP again')
})

await test('the same idempotency key does not land the damage twice', async () => {
  // A natural 1 always misses and records nothing (no write, no key), so the
  // first call loops until a genuine hit applies under the key.
  let applied = null
  for (let i = 0; i < 200 && applied === null; i += 1) {
    const out = await attackTool.execute({ toHit: 20, ac: 5, damage: '2', target: 'Goblin-1', key: 'hit-1' }, exec2)
    if (/Applied to/.test(String(out))) applied = String(out)
  }
  assert.ok(applied !== null, 'never landed in 200 tries (toHit +20 vs AC 5)')
  const second = await attackTool.execute({
    toHit: 20, ac: 5, damage: '2', target: 'Goblin-1', key: 'hit-1',
  }, exec2)
  assert.match(String(second), /Already applied/, 'second call with the same key must be a no-op:\n' + applied + '\n---\n' + String(second))
  const s = await readState('goblin-1')
  assert.equal(s.combat.hp.current, 0)
})

await test('temp HP absorbs before the real pool through the target mode', async () => {
  await createTool.execute({ name: 'Hobgoblin-1', kind: 'enemy', hp: 20, ac: 10, abilities: {} }, exec2)
  // Give it temp HP through the track tool's own write path.
  const trackTool = (await import('../src/host/tools/track.mjs')).buildTools(ctx2).find((t) => t.name === 'dnd_track')
  const trackOut = await trackTool.execute({ character: 'Hobgoblin-1', tempHp: '+5' }, exec2)
  const attackOut = await attackTool.execute({ toHit: 20, ac: 5, damage: '8', target: 'Hobgoblin-1' }, exec2)
  const s = await readState('hobgoblin-1')
  assert.match(String(trackOut), /Temp HP/, 'track must set temp HP first:\n' + String(trackOut))
  assert.match(String(attackOut), /temp HP absorbed 5/, 'attack must route through applyDamage:\n' + String(attackOut))
  assert.equal(s.combat.tempHp, 0, '8 damage: 5 absorbed by temp HP')
  assert.equal(s.combat.hp.current, 17, 'the remaining 3 reach the real pool')
})

await test('a resistance halves the damage before landing', async () => {
  await createTool.execute({ name: 'Fiend-1', kind: 'enemy', hp: 20, ac: 10, abilities: {} }, exec2)
  await attackTool.execute({ toHit: 20, ac: 5, damage: '9', target: 'Fiend-1', damageType: 'fire', resistance: 'fire' }, exec2)
  const s = await readState('fiend-1')
  assert.equal(s.combat.hp.current, 20 - 4, '9 halved to 4 (floor)')
})

console.log('apply-damage.test.mjs (write path): done')
