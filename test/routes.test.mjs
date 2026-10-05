/**
 * routes tests — the HTTP surface the panel reads.
 *
 * These drive REAL http requests through a REAL server against a REAL
 * directory. Mocking the request/response pair is what a permissive mock does
 * best, and this project has already lost two bugs to mocks that accepted more
 * than the real thing does. The cost is a few milliseconds of socket setup for
 * the module that decides what the panel displays.
 *
 * The campaign this suite asserts against is a temp tree this file builds and
 * deletes, so every response-shape assertion owns its input. The live campaign
 * is read once, at the end, purely to prove this suite did not write to it —
 * never to assert what it contains.
 *
 * Rules: test/support/live-data.mjs · docs/harness/TEST-DATA-OWNERSHIP.md
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { API_PREFIX, ROUTES, buildHandlers, mountRoutes } from '../src/host/routes.mjs'
import { activeCampaignDir } from '../src/host/tools/shared.mjs'
import { readAllCharacters } from '../src/host/tools/state-io.mjs'
import {
  LIVE_CAMPAIGN,
  LIVE_MARKER,
  liveExists,
  liveWitness,
  snapshotTree,
  diffTree,
} from './support/live-data.mjs'
process.env.DND_ROOT ??= 'D:/DND' // direct execute() calls have no session; the env root is the explicit config

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failures += 1
    console.log('  FAIL ' + name)
    console.log('       ' + (error && error.message ? error.message : error))
  }
}

const nodePath = (p) => String(p).replace(/\//g, path.sep)
const target = (p) => ({ targetKey: String(p).toLowerCase(), displayPath: String(p).replace(/\\/g, '/') })

/** A real fs service over a real directory, shaped like the host contract. */
function makeFs() {
  return {
    async resolve(p) { return target(p) },
    async stat(t) {
      if (typeof t === 'string') throw new TypeError('stat requires an FsTarget')
      try {
        const s = statSync(nodePath(t.displayPath))
        return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs }
      } catch { return undefined }
    },
    async readText(t) {
      if (typeof t === 'string') throw new TypeError('readText requires an FsTarget')
      return readFileSync(nodePath(t.displayPath), 'utf8')
    },
    async listDir(t) {
      if (typeof t === 'string') throw new TypeError('listDir requires an FsTarget')
      const { readdirSync } = require('node:fs')
      const base = String(t.displayPath).replace(/\/$/, '')
      return readdirSync(nodePath(t.displayPath), { withFileTypes: true }).map((e) => ({
        name: e.name, target: target(`${base}/${e.name}`),
        type: e.isDirectory() ? 'directory' : 'file',
      }))
    },
  }
}

const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)

const root = mkdtempSync(path.join(tmpdir(), 'dnd-routes-'))
const campaignsDir = path.join(root, 'campaigns').replace(/\\/g, '/')
const runtimeDir = path.join(root, '.runtime').replace(/\\/g, '/')
mkdirSync(nodePath(`${campaignsDir}/alpha/characters`), { recursive: true })
mkdirSync(nodePath(runtimeDir), { recursive: true })

const SHEET = `# Alice
**Player:** —  **Campaign:** alpha  **Last Updated:** 2026-09-04

## Identity
- **Race:** High Elf | **Class:** Wizard | **Level:** 1 | **Background:** Sage
- **XP:** 0 / 300

## Combat Stats
- **HP:** 8 / 8 | **Temp HP:** 0
- **AC:** 12 | **Initiative:** +2 | **Speed:** 30

## Ability Scores
| STR | DEX | CON | INT | WIS | CHA |
|-----|-----|-----|-----|-----|-----|
| 8 (-1) | 14 (+2) | 15 (+2) | 17 (+3) | 10 (+0) | 10 (+0) |

## Skills
| Skill | Ability | Bonus | Proficient |
|-------|---------|-------|-----------|
| Arcana | INT | +5 | ✓ |

## Attacks
| Name | Attack Bonus | Damage | Type | Notes |
|------|-------------|--------|------|-------|
| 电爪 Shocking Grasp | +5 | 1d8 | Lightning | melee |

## Spell Slots (if applicable)
| Level | Total | Used |
|-------|-------|------|
| 1st | 2 | 0 |

## Equipment & Inventory
**Weapons:**
- Dagger

**Armour:**
- *(none)*

**Adventuring Gear:**
- Robe

**Currency:** 8 gp 0 sp 0 cp

## Backstory & Notes
- 游历世界收集法术的精灵法师贤者。

## Features & Traits

**Ritual Casting** — 可以以仪式形式施放具有仪式标记的法术。
**Fey Ancestry (精灵血脉)** — 对魅惑效果的豁免检定具有优势。
`
writeFileSync(nodePath(`${campaignsDir}/alpha/characters/alice.md`), SHEET, 'utf8')

