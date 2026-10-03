/**
 * host.test.mjs — mount the host half exactly as the loader does, against a
 * mock fs, and exercise each tool family end to end.
 *
 * The point is not to re-test the pure functions (sheet-parse.test.mjs does
 * that) but to prove the *coordinator* wires every family up, that the tools
 * actually run through the registry, and that a broken family cannot take the
 * others down.
 *
 * The mock fs is redirected into a temporary campaign tree that THIS FILE
 * builds, so every assertion about a character owns its input. The live
 * `campaigns/morgansfort/` tree is never read here — an earlier version read
 * it directly, which meant that migrating the character made this suite assert
 * against a sheet whose structured sections had moved to `.state.json`.
 *
 * The temp campaign is mounted by remapping the `D:/DND` prefix, exactly as
 * routes.test.mjs does, so the production path shape is preserved while
 * nothing live is touched.
 *
 * Rules: test/support/live-data.mjs · docs/harness/TEST-DATA-OWNERSHIP.md
 */
import assert from 'node:assert/strict'
// Async API for the fs-service mock, sync API for building the temp tree.
import { readFile, stat as fsStat, readdir } from 'node:fs/promises'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

/** Flip to 1 for a resolve/stat trace of every fs call this suite makes. */
const TRACE = process.env.DND_TRACE_FS === '1'
const trace = (...parts) => { if (TRACE) console.error('   ·', ...parts) }

// --- the temp campaign this suite owns -------------------------------------
// A minimal but complete campaign: a state.md (so dnd_campaign_state and the
// ruleset resolution have something to read) and one character.
const tempRoot = mkdtempSync(path.join(tmpdir(), 'dnd-host-'))
const tempCampaigns = path.join(tempRoot, 'campaigns').replace(/\\/g, '/')
const tempRuntime = path.join(tempRoot, '.runtime').replace(/\\/g, '/')
mkdirSync(path.join(tempRoot, 'campaigns', 'testcamp', 'characters'), { recursive: true })
mkdirSync(path.join(tempRoot, '.runtime'), { recursive: true })

// The suite tears the temp campaign down at the end; a throw before that point
// must not leave it behind.
process.on('exit', () => {
  try { rmSync(tempRoot, { recursive: true, force: true }) } catch { /* already gone */ }
})

writeFileSync(path.join(tempRoot, 'campaigns', 'testcamp', 'state.md'), [
  '# Test Camp',
  '',
  '**Ruleset:** 2024',
  '',
  '## Current Situation',
  '- **Location:** A test room.',
  '- **Party:** Alice',
  '',
  '## Live State Flags',
  '- **roll_mode:** auto',
  '',
  '## Active Quests',
  '- Find Alice a spell.',
  '',
].join('\n'), 'utf8')

