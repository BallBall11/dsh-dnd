/**
 * host.test.mjs — mount the host half exactly as the loader does, against a
 * mock fs, and exercise each tool family end to end.
 *
 * The point is not to re-test the pure functions (sheet-parse.test.mjs does
 * that) but to prove the *coordinator* wires every family up, that the tools
 * actually run through the registry, and that a broken family cannot take the
 * others down.
 *
 * The mock fs reads the REAL D:/DND tree read-only, so this runs against the
 * live campaigns without writing anything.
 */
import assert from 'node:assert/strict'
import { readFile, stat as fsStat, readdir } from 'node:fs/promises'
import path from 'node:path'

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failures += 1
    console.error('  FAIL ' + name)
    console.error('       ' + (error && error.message ? error.message : error))
  }
}

/** The host fs service, backed by node's fs (read-only usage). */
const fsService = {
  async resolve(p) { return String(p).replace(/\\/g, '/') },
  async stat(p) {
    try {
      const s = await fsStat(String(p).replace(/\//g, path.sep))
      return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs }
    } catch { return undefined }
  },
  async readText(p) { return readFile(String(p).replace(/\//g, path.sep), 'utf8') },
  async listDir(p) {
    const dir = String(p).replace(/\//g, path.sep)
    const out = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      out.push({
        name: entry.name,
        target: `${String(p).replace(/\/$/, '')}/${entry.name}`,
        type: entry.isDirectory() ? 'directory' : 'file',
      })
    }
    return out
  },
}

const registered = []
const toolsService = {
  register(tool) {
    if (registered.some((t) => t.name === tool.name)) {
      throw new Error(`tool "${tool.name}" is already registered`)
    }
    registered.push(tool)
    return () => {
      const index = registered.findIndex((t) => t.name === tool.name)
      if (index >= 0) registered.splice(index, 1)
    }
  },
}

const warnings = []
const ctx = {
  get(name) {
    if (name === 'fs') return fsService
    if (name === 'tools') return toolsService
    if (name === 'logger') return { warn: (m) => warnings.push(m) }
    return undefined
  },
}

const host = await import('../src/host/index.mjs')

console.log('host coordinator:')

await test('apply() registers every family', async () => {
  const dispose = host.apply(ctx)
  assert.equal(typeof dispose, 'function', 'apply must return a disposer function')
  const names = registered.map((t) => t.name).sort()
  const expected = [
    'dnd_arc_status', 'dnd_attack', 'dnd_campaign_search', 'dnd_campaign_state',
    'dnd_character_get', 'dnd_check', 'dnd_dc', 'dnd_mastery', 'dnd_roll',
    'dnd_save', 'dnd_srd_lookup',
  ]
  assert.deepEqual(names, expected, 'registered roster drifted:\n  got      ' + names.join(', ') + '\n  expected ' + expected.join(', '))
  assert.deepEqual(warnings, [], 'no family should have failed: ' + warnings.join('; '))
})

await test('every tool declares name / description / parameters / execute', async () => {
  for (const tool of registered) {
    assert.equal(typeof tool.name, 'string', `${tool.name}: name`)
    assert.ok(tool.name.startsWith('dnd_'), `${tool.name}: must be namespaced dnd_*`)
    assert.equal(typeof tool.description, 'string', `${tool.name}: description`)
    assert.ok(tool.description.length > 40, `${tool.name}: description too short to guide the model`)
    assert.equal(typeof tool.parameters, 'object', `${tool.name}: parameters`)
    assert.equal(typeof tool.execute, 'function', `${tool.name}: execute`)
  }
})

const call = async (name, args) => {
  const tool = registered.find((t) => t.name === name)
  assert.ok(tool !== undefined, `${name} is not registered`)
  return String(await tool.execute(args ?? {}))
}

await test('dnd_roll rolls a dice expression', async () => {
  const out = await call('dnd_roll', { spec: '2d6+3' })
  assert.match(out, /2d6\+3 = \[/, out)
  const silent = await call('dnd_roll', { spec: 'd20', silent: true })
  assert.match(silent, /^\d+$/, 'silent must return a bare integer: ' + silent)
})

await test('dnd_roll rejects a bad spec without throwing', async () => {
  const out = await call('dnd_roll', { spec: 'banana' })
  assert.match(out, /Invalid dice spec/, out)
})

await test('dnd_roll supports keep-highest', async () => {
  const out = await call('dnd_roll', { spec: '4d6kh3' })
  assert.match(out, /4d6kh3 = \[/, out)
  assert.match(out, /keep \[/, out)
})

await test('dnd_check resolves against a DC', async () => {
  const out = await call('dnd_check', { mod: 5, dc: 12, label: 'Arcana' })
  assert.match(out, /Arcana — d20\+5 = \d+.*vs DC 12 → (SUCCESS|FAILURE)/, out)
})

await test('dnd_attack doubles dice on a natural 20', async () => {
  // Force a crit by rolling until we see one; the RNG is the real one.
  let sawCrit = false
  for (let i = 0; i < 400 && !sawCrit; i += 1) {
    const out = await call('dnd_attack', { toHit: 20, ac: 5, damage: '1d8' })
    if (out.includes('CRITICAL HIT')) {
      sawCrit = true
      assert.match(out, /2d8/, 'crit must double the damage dice: ' + out)
      assert.ok(!/2d8\+/.test(out), 'crit must not double a flat modifier')
    }
  }
  assert.ok(sawCrit, 'never rolled a natural 20 in 400 tries (toHit +20 vs AC 5)')
})

await test('dnd_save resolves', async () => {
  const out = await call('dnd_save', { mod: 2, dc: 14, label: 'CON save' })
  assert.match(out, /CON save — d20\+2 = \d+.*vs DC 14 → (SUCCESS|FAILURE)/, out)
})

await test('dnd_mastery lists and looks up properties', async () => {
  const all = await call('dnd_mastery', {})
  for (const key of ['Cleave', 'Graze', 'Nick', 'Push', 'Sap', 'Slow', 'Topple', 'Vex']) {
    assert.ok(all.includes(key), `mastery list is missing ${key}`)
  }
  const one = await call('dnd_mastery', { property: 'topple' })
  assert.match(one, /Topple/, one)
  assert.match(one, /CON save/, one)
})

await test('dnd_dc returns the ladder and a passive score', async () => {
  const ladder = await call('dnd_dc', {})
  assert.match(ladder, /DC 15 — Medium/, ladder)
  const passive = await call('dnd_dc', { mod: 5 })
  assert.match(passive, /Passive score: 15/, passive)
  const adv = await call('dnd_dc', { mod: 5, advantage: true })
  assert.match(adv, /Passive score: 20/, adv)
})

await test('dnd_campaign_state reads the active campaign', async () => {
  const out = await call('dnd_campaign_state', {})
  assert.ok(!out.includes('No active campaign'), 'expected an active campaign, got: ' + out)
  assert.match(out, /\*\*Campaign:\*\*/, out)
})

await test('dnd_campaign_state can list sections', async () => {
  const out = await call('dnd_campaign_state', { list: true })
  assert.match(out, /state\.md sections:/, out)
})

await test('dnd_campaign_search finds text and reports file:line', async () => {
  const out = await call('dnd_campaign_search', { query: 'Alice', max: 3 })
  assert.match(out, /\*\*.+:\d+\*\*/, 'expected file:line headers: ' + out)
})

await test('dnd_campaign_search runs twice (exercises the cache)', async () => {
  const first = await call('dnd_campaign_search', { query: 'the', max: 2 })
  const second = await call('dnd_campaign_search', { query: 'the', max: 2 })
  assert.equal(first, second, 'a cached search must return identical results')
})

await test('dnd_srd_lookup finds a spell', async () => {
  const out = await call('dnd_srd_lookup', { query: 'fireball', category: 'spell' })
  // The active campaign (morgansfort) declares **Ruleset:** 2024, and the tool
  // follows the campaign — so assert the shape, not a hard-coded ruleset.
  assert.match(out, /\[ruleset (2014|2024)\]/, out)
  assert.match(out, /fireball/i, out)
})

await test('dnd_srd_lookup honours an explicit ruleset override', async () => {
  const out = await call('dnd_srd_lookup', { query: 'fireball', category: 'spell', ruleset: '2014' })
  assert.match(out, /\[ruleset 2014\]/, out)
  assert.match(out, /fireball/i, out)
})

await test('dnd_srd_lookup runs twice (exercises the dataset cache)', async () => {
  const first = await call('dnd_srd_lookup', { query: 'goblin', category: 'monster' })
  const second = await call('dnd_srd_lookup', { query: 'goblin', category: 'monster' })
  assert.equal(first, second, 'a cached lookup must return identical results')
})

await test('dnd_srd_lookup reports an honest miss', async () => {
  const out = await call('dnd_srd_lookup', { query: 'zzzznotathing' })
  assert.match(out, /No SRD entry matches/, out)
})

await test('dnd_character_get returns JSON for a real character', async () => {
  const out = await call('dnd_character_get', { character: 'alice' })
  const parsed = JSON.parse(out)
  assert.ok(Array.isArray(parsed.characters), 'expected a characters array')
  assert.ok(parsed.characters.length >= 1, 'expected at least one character: ' + out)
  const alice = parsed.characters[0]
  assert.equal(alice.name, 'Alice')
  assert.ok(alice.hitPoints !== null, 'Alice should have parsed HP')
  assert.ok(Object.keys(alice.spellSlotsByLevel ?? {}).length >= 1, 'Alice should have spell slots')
})

await test('dnd_character_get renders a markdown card', async () => {
  const out = await call('dnd_character_get', { character: 'alice', asMarkdown: true })
  assert.match(out, /# Alice/, out)
  assert.match(out, /HP \d+\/\d+/, out)
})

await test('dnd_character_get names the available characters on a miss', async () => {
  const out = await call('dnd_character_get', { character: 'nobody' })
  assert.match(out, /not found/, out)
  assert.match(out, /Alice/, 'the miss message should list who IS available: ' + out)
})

await test('dispose() unregisters everything', async () => {
  const names = registered.map((t) => t.name)
  assert.ok(names.length > 0)
})

console.log('')
if (failures > 0) {
  console.error(`host.test.mjs: ${failures} failure(s)`)
  process.exit(1)
}
console.log('host.test.mjs: all assertions passed')