// A deliberately invalid character: more slots expended than exist.
writeFileSync(nodePath(`${campaignsDir}/alpha/characters/broken.state.json`), JSON.stringify({
  schema: 1, name: 'Broken',
  combat: { hp: { current: 5, max: 5 } },
  spellSlots: { 1: { total: 1, used: 9 } },
  currency: 10,
}), 'utf8')

// A hostile card: kind lives in the frontmatter tags, numbers in the state
// file — the same split every character uses.
writeFileSync(nodePath(`${campaignsDir}/alpha/characters/goblin.md`),
  '---\nplayer: null\ncampaign: alpha\nupdated: 2026-10-04\ntags: [enemy]\n---\n\n# Goblin\n\n## Features & Traits\n\n- Nimble Escape\n', 'utf8')
writeFileSync(nodePath(`${campaignsDir}/alpha/characters/goblin.state.json`), JSON.stringify({
  schema: 1, name: 'Goblin',
  identity: { level: null, class: null, race: null },
  abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  combat: { hp: { current: 4, max: 7 }, tempHp: 0, ac: 15 },
  conditions: ['dead'],
  currency: 0,
}), 'utf8')

/** Point the active-campaign marker at a campaign name. */
function activate(name) {
  writeFileSync(nodePath(`${runtimeDir}/active-campaign.json`), JSON.stringify({ name }), 'utf8')
}

// The marker path is a module constant pointing at the real D:\DND, so the
// handlers are exercised through a ctx whose `fs` maps that path into the
// temporary tree. This keeps the production path shape while never touching
// the real campaign.
const DND_ROOT = 'D:/DND'
function redirectFs() {
  const base = makeFs()
  const remap = (p) => String(p).replace(/^D:\/DND\/\.runtime/i, runtimeDir).replace(/^D:\/DND\/campaigns/i, campaignsDir)
  return {
    async resolve(p) { return base.resolve(remap(p)) },
    async stat(t) { return base.stat({ ...t, displayPath: remap(t.displayPath) }) },
    async readText(t) { return base.readText({ ...t, displayPath: remap(t.displayPath) }) },
    async listDir(t) { return base.listDir({ ...t, displayPath: remap(t.displayPath) }) },
  }
}

function makeCtx(fs) {
  const registered = []
  return {
    registered,
    get(name) {
      if (name === 'fs') return fs
      return undefined
    },
    effect(fn) { registered.push(fn()) },
  }
}

/** Start a real server with the real handlers and return its base URL. */
async function serve(ctx) {
  const handlers = buildHandlers(ctx)
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname
    const handler = handlers[pathname]
    if (handler === undefined) { res.writeHead(404); res.end(); return }
    Promise.resolve(handler(req, res)).catch(() => { res.writeHead(500); res.end() })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}

const fsService = redirectFs()
const ctx = makeCtx(fsService)

await test('the route list is namespaced and exact', () => {
  assert.ok(ROUTES.length >= 2)
  for (const r of ROUTES) {
    assert.equal(r.kind, 'exact')
    assert.ok(r.path.startsWith(API_PREFIX), r.path)
  }
})

activate('alpha')
const srv = await serve(ctx)

await test('GET /dnd/characters returns the active campaign', async () => {
  const res = await fetch(`${srv.url}${API_PREFIX}/characters`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.campaign, 'alpha')
  assert.ok(Array.isArray(body.characters))
  assert.ok(body.characters.some((c) => c.name === 'alice'), JSON.stringify(body.characters.map((c) => c.name)))
})

await test('the response carries real state', async () => {
  const body = await (await fetch(`${srv.url}${API_PREFIX}/characters`)).json()
  const alice = body.characters.find((c) => c.name === 'alice')
  assert.equal(alice.state.abilities.INT, 17)
  assert.deepEqual(alice.state.combat.hp, { current: 8, max: 8 })
  assert.deepEqual(alice.state.spellSlots, { 1: { total: 2, used: 0 } })
  assert.equal(alice.state.currency, 800, 'money is a single copper total')
})

await test('the response carries display projections', async () => {
  const body = await (await fetch(`${srv.url}${API_PREFIX}/characters`)).json()
  const alice = body.characters.find((c) => c.name === 'alice')
  assert.equal(alice.display.currency, '8 gp 0 sp 0 cp',
    'money is formatted on the host so the panel cannot drift')
  assert.equal(alice.display.class, 'Wizard')
})

