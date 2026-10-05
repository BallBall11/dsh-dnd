/**
 * enemy-create.test.mjs — dnd_enemy_create (GAP plan, project 4).
 *
 * The SRD datasets are read for real: they are the shipped reference data, so
 * asserting against goblin-warrior pins the actual artifact instead of a copy
 * (same policy as host.test.mjs's lookup tests). Everything WRITTEN goes
 * through a temp-tree fs shim whose session cwd IS the root.
 *
 * Rules: docs/harness/GAP-TOOLS-PLAN.md · src/host/tools/enemy-create.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

const root = mkdtempSync(path.join(tmpdir(), 'dnd-enemy-')).replace(/\\/g, '/')
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }) } catch { /* gone */ } })
mkdirSync(path.join(root, 'campaigns', 'testcamp', 'characters'), { recursive: true })
mkdirSync(path.join(root, '.runtime'), { recursive: true })
writeFileSync(path.join(root, '.runtime', 'active-campaign.json'), JSON.stringify({ name: 'testcamp' }), 'utf8')
writeFileSync(path.join(root, 'campaigns', 'testcamp', 'state.md'),
  '---\n- **Name**: testcamp\n- **Ruleset**: 2024\n---\n', 'utf8')

const nodePath = (p) => String(p).replace(/\//g, path.sep)
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data').replace(/\\/g, '/')
const DATA_PREFIX = 'D:/DND/dsh-dnd-bundle/data'
const makeTarget = (d) => ({ targetKey: String(d).toLowerCase(), displayPath: String(d) })
const guard = (p, method) => {
  const norm = String(p).replace(/\\/g, '/')
  if (norm.startsWith(DATA_PREFIX + '/')) return norm.replace(DATA_PREFIX, DATA_DIR)
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
    if (n === 'sandboxPolicy') return { resolve: ({ session }) => ({ workspaceRoot: session.header.cwd, mode: 'workspace-write', sessionId: 'enemy-1' }) }
    return undefined
  },
}
const exec = { agent: { id: 'enemy-1' } }
const { buildTools } = await import('../src/host/tools/enemy-create.mjs')
const tool = buildTools(ctx).find((t) => t.name === 'dnd_enemy_create')
const readState = (stem) => JSON.parse(readFileSync(nodePath(root + '/campaigns/testcamp/characters/' + stem + '.state.json'), 'utf8'))

await test('an SRD statblock becomes a full enemy card in one call', async () => {
  const out = await tool.execute({ fromSrd: 'goblin-warrior' }, exec)
  assert.match(String(out), /Goblin Warrior/, 'the SRD name, not the raw query')
  const s = readState('goblin-warrior')
  assert.equal(s.combat.ac, 15, 'SRD 2024 goblin AC')
  assert.equal(s.combat.hp.max, 10, 'SRD 2024 goblin average HP')
  assert.equal(s.abilities.DEX, 15, 'statblock scores land as scores')
  assert.equal(s.combat.hitDice.die, 'd6', 'die from hp_dice 3d6')
  assert.equal(s.combat.hitDice.remaining, 3, 'one HD per die, not one per creature')
  assert.equal(s.currency, 0)
})

await test('the attack prose lands verbatim in the narrative, CR first', async () => {
  const md = readFileSync(nodePath(root + '/campaigns/testcamp/characters/goblin-warrior.md'), 'utf8')
  assert.match(md, /CR 1\/4 \(50 XP\)/, 'the threat rating leads the narrative')
  assert.match(md, /Scimitar/, 'the statblock attack text survives verbatim')
})

await test('count creates independently named cards', async () => {
  const out = await tool.execute({ fromSrd: 'goblin-warrior', count: 3 }, exec)
  assert.match(String(out), /Goblin Warrior-1/)
  assert.match(String(out), /Goblin Warrior-3/)
  for (const stem of ['goblin-warrior-1', 'goblin-warrior-2', 'goblin-warrior-3']) {
    const s = readState(stem)
    assert.equal(s.combat.hp.max, 10)
  }
})

await test('a duplicate name is refused loudly, not doubled', async () => {
  const out = await tool.execute({ fromSrd: 'goblin-warrior' }, exec)
  assert.match(String(out), /already exists/, String(out))
})

await test('hpOverride replaces the SRD average (number or roll)', async () => {
  const out = await tool.execute({ fromSrd: 'hobgoblin-warrior', namePrefix: 'Legion', hpOverride: '2d8+2' }, exec)
  assert.match(String(out), /Created 1 x Hobgoblin Warrior/)
  const s = readState('legion')
  assert.ok(s.combat.hp.max >= 4 && s.combat.hp.max <= 18, 'a rolled 2d8+2: ' + s.combat.hp.max)
  assert.equal(s.combat.hp.current, s.combat.hp.max)
})

await test('an unknown monster names the closest candidates and writes nothing', async () => {
  const before = new Set(readdirSync(nodePath(root + '/campaigns/testcamp/characters')))
  const out = await tool.execute({ fromSrd: 'gobln' }, exec)
  assert.match(String(out), /No SRD monster matches/)
  assert.match(String(out), /Goblin/, 'the miss names what IS available')
  const after = new Set(readdirSync(nodePath(root + '/campaigns/testcamp/characters')))
  assert.deepEqual([...after].filter((f) => !before.has(f)), [], 'a refused lookup writes no files')
})

await test('a party of enemies is never disturbed by a party rest', async () => {
  // Wiring check on the shared model: enemy tags exclude them from the rest
  // tool's PC filter (covered there) AND confirm the cards carry the tag.
  const md = readFileSync(nodePath(root + '/campaigns/testcamp/characters/goblin-warrior-1.md'), 'utf8')
  assert.match(md, /tags: \[.*enemy/, 'kind: enemy is the frontmatter tag')
})

await test('missing fromSrd and bad count are refused before any lookup', async () => {
  assert.match(String(await tool.execute({}, exec)), /needs `fromSrd`/)
  assert.match(String(await tool.execute({ fromSrd: 'goblin-warrior', count: 0 }, exec)), /count.*1-20/)
  assert.match(String(await tool.execute({ fromSrd: 'goblin-warrior', count: 99 }, exec)), /count.*1-20/)
})

console.log(failures === 0 ? 'enemy-create.test.mjs: all passed' : `enemy-create.test.mjs: ${failures} failure(s)`)
if (failures > 0) process.exit(1)
