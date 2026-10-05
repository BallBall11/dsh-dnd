/**
 * levelup.test.mjs — dnd_level_up (GAP plan, P2: the advancement step).
 *
 * Pure half: the plan arithmetic against table rows, with no fs at all.
 * Write half: the real tool against a temp-tree fs — plan writes NOTHING,
 * confirm writes through the shared path, XP gating and force behave, and a
 * multiclass-style classless sheet is refused rather than guessed.
 *
 * Rules: docs/harness/GAP-TOOLS-PLAN.md · src/host/tools/levelup.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { planLevelUp, classRowFor } from '../src/host/tools/levelup.mjs'

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}\n       ${error.message.split('\n')[0]}`)
  }
}

// The real dataset rows: the class table is shipped reference data. The stub
// must answer resolve/stat/readText — readTextOrUndefined's contract.
const fsmod = await import('node:fs')
const fs14 = {
  async resolve(p) { return { targetKey: String(p).toLowerCase(), displayPath: String(p) } },
  async stat(t) { try { const s = fsmod.statSync(t.displayPath); return { type: s.isDirectory() ? 'directory' : 'file' } } catch { return undefined } },
  async readText(t) { return fsmod.readFileSync(t.displayPath, 'utf8') },
}
const wizard14 = await classRowFor(fs14, '2014', 'Wizard', 5)

await test('the class table row comes from the shipped dataset', async () => {
  assert.equal(wizard14.error, undefined, JSON.stringify(wizard14))
  assert.equal(wizard14.className, 'Wizard')
  assert.equal(wizard14.hitDie, 'd6')
  assert.equal(wizard14.row.profBonus, '+3', 'level 5 row')
})

await test('the average HP gain is the die midpoint + CON, floored at 1', async () => {
  const plan = planLevelUp({ abilities: { CON: 14 } }, 5, wizard14.row, 'd6')
  assert.equal(plan.hpGain, 6, 'd6 avg 4 + CON 2')
  const frail = planLevelUp({ abilities: { CON: 6 } }, 5, wizard14.row, 'd6')
  assert.equal(frail.hpGain, 2, 'd6 avg 4 + CON -2')
  const doomed = planLevelUp({ abilities: { CON: 1 } }, 5, wizard14.row, 'd6')
  assert.equal(doomed.hpGain, 1, '4 + (-5) floors at 1')
})

await test('a rolled HP gain uses the injected die', async () => {
  const plan = planLevelUp({ abilities: { CON: 10 } }, 5, wizard14.row, 'd6', 'roll', () => 6)
  assert.equal(plan.hpGain, 6)
})

await test('the new slot totals replace the old, expended counts carry over clamped', async () => {
  const state = { abilities: { CON: 10 }, spellSlots: { 1: { total: 4, used: 3 }, 2: { total: 3, used: 3 } } }
  // Wizard level 5: 1st 4, 2nd 3, 3rd 2 — the 2nd-ring used 3 carries; the
  // NEW 3rd ring starts unused.
  const plan = planLevelUp(state, 5, wizard14.row, 'd6')
  assert.equal(plan.slots['1'].total, 4)
  assert.equal(plan.slots['1'].used, 3)
  assert.equal(plan.slots['2'].used, 3, 'expended carries over')
  assert.equal(plan.slots['3'].total, 2)
  assert.equal(plan.slots['3'].used, 0, 'a new ring starts unused')
})

await test('an ASI level is reported as the player\'s choice, never applied', async () => {
  const row4 = await classRowFor(fs14, '2014', 'Fighter', 4)
  const plan = planLevelUp({ abilities: { CON: 10 } }, 4, row4.row, 'd10')
  assert.ok(plan.notes.some((n) => n.includes('属性值提升')), plan.notes.join('; '))
})

await test('a classless sheet names the problem', async () => {
  const out = await classRowFor(fs14, '2014', null, 5)
  assert.match(out.error, /no class/)
  const bad = await classRowFor(fs14, '2014', 'Warlord', 5)
  assert.match(bad.error, /not in the 2014 dataset/)
})

console.log(failures === 0 ? 'levelup.test.mjs: pure plan all passed' : `levelup.test.mjs: ${failures} failure(s)`)
if (failures > 0) process.exitCode = 1

// ─── dnd_level_up through the write path ───────────────────────────────────

const root = mkdtempSync(path.join(tmpdir(), 'dnd-levelup-')).replace(/\\/g, '/')
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }) } catch { /* gone */ } })
mkdirSync(path.join(root, 'campaigns', 'testcamp', 'characters'), { recursive: true })
mkdirSync(path.join(root, '.runtime'), { recursive: true })
writeFileSync(path.join(root, '.runtime', 'active-campaign.json'), JSON.stringify({ name: 'testcamp' }), 'utf8')
writeFileSync(path.join(root, 'campaigns', 'testcamp', 'state.md'),
  '---\n- **Name**: testcamp\n- **Ruleset**: 2014\n---\n', 'utf8')