await test('the response carries the campaign ruleset and sheet features', async () => {
  // The panel needs the ruleset to pick the right per-class feature table,
  // and the Features & Traits list lives in narrative the state file does not
  // carry — the Host extracts it so the client never parses sheet markdown.
  const body = await (await fetch(`${srv.url}${API_PREFIX}/characters`)).json()
  assert.match(body.ruleset, /^(2014|2024)$/, JSON.stringify(body.ruleset))
  const alice = body.characters.find((c) => c.name === 'alice')
  assert.ok(Array.isArray(alice.features), 'features must be an array')
  assert.equal(alice.features.length, 2, JSON.stringify(alice.features))
  assert.equal(alice.features[0].name, 'Ritual Casting')
  assert.match(alice.features[0].text, /仪式/)
  assert.equal(alice.features[1].name, 'Fey Ancestry (精灵血脉)')
})

await test('the default response stays PC-only when an enemy is present', async () => {
  const body = await (await fetch(`${srv.url}${API_PREFIX}/characters`)).json()
  assert.equal(body.enemies, undefined, 'no enemies key without the query — old clients read the same shape')
  assert.ok(!body.characters.some((c) => c.name === 'goblin'), 'the enemy never joins the party list')
  assert.equal(body.counts.enemies, 0, 'no query, no enemies counted')
})

await test('?include=enemies adds hostile cards with the combat read', async () => {
  const body = await (await fetch(`${srv.url}${API_PREFIX}/characters?include=enemies`)).json()
  assert.ok(Array.isArray(body.enemies), 'enemies must be an array under the query')
  assert.equal(body.counts.enemies, 1, JSON.stringify(body.counts))
  const goblin = body.enemies.find((c) => c.name === 'goblin')
  assert.ok(goblin !== undefined, JSON.stringify(body.enemies.map((c) => c.name)))
  assert.deepEqual(goblin.display.hp, { current: 4, max: 7 }, 'the players plan with REAL hp')
  assert.equal(goblin.display.ac, 15)
  assert.deepEqual(goblin.display.conditions, ['dead'], 'the dead mark dnd_attack leaves must reach the panel')
  assert.equal(goblin.features, undefined, 'an enemy card carries no PC feature section')
  assert.ok(!body.characters.some((c) => c.name === 'goblin'), 'the enemy still stays out of the party list')
})

await test('GET /dnd/meta serves the display index the panel renders against', async () => {
  const res = await fetch(`${srv.url}${API_PREFIX}/meta`)
  assert.equal(res.status, 200)
  const meta = await res.json()
  // Chinese names for spells...
  assert.equal(meta.spells['Fireball'].zh, '火球术')
  // ...their combat line parsed from the SRD prose...
  assert.equal(meta.spells['Fireball'].level, 3)
  assert.match(meta.spells['Fireball'].info, /8d6/)
  assert.match(meta.spells['Fireball'].info, /DEX豁免/)
  // ...per-class features by level...
  assert.deepEqual(meta.classes['2024']?.['Wizard']?.[0], ['Arcane Recovery', 'Ritual Adept', 'Spellcasting'])
  // ...and weapons with their damage and 2024 mastery action.
  assert.equal(meta.weapons['Longsword'].zh, '长剑')
  // the damage line is translated host-side, not raw English
  assert.equal(meta.weapons['Longsword'].damage, '1d8 挥砍')
  assert.deepEqual(meta.weapons['Dagger'].properties, ['灵巧', '轻型', '投掷'])
  assert.equal(meta.weapons['Longsword'].mastery, 'Sap')
  assert.equal(meta.armor['Chain Mail'].zh, '链甲')
  assert.equal(meta.armor['Chain Mail'].ac, 'AC 16 + 敏捷', 'the AC formula is translated (SRD 5.1 lists Chain Mail with + DEX)')
  assert.equal(meta.abilities.STR, '力量')
  assert.equal(meta.gear['Backpack'], '背包')
})

await test('an unmigrated character reports needsMigration', async () => {
  const body = await (await fetch(`${srv.url}${API_PREFIX}/characters`)).json()
  const alice = body.characters.find((c) => c.name === 'alice')
  assert.equal(alice.needsMigration, true)
  assert.equal(alice.hasStateFile, false)
})