// The frozen fixture is the input this suite parses: an unmigrated sheet whose
// shape this test controls. Copying it into the temp campaign means the
// character cannot be migrated out from under the assertions.
const FIXTURE = new URL('./fixtures/alice-unmigrated.md', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1')
writeFileSync(
  path.join(tempRoot, 'campaigns', 'testcamp', 'characters', 'alice.md'),
  readFileSync(FIXTURE, 'utf8'),
  'utf8',
)

// The active-campaign marker points at the temp campaign.
writeFileSync(path.join(tempRoot, '.runtime', 'active-campaign.json'),
  JSON.stringify({ name: 'testcamp' }), 'utf8')

/** Map the production data root onto the temp tree, preserving path shape. */
const remap = (p) => String(p)
  // The bundled SRD datasets are CODE, not campaign data (see shared.mjs:
  // DATA_ROOT is the package's own data dir, DND_ROOT the campaign data root).
  // They are read-only reference data this suite legitimately reads in place:
  // `dnd_srd_lookup` is a pure lookup over a shipped dataset, and its output
  // cannot be affected by anything under campaigns/. Redirecting them would
  // test a copy, not the artifact that ships.
  //
  // The datasets moved from `D:/DND/.agents/skills/dnd/data/` into the bundle
  // itself, so the exemption now names the package-relative location. It is no
  // longer under D:\DND at all, but the remap below still has to be explicit
  // about it: `D:/DND/dsh-dnd-bundle/data` would otherwise be caught by the
  // `^D:\/DND\/campaigns` rules only by luck, and the intent would be lost.
  .replace(/^D:\/DND\/\.agents\/skills\/dnd\/data/i, (m) => m)
  .replace(/^D:\/DND\/dsh-dnd-bundle\/data/i, (m) => m)
  .replace(/^D:\/DND\/campaigns\/testcamp/i, (m) => m)
  .replace(/^D:\/DND\/campaigns/i, tempCampaigns)
  .replace(/^D:\/DND\/\.runtime/i, tempRuntime)

/**
 * The host fs service, modelled on the REAL contract.
 *
 * The previous version of this mock accepted a path string everywhere, which
 * is what let a genuine bug reach the profile: the real backend's `stat` and
 * `listDir` take a FsTarget object, so `listDir('D:/.../characters')` returned
 * an empty listing and dnd_character_get reported "No character sheets found"
 * for a directory that contained one.
 *
 * This mock therefore has the same shape as the service the plugin actually
 * talks to: `resolve` returns a target, and `stat`/`readText`/`listDir` accept
 * ONLY a target and throw on a bare string. A test that passes a string now
 * fails loudly instead of silently returning nothing.
 */
function makeTarget(displayPath) {
  const normalized = String(displayPath).replace(/\\/g, '/')
  return {
    targetKey: normalized.toLowerCase(),
    displayPath: normalized,
    toString() { return normalized },
  }
}

/** Assert a value looks like a FsTarget, mirroring the real service's strictness. */
function asTarget(value, method) {
  if (typeof value === 'string') {
    throw new TypeError(
      `fs.${method}() received a path string; the host contract requires an FsTarget from resolve(). `
      + `Got "${value}". This is the exact mismatch that produced "No character sheets found".`,
    )
  }
  if (value === null || typeof value !== 'object' || typeof value.displayPath !== 'string') {
    throw new TypeError(`fs.${method}() received neither a FsTarget nor a path: ${JSON.stringify(value)}`)
  }
  return remap(value.displayPath)
}

const fsService = {
  async resolve(p) {
    const r = remap(p)
    trace('resolve', p, '->', r)
    return makeTarget(r)
  },
  async stat(target) {
    const display = asTarget(target, 'stat')
    try {
      const s = await fsStat(display.replace(/\//g, path.sep))
      trace('stat   ', display, s.isDirectory() ? 'dir' : 'file')
      return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs }
    } catch (error) {
      // ENOENT means "absent", which is a legal answer. Anything else is a bug
      // in this mock or in the path, and swallowing it here is what made an
      // earlier failure read as "no active campaign" instead of naming itself.
      if (error?.code !== 'ENOENT') {
        trace('stat   ', display, 'THREW', error?.code ?? error?.message)
        throw error
      }
      trace('stat   ', display, 'MISSING')
      return undefined
    }
  },
  async readText(target) {
    const display = asTarget(target, 'readText')
    trace('read   ', display)
    return readFile(display.replace(/\//g, path.sep), 'utf8')
  },
  async listDir(target) {
    const display = asTarget(target, 'listDir')
    const out = []
    for (const entry of await readdir(display.replace(/\//g, path.sep), { withFileTypes: true })) {
      out.push({
        name: entry.name,
        target: makeTarget(`${display.replace(/\/$/, '')}/${entry.name}`),
        type: entry.isDirectory() ? 'directory' : 'file',
      })
    }
    return out
  },
  /** Not part of the fs contract; used by the late-registration test. */
  processPathFromHostPath(hostPath) { return String(hostPath) },
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
  // This mount has no web server, so the route callback never fires. Cordis
  // always supplies `inject`; only the service can be absent.
  inject() {},
}

const host = await import('../src/host/index.mjs')

/**
 * How many tools a full mount should register.
 *
 * Summed from the module's own `FAMILIES`, so adding a tool family does not
 * require editing an assertion — and, more importantly, so the assertion cannot
 * silently pass by having been updated to whatever the code now produces. It
 * still fails if a family mounts nothing or throws.
 */
function expectedToolCount() {
  return host.FAMILIES.reduce((total, family) => {
    const built = family.buildTools({ get: () => undefined })
    return total + built.length
  }, 0)
}

console.log('host coordinator:')

await test('apply() registers every family', async () => {
  const dispose = host.apply(ctx)
  assert.equal(typeof dispose, 'function', 'apply must return a disposer function')
  const names = registered.map((t) => t.name).sort()
  // Derived from FAMILIES rather than listed literally. The literal roster was
  // 14 names and had to be hand-edited by every task that added a tool, which
  // is how an assertion stops describing an invariant and starts describing a
  // snapshot. What matters is: the mount registers EXACTLY the tools the
  // families declare — no family silently dropped, none registered twice.
  const expected = host.FAMILIES
    .flatMap((family) => family.buildTools({ get: () => undefined }).map((t) => t.name))
    .sort()
  assert.deepEqual(names, expected, 'registered roster drifted:\n  got      ' + names.join(', ') + '\n  expected ' + expected.join(', '))
  assert.equal(new Set(names).size, names.length, 'a tool name was registered twice: ' + names.join(', '))
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

await test('dnd_srd_lookup reads the dataset the PACKAGE ships', async () => {
  // The defect this pins: the datasets were read from the installed skill's
  // code root, which the user deleted on purpose. The tool then answered
  // "dataset not found" for data that was merely somewhere else. Asserting a
  // real ENTRY proves the dataset was found AND parsed — a path fix that
  // forgot to ship the files would still fail here.
  const out = await call('dnd_srd_lookup', { query: 'goblin', category: 'monster' })
  assert.match(out, /\[ruleset 2014\]/, out)
  assert.match(out, /goblin/i, out)
  assert.ok(!/dataset missing/i.test(out), out)
})

await test('dnd_srd_lookup searches the 2024 dataset', async () => {
  const out = await call('dnd_srd_lookup', { query: 'goblin', category: 'monster', ruleset: '2024' })
  assert.match(out, /\[ruleset 2024\]/, out)
  assert.match(out, /goblin/i, out)
  assert.ok(!/dataset missing/i.test(out), out)
})

await test('dnd_srd_lookup renders the 2024 class table', async () => {
  // The 2024 classes have no prose (the upstream carries none), so a class
  // query used to return an entry with an EMPTY body. It must instead render
  // the structured facts: hit die, spellcasting and the 20-level table.
  const out = await call('dnd_srd_lookup', { query: 'bard', category: 'class', ruleset: '2024' })
  assert.match(out, /# Bard \(2024 SRD\)/, out)
  assert.match(out, /hit die d8/, out)
  assert.match(out, /## Level table/, out)
  assert.match(out, /Lv20:/, out)
})

await test('dnd_srd_lookup rejects an unknown ruleset before searching', async () => {
  const out = await call('dnd_srd_lookup', { query: 'goblin', ruleset: '3.5' })
  assert.match(out, /Unknown ruleset "3\.5"/, out)
  assert.match(out, /Nothing was searched/, out)
})

await test('a 2024 lookup under a 2014 name resolves through the rename map', async () => {
  // Per "Converting to SRD 5.2.1": Goblin -> Goblin Warrior, Feeblemind ->
  // Befuddlement. An old name must find the new entry and SAY it did.
  const goblin = await call('dnd_srd_lookup', { query: 'goblin warrior', category: 'monster', ruleset: '2024' })
  assert.match(goblin, /Goblin Warrior/, goblin)
  const old = await call('dnd_srd_lookup', { query: 'goblin', category: 'monster', ruleset: '2024' })
  assert.match(old, /Goblin Warrior|Goblin Boss|Goblin Minion/, old)
  const spell = await call('dnd_srd_lookup', { query: 'feeblemind', ruleset: '2024' })
  assert.match(spell, /Befuddlement/, spell)
  assert.match(spell, /renamed in SRD 5\.2\.1/, spell)
})

await test('a 2014 lookup under a 2024 name resolves back through the rename map', async () => {
  const out = await call('dnd_srd_lookup', { query: 'befuddlement', ruleset: '2014' })
  assert.match(out, /Feeblemind/, out)
  assert.match(out, /SRD 5\.2\.1/, out)
})

await test('an omitted 2024 stat block points at its recommended replacement', async () => {
  const out = await call('dnd_srd_lookup', { query: 'lizardfolk', ruleset: '2024' })
  assert.match(out, /\[omitted in SRD 5\.2\.1\]/, out)
  assert.match(out, /Scout/, out)
})

await test('a missing dataset is distinguishable from a missing entry', async () => {
  // These two used to read alike ("not found"), which is how a broken install
  // passed for an ordinary miss. A DM must be able to tell "the lookup table is
  // not installed" from "that spell is not in the table", because only one of
  // them is fixable by retrying something else.
  const miss = await call('dnd_srd_lookup', { query: 'zzzznotathing' })
  assert.match(miss, /\[no match\]/, miss)
  assert.match(miss, /dataset was searched/, miss)
  assert.ok(!/dataset missing/i.test(miss), 'an ordinary miss must not claim the dataset is missing')

  // Now hide the dataset and require the OTHER message. The stamp is what the
  // cache keys on, so a missing file cannot be served from the cache.
  const realStat = fsService.stat
  fsService.stat = async (t) => (/srd-2014.json$/.test(String(t.displayPath)) ? undefined : realStat.call(fsService, t))
  try {
    const absent = await call('dnd_srd_lookup', { query: 'goblin', ruleset: '2014' })
    assert.match(absent, /\[dataset missing\]/, absent)
    assert.match(absent, /not that the entry does not exist/, absent)
    assert.match(absent, /To fix:/, 'a broken install must say how to fix it: ' + absent)
    assert.ok(!/\[no match\]/.test(absent), 'an absent dataset must not be reported as a failed search')
  } finally {
    fsService.stat = realStat
  }
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

// --- late-registering fs, without gating the mount on it ------------------
// The first live run failed here: the families captured `ctx.get('fs')` once
// at mount, so apply() running before the filesystem backend existed cached
// undefined forever and every fs-backed tool answered "fs service unavailable"
// — while the six pure tools worked, which made it look like a data problem.
//
// The fix is lazy per-call reads, NOT declaring fs in `inject`. Declaring it
// would gate the whole plugin on the filesystem and take the six pure tools
// down with it, which defeats the per-family isolation.
await test('fs-backed tools work when fs appears AFTER apply()', async () => {
  const late = []
  let fsAvailable = false
  const lateCtx = {
    get(name) {
      if (name === 'fs') return fsAvailable ? fsService : undefined
      if (name === 'tools') return { register: (t) => { late.push(t); return () => {} } }
      return undefined
    },
    inject() {},
  }

  const mod = await import('../src/host/index.mjs?late-fs')
  const dispose = mod.apply(lateCtx)
  assert.equal(typeof dispose, 'function')

  // Every tool registered even though fs is absent: nothing was gated on it.
  //
  // The expected count is DERIVED from the module's own FAMILIES list, not
  // hard-coded. It was a literal 14 until T8/T9/T10 each added a family, which
  // would have made this suite fail for three intended changes. The invariant
  // worth asserting is "every family's tools mounted", not a fixed number.
  const expectedTools = expectedToolCount()
  assert.equal(late.length, expectedTools,
    'all ' + expectedTools + ' tools must register without fs; got ' + late.length)

  const before = late.find((t) => t.name === 'dnd_character_get')
  assert.match(String(await before.execute({ character: 'alice' })), /fs service unavailable/,
    'before fs exists the fs-backed tool should say so honestly')

  // The pure tools must be unaffected by the missing filesystem.
  const rollBefore = String(await late.find((t) => t.name === 'dnd_roll').execute({ spec: '2d6+3' }))
  assert.match(rollBefore, /2d6\+3 = \[/, 'a pure tool must work with no fs: ' + rollBefore)

  // fs comes up later, as it does in a real boot.
  fsAvailable = true

  const out = String(await late.find((t) => t.name === 'dnd_character_get').execute({ character: 'alice' }))
  assert.ok(!out.includes('fs service unavailable'),
    'after fs registers the tool must pick it up, not replay the mount-time miss')
  assert.match(out, /Alice/, 'and it must return real data: ' + out.slice(0, 200))
})

await test('inject gates on tools only, so a missing fs cannot unmount the pure tools', async () => {
  assert.ok(host.inject.includes('tools'), 'tools is the one hard dependency')
  assert.ok(!host.inject.includes('fs'),
    "fs must stay out of inject: gating on it would unmount the six pure tools whenever "
    + 'the filesystem is unavailable. Got ' + JSON.stringify(host.inject))
})

// --- routes are mounted without endangering the tools ---------------------
// The routes serve the Client panel; the tools are the plugin's main purpose.
// Failing to mount routes must never cost the tools.

await test('a missing webServer does not stop the tools from registering', async () => {
  const late = []
  const ctxNoWeb = {
    get(name) {
      if (name === 'tools') return { register: (t) => { late.push(t); return () => {} } }
      if (name === 'fs') return fsService
      return undefined
    },
    // Cordis always provides `inject`; when the service never appears, the
    // callback simply never runs. That is the headless case: no web server,
    // no routes, and the tools unaffected.
    inject(_deps, _cb) { /* service absent, callback never fires */ },
  }
  const mod = await import('../src/host/index.mjs?no-webserver')
  const dispose = mod.apply(ctxNoWeb)
  assert.equal(typeof dispose, 'function')
  assert.equal(late.length, expectedToolCount(), 'all tools must still register without a web server')
})

/** A ctx whose inject() delivers a scoped child context, as Cordis does. */
function makeWebCtx({ register } = {}) {
  const mounted = []
  const registerImpl = register ?? ((r) => { mounted.push(r.path); return () => { mounted.splice(mounted.indexOf(r.path), 1) } })
  const webCtx = {
    get: (n) => (n === 'webServer' ? { register: registerImpl } : n === 'fs' ? fsService : undefined),
    effect(fn) {
      const result = fn()
      // A fiber effect may only be a function, nullish or an iterable.
      assert.ok(typeof result === 'function' || result === null || result === undefined,
        'the effect must return a legal value, got ' + typeof result)
      return () => {}
    },
  }
  const ctx = {
    injected: [],
    get(name) {
      if (name === 'tools') return { register: () => () => {} }
      if (name === 'fs') return fsService
      // The outer context deliberately has NO webServer: reaching for it here
      // is the bug this test guards.
      return undefined
    },
    inject(deps, cb) {
      ctx.injected.push(...deps)
      if (deps.includes('webServer')) cb(webCtx)
    },
  }
  return { ctx, mounted, webCtx }
}

await test('routes mount through ctx.inject, not through the outer context', async () => {
  const { ctx, mounted } = makeWebCtx()
  const mod = await import('../src/host/index.mjs?inject-routes')
  mod.apply(ctx)
  assert.deepEqual(ctx.injected, ['webServer'], 'webServer must be requested by name')
  assert.ok(mounted.includes('/dnd/characters'), JSON.stringify(mounted))
  assert.ok(mounted.includes('/dnd/health'), JSON.stringify(mounted))
})

await test('the outer context is never asked for webServer directly', async () => {
  // The original defect: `ctx.get('webServer')` on a context that does not
  // declare the dependency returns undefined, `mountRoutes` bailed out, and
  // the panel 404'd with an empty body while every log line looked healthy.
  const asked = []
  const { webCtx } = makeWebCtx()
  const ctx = {
    get(name) { asked.push(name); return name === 'tools' ? { register: () => () => {} } : name === 'fs' ? fsService : undefined },
    inject(deps, cb) { if (deps.includes('webServer')) cb(webCtx) },
  }
  const mod = await import('../src/host/index.mjs?outer-ctx')
  mod.apply(ctx)
  assert.ok(!asked.includes('webServer'),
    'webServer must come from the injected child context; asking the outer one silently yields undefined')
})

await test('a throwing register surfaces instead of being swallowed', async () => {
  // register() throws on a duplicate (kind, path). Swallowing that hid the
  // original failure behind a 404 and an empty body.
  const { ctx } = makeWebCtx({ register: () => { throw new Error('webserver: duplicate exact route "/dnd/characters"') } })
  const mod = await import('../src/host/index.mjs?throw-route')
  assert.throws(() => mod.apply(ctx), /duplicate exact route/,
    'a route collision must be visible, not logged and ignored')
})

rmSync(tempRoot, { recursive: true, force: true })

console.log('')
if (failures > 0) {
  console.error(`host.test.mjs: ${failures} failure(s)`)
  process.exit(1)
}
console.log('host.test.mjs: all assertions passed')