const nodePath = (p) => String(p).replace(/\//g, path.sep)
const DATA_DIR = new URL('../data/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\\/, '/')
const DATA_PREFIX = 'D:/DND/dsh-dnd-bundle/data'
const makeTarget = (d) => ({ targetKey: String(d).toLowerCase(), displayPath: String(d) })
const guard = (p, method) => {
  const norm = String(p).replace(/\\/g, '/')
  if (norm.startsWith(DATA_PREFIX + '/')) return DATA_DIR + norm.slice(DATA_PREFIX.length + 1)
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
    return readdirSync(nodePath(real), { withFileTypes: true }).map((e) => ({ name: e.name, target: makeTarget(guard(real + '/' + e.name), ), type: e.isDirectory() ? 'directory' : 'file' }))
  },
}
const ctx = {
  get: (n) => {
    if (n === 'fs') return fs
    if (n === 'sessions') return { get: () => ({ header: { cwd: root } }) }
    if (n === 'sandboxPolicy') return { resolve: ({ session }) => ({ workspaceRoot: session.header.cwd, mode: 'workspace-write', sessionId: 'lvl-1' }) }
    return undefined
  },
}
const exec = { agent: { id: 'lvl-1' } }
const { buildTools } = await import('../src/host/tools/levelup.mjs')
const { buildTools: buildCreate } = await import('../src/host/tools/character-create.mjs')
const levelUp = buildTools(ctx).find((t) => t.name === 'dnd_level_up')
const create = buildCreate(ctx).find((t) => t.name === 'dnd_character_create')
const readState = (stem) => JSON.parse(readFileSync(nodePath(root + '/campaigns/testcamp/characters/' + stem + '.state.json'), 'utf8'))

await test('plan-only writes NOTHING to disk', async () => {
  await create.execute({ name: 'Sera', kind: 'pc', klass: 'Wizard', level: 4, hp: 22, abilities: { CON: 14 }, spellSlots: { 1: 4, 2: 3 } }, exec)
  const before = readFileSync(nodePath(root + '/campaigns/testcamp/characters/sera.state.json'), 'utf8')
  const out = await levelUp.execute({ character: 'Sera' }, exec)
  assert.match(String(out), /未写入/)
  assert.match(String(out), /5 级/)
  assert.equal(readFileSync(nodePath(root + '/campaigns/testcamp/characters/sera.state.json'), 'utf8'), before)
})

await test('confirm without the XP threshold is refused, files unchanged', async () => {
  const before = readFileSync(nodePath(root + '/campaigns/testcamp/characters/sera.state.json'), 'utf8')
  const out = await levelUp.execute({ character: 'Sera', confirm: true }, exec)
  assert.match(String(out), /REFUSED/)
  assert.equal(readFileSync(nodePath(root + '/campaigns/testcamp/characters/sera.state.json'), 'utf8'), before)
})

await test('confirm applies the plan through the shared write path', async () => {
  const out = await levelUp.execute({ character: 'Sera', confirm: true, force: true, key: 'lvl5' }, exec)
  assert.match(String(out), /升到 5 级/)
  assert.match(String(out), /熟练加成：\+2 -> \+3/)
  const s = readState('sera')
  assert.equal(s.identity.level, 5)
  assert.equal(s.identity.xpNext, 14000, 'level 6 threshold')
  assert.equal(s.combat.hitDice.remaining, 5, 'one HD per level, from 4')
  assert.equal(s.combat.hp.max, 22 + 6, 'd6 avg 4 + CON +2')
  assert.equal(s.combat.hp.current, 22 + 6, 'current gains the same (she was at max)')
  assert.equal(s.spellSlots['3'].total, 2, 'the new ring arrives')
  assert.equal(s.spellSlots['1'].used, 0, 'no slots were expended; nothing to carry')
})

await test('the same key is a no-op, and the tool does not stack levels', async () => {
  const out = await levelUp.execute({ character: 'Sera', confirm: true, force: true, key: 'lvl5' }, exec)
  assert.match(String(out), /Already applied/)
  assert.equal(readState('sera').identity.level, 5)
})

await test('XP gating releases once dnd_xp_add has done its job', async () => {
  const { buildTools: buildTrack } = await import('../src/host/tools/track.mjs')
  const xpAdd = buildTrack(ctx).find((t) => t.name === 'dnd_xp_add')
  await xpAdd.execute({ character: 'Sera', amount: '14500' }, exec)
  const out = await levelUp.execute({ character: 'Sera', confirm: true }, exec)
  assert.match(String(out), /升到 6 级/)
  assert.equal(readState('sera').identity.level, 6)
})

await test('a classless sheet is refused, not guessed', async () => {
  await create.execute({ name: 'Mystery', kind: 'pc', level: 2, hp: 9, abilities: {} }, exec)
  const out = await levelUp.execute({ character: 'Mystery', confirm: true }, exec)
  assert.match(String(out), /no class/)
  assert.equal(readState('mystery').identity.level, 2)
})

console.log('levelup.test.mjs (write path): done')