await test('a card tagged without pc is excluded from the panel list', async () => {
  // The campaign characters/ directory hosts monster statblocks too; the
  // frontmatter `tags` are the PC/monster distinction, and the panel is the
  // PC panel. A card written before the distinction existed has no tags and
  // must still count as a PC.
  writeFileSync(nodePath(`${campaignsDir}/alpha/characters/goblin-warrior.md`), `---
player:
campaign: alpha
updated: 2026-09-04
worldTime:
tags: [monster]
---

# Goblin Warrior
**Race:** Goblin | **Class:** Fighter | **Level:** 1

## Combat Stats
**HP:** 7 / 7 | **Temp HP:** 0 | **AC:** 15 | **Initiative:** +2 | **Speed:** 30 ft
`, 'utf8')
  const body = await (await fetch(`${srv.url}${API_PREFIX}/characters`)).json()
  assert.equal(body.characters.some((c) => c.name === 'goblin-warrior'), false,
    JSON.stringify(body.characters.map((c) => c.name)))
  assert.equal(body.counts.excludedNonPC, 1)
  assert.ok(body.characters.some((c) => c.name === 'alice'),
    'a tagless card still counts as a PC (backwards compatibility)')
})


await test('an invalid state is reported, not hidden', async () => {
  const body = await (await fetch(`${srv.url}${API_PREFIX}/characters`)).json()
  const broken = body.characters.find((c) => c.name === 'broken')
  assert.ok(broken !== undefined, 'a state file with no sheet is still a character')
  assert.ok(broken.findings.some((f) => f.includes('ERROR')), JSON.stringify(broken.findings))
})

await test('the counts distinguish empty from broken', async () => {
  const body = await (await fetch(`${srv.url}${API_PREFIX}/characters`)).json()
  assert.equal(body.counts.characters, 2)
  assert.equal(body.counts.withStateFile, 1)
})

await test('responses are marked no-store so the panel cannot show stale numbers', async () => {
  const res = await fetch(`${srv.url}${API_PREFIX}/characters`)
  assert.match(res.headers.get('cache-control') ?? '', /no-store/)
})

await test('the response is valid UTF-8 JSON', async () => {
  const res = await fetch(`${srv.url}${API_PREFIX}/characters`)
  assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  assert.match(res.headers.get('content-type') ?? '', /charset=utf-8/)
})

await test('GET /dnd/health reports the data source', async () => {
  const body = await (await fetch(`${srv.url}${API_PREFIX}/health`)).json()
  assert.equal(body.ok, true)
  assert.equal(body.fs, true)
  assert.equal(body.campaign, 'alpha')
})

await test('an unknown path is a 404', async () => {
  const res = await fetch(`${srv.url}/dnd/nope`)
  assert.equal(res.status, 404)
})

// --- a stale marker -------------------------------------------------------
await test('a marker naming a missing campaign yields 404, not an empty list', async () => {
  // The distinctive failure: a stale marker would otherwise read as "this
  // campaign has no characters", sending the DM to look in the wrong place.
  writeFileSync(nodePath(`${runtimeDir}/active-campaign.json`), JSON.stringify({ name: 'nope' }), 'utf8')
  const res = await fetch(`${srv.url}${API_PREFIX}/characters`)
  assert.equal(res.status, 404)
  const body = await res.json()
  assert.match(body.error, /stale/)
  assert.match(body.error, /nope/)
})

await test('health distinguishes a stale marker from no marker', async () => {
  const body = await (await fetch(`${srv.url}${API_PREFIX}/health`)).json()
  assert.equal(body.ok, false)
  assert.equal(body.fs, true, 'the filesystem itself is fine')
  assert.equal(body.campaign, 'nope', 'the stale name is reported, not blanked')
  assert.match(body.reason, /directory missing/)
})

await test('no marker at all reports no active campaign', async () => {
  rmSync(nodePath(`${runtimeDir}/active-campaign.json`), { force: true })
  const body = await (await fetch(`${srv.url}${API_PREFIX}/health`)).json()
  assert.equal(body.ok, false)
  assert.equal(body.campaign, null)
  assert.match(body.reason, /no active campaign/)
})

// --- a missing fs ---------------------------------------------------------
await test('a missing fs yields 503 rather than a crash', async () => {
  const noFs = makeCtx(undefined)
  const s2 = await serve(noFs)
  const res = await fetch(`${s2.url}${API_PREFIX}/characters`)
  assert.equal(res.status, 503)
  const body = await res.json()
  assert.match(body.error, /fs service unavailable/)
  await s2.close()
})

await srv.close()

// --- mounting -------------------------------------------------------------
await test('mountRoutes registers every route through the ctx effect', () => {
  const registered = []
  const disposers = []
  const mountCtx = {
    get: (n) => (n === 'webServer' ? { register: (r) => { registered.push(r.path); const d = () => disposers.push(r.path); return d } } : undefined),
  }
  mountRoutes(mountCtx)
  assert.deepEqual(registered.sort(), ROUTES.map((r) => r.path).sort())
})

await test('the mount disposer removes every route', () => {
  const registered = []
  const removed = []
  const mountCtx = {
    get: (n) => (n === 'webServer' ? { register: (r) => { registered.push(r.path); return () => removed.push(r.path) } } : undefined),
  }
  const dispose = mountRoutes(mountCtx)
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.deepEqual(removed.sort(), ROUTES.map((r) => r.path).sort(),
    'every route must be removable: a duplicate (kind,path) throws on reload')
})

await test('mountRoutes throws when webServer is absent', () => {
  // Returning null was the bug: the caller could not tell "no web server in
  // this run" from "registration failed", and the symptom was a 404 with an
  // empty body that looked like a routing mistake rather than a wiring one.
  assert.throws(() => mountRoutes({ get: () => undefined }), /webServer is not in scope/)
})

await test('the error names the fix, not just the fault', () => {
  try {
    mountRoutes({ get: () => undefined })
    assert.fail('expected a throw')
  } catch (error) {
    assert.match(error.message, /ctx\.inject\(\['webServer'\]/,
      'the message must say where to mount from, since the wrong ctx is the whole trap')
  }
})

await test('a duplicate route registration throws, which is why disposers matter', () => {
  const seen = new Set()
  const throwing = {
    get: () => ({
      register: (r) => {
        if (seen.has(r.path)) throw new Error('duplicate route')
        seen.add(r.path)
        return () => seen.delete(r.path)
      },
    }),
  }
  const dispose = mountRoutes(throwing)
  assert.throws(() => mountRoutes(throwing), /duplicate route/,
    'the second mount without disposal must fail — this is the reload hazard')
  dispose()
  assert.doesNotThrow(() => mountRoutes(throwing), 'after disposal the remount succeeds')
})

// --- the live campaign, read-only -----------------------------------------
//
// INVARIANT TEST. The property is "THIS SUITE DOES NOT TOUCH THE REAL
// CAMPAIGN", not "the real character happens to be unmigrated" and not "the
// real character's HP is 8". The first version asserted that no `.state.json`
// sat beside `alice.md` — a proxy that was true until that character was
// migrated with the operator's consent, at which point it failed while the
// actual invariant still held perfectly.
//
// So: snapshot the whole character directory, drive the read path this suite
// exists to exercise, snapshot again, require no difference. That holds however
// the campaign is stored, and for however many characters it has.
//
// The campaign directory is a module constant pointing at D:\DND, so this is
// the one place in the suite that deliberately reads live data. It compares
// bytes only; it never inspects what those bytes say.
const LIVE_CHAR_DIR = `${LIVE_CAMPAIGN}/characters`
if (liveExists(LIVE_CHAR_DIR)) {
  await test('the live campaign is untouched by these tests', async () => {
    const before = snapshotTree(LIVE_CHAR_DIR)

    // Re-read through the character-listing path this suite exercises.
    // `makeFs` resolves absolute paths, so this reads the live campaign
    // directory — which is exactly what we want to prove is safe.
    const realFs = makeFs()
    const located = await activeCampaignDir(realFs)
    assert.ok(located !== undefined, 'the real campaign is active for this check')
    await readAllCharacters(realFs, `${located.dir}/characters`)

    const changes = diffTree(before, snapshotTree(LIVE_CHAR_DIR))
    assert.deepEqual(changes, [], 'the live campaign must not change. Differences: ' + changes.join('; '))
  })
}

await test('the live active-campaign marker is not written by these tests', () => {
  // This marker is rewritten by the write-tools and concurrency scenarios,
  // which repoint it and restore it in a `finally`. It carries a BOM in the
  // real installation, so an accidental text-mode round trip silently strips
  // it and "no active campaign" comes back. Runs unconditionally: the marker
  // must exist and must not have moved.
  const witness = liveWitness(LIVE_MARKER, 'the active-campaign marker')
  assert.ok(witness.existedBefore, 'the marker should exist while a campaign is in play')
  witness.assertUnchanged()
})

rmSync(root, { recursive: true, force: true })

console.log('')
if (failures > 0) {
  console.error(`routes.test.mjs: ${failures} failure(s)`)
  process.exit(1)
}
console.log('routes.test.mjs: all assertions passed')
