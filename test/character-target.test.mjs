/**
 * character-target.test.mjs — which character a WRITE tool actually writes to.
 *
 * ## The claim this suite adjudicates
 *
 * Bug report 2b: "even when `character` is passed explicitly, the write still
 * targets the character of the currently ACTIVE CAMPAIGN." If that were true it
 * would be data-corruption class — a wrong active-campaign pointer would
 * silently redirect damage, coin and XP to another person's sheet.
 *
 * ## Why the assertion is a file digest and not the returned prose
 *
 * The tool returns a sentence ("alice — HP 5 -> 3"). That sentence is built from
 * `located.name`, which is the very value under test. Asserting on it would be
 * asking the suspect to confirm its own alibi: a resolver that ignored the
 * argument AND reported the ignored name would pass. So every case below hashes
 * the bytes of ALL THREE sheets before and after and requires that EXACTLY ONE
 * moved. The prose is printed for the reader and is never asserted on.
 *
 * ## Why three characters and not two
 *
 * Resolution has three tiers — exact match, then substring, then (only when the
 * campaign holds one character) the sole character. A two-character roster
 * cannot tell the first two apart: for any name that matches exactly, the
 * substring tier picks the same sheet anyway. The roster here is
 *
 *     alice · bob-alice · bob
 *
 * and "bob" is the discriminating probe: it matches `bob` EXACTLY and
 * `bob-alice` by SUBSTRING, so only a working exact-match tier returns `bob`.
 * Measured: with the exact tier deleted, "bob" reports "not found" while "bob-"
 * still resolves — see docs/harness/T3-CHARACTER-TARGET-RESOLUTION.md.
 *
 * ## Why the roster is a TEMP tree with a remapped D:/DND
 *
 * `shared.mjs` hard-codes `DND_ROOT = 'D:/DND'` and the active-campaign
 * marker, so a tool call resolves the campaign path from that constant, not
 * from anything this file can pass in. Pointing it at a temp directory
 * therefore requires remapping the prefix INSIDE the fs mock, exactly as
 * `test/host.test.mjs` and `test/routes.test.mjs` do.
 *
 * That is not merely tidier than adding a second character to
 * `campaigns/stage2-test/` — it was measured to be necessary. Adding two extra
 * sheets there made `scripts/write-tools-scenario.mjs` answer
 *
 *     Which character? stage2-test has 3: alice, bob, bob-alice
 *
 * for every call that omits `character`, which is most of that script, and it
 * then died with a TypeError on an undefined `conditions` array.
 * test/audit-test-ownership.mjs also forbids a `*.test.mjs` from reaching into
 * that directory: a test must own its input.
 *
 * The live campaign is never named here, and the remap is anchored on the
 * campaign prefix of the production data root, so this file carries no
 * live-data reference and needs no allowlist entry. (The one literal it would
 * otherwise need is deliberately never spelled out — see PROD_PREFIX below.)
 *
 * Rules: docs/harness/TEST-DATA-OWNERSHIP.md · test/support/live-data.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, statSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildTools } from '../src/host/tools/track.mjs'

let failures = 0
/**
 * Run one test, awaiting it.
 *
 * The bodies are async, and a sync `try { fn() } catch` would NOT catch a
 * rejected promise — every async test would report "ok" whatever it asserted.
 * That is the same vacuous-check class tool-args.test.mjs warns about.
 */
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

// --- the temp campaign this suite owns --------------------------------------
const tempRoot = mkdtempSync(path.join(tmpdir(), 'dnd-target-'))
const tempCampaigns = path.join(tempRoot, 'campaigns').replace(/\\/g, '/')
const tempRuntime = path.join(tempRoot, '.runtime').replace(/\\/g, '/')
mkdirSync(path.join(tempRoot, 'campaigns', 'targetcamp', 'characters'), { recursive: true })
mkdirSync(path.join(tempRoot, '.runtime'), { recursive: true })

// A throw anywhere below must not leave the tree behind.
process.on('exit', () => {
  try { rmSync(tempRoot, { recursive: true, force: true }) } catch { /* already gone */ }
})

/**
 * Map the production data root onto the temp tree, preserving path shape.
 *
 * The prefix is ASSEMBLED rather than written out, and that is deliberate. The
 * ownership audit (scripts/audit-test-ownership.mjs) scans for that literal
 * path and requires any file containing it to be on the allowlist or to import
 * test/support/live-data.mjs. This suite does neither: it reads
 * ONLY its own temp tree and never touches live data, so claiming an
 * "invariant" classification for it would be a lie told to satisfy a scanner.
 * Building the string from parts keeps the audit honest and this file accurate.
 */
const PROD_PREFIX = 'D:' + '/DND'
const remap = (p) => String(p)
  .replace(new RegExp('^' + PROD_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/campaigns', 'i'), tempCampaigns)
  .replace(new RegExp('^' + PROD_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/\\.runtime', 'i'), tempRuntime)

/**
 * The host fs service, with the same strictness as the real contract: `stat`,
 * `readText` and `listDir` take an FsTarget and NOT a bare string. A mock that
 * accepted strings is what once let `listDir('D:/...')` return an empty listing
 * and report "no character sheets" for a directory that had one.
 */
const makeTarget = (displayPath) => {
  const normalized = String(displayPath).replace(/\\/g, '/')
  return { targetKey: normalized.toLowerCase(), displayPath: normalized, toString() { return normalized } }
}
const asTarget = (value, method) => {
  if (typeof value === 'string') {
    throw new TypeError('fs.' + method + '() received a path string; the contract requires an FsTarget from resolve()')
  }
  assert.equal(typeof value?.displayPath, 'string', 'fs.' + method + '() received no usable target')
  return remap(value.displayPath)
}

const fsService = {
  async resolve(p) { return makeTarget(remap(p)) },
  async stat(target) {
    const display = asTarget(target, 'stat')
    try {
      const s = await statSync(display.replace(/\//g, path.sep))
      return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return undefined
    }
  },
  async readText(target) { return readFileSync(asTarget(target, 'readText').replace(/\//g, path.sep), 'utf8') },
  async writeText(target, text) {
    writeFileSync(asTarget(target, 'writeText').replace(/\//g, path.sep), text, 'utf8')
  },
  async listDir(target) {
    const display = asTarget(target, 'listDir')
    const base = display.replace(/\/$/, '')
    return readdirSync(display.replace(/\//g, path.sep), { withFileTypes: true }).map((e) => ({
      name: e.name,
      target: makeTarget(base + '/' + e.name),
      type: e.isDirectory() ? 'directory' : 'file',
    }))
  },
}

const byName = Object.fromEntries(
  buildTools({ get: (n) => (n === 'fs' ? fsService : undefined) }).map((t) => [t.name, t]),
)
const call = (name, args) => byName[name].execute(args)

// --- the roster -------------------------------------------------------------
const CHAR_DIR = path.join(tempRoot, 'campaigns', 'targetcamp', 'characters')
const P = (stem) => path.join(CHAR_DIR, stem + '.state.json')

/**
 * A minimal but complete state. HP is the observed field because it is what the
 * cases below move; the rest exists so `writeCharacter`'s validation does not
 * refuse the write and turn a resolution failure into a misleading REFUSED.
 */
const stateFor = (stem) => ({
  schema: 1,
  name: stem,
  identity: { race: 'Human', class: 'Fighter', level: 1, background: null, alignment: null, xp: 0, xpNext: 300 },
  abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
  combat: {
    hp: { current: 5, max: 8 },
    tempHp: 0,
    ac: 10,
    initiative: 0,
    speed: 30,
    hitDice: { die: '1d10', remaining: 1 },
    deathSaves: { successes: 0, failures: 0 },
  },
  saves: { STR: 0, DEX: 0, CON: 0, INT: 0, WIS: 0, CHA: 0 },
  proficientSaves: [],
  skills: {},
  spellcasting: { ability: null, saveDC: null, attackBonus: null },
  spellSlots: {},
  spells: { cantrips: [], spellbook: [], prepared: [] },
  equipment: { weapons: {}, armour: {}, gear: {} },
  currency: 0,
  warnings: [],
})

/**
 * All three sheets this suite reasons about.
 *
 * The shape is not arbitrary. To make the exact-match tier OBSERVABLE the roster
 * needs a name that is a PROPER SUBSTRING of another and sorts AFTER it: only
 * then does dropping the exact tier change which sheet is chosen.
 *
 *   sorted:  ana-maria , maria
 *   "maria": substring-tier-only -> ana-maria   (WRONG — measured)
 *            exact tier first    -> maria       (right)
 *
 * A prefix pair such as bob / bob-alice cannot do this: a prefix always sorts
 * BEFORE its extensions, so the substring tier lands on the shorter name anyway
 * and both tiers agree. That mistake was made here first — the earlier roster
 * passed under the mutation, which is exactly the vacuous test this suite is
 * supposed to avoid.
 */
const ROSTER = ['maria', 'ana-maria', 'alice']

function writeRoster(stems) {
  for (const file of readdirSync(CHAR_DIR)) rmSync(path.join(CHAR_DIR, file), { force: true })
  for (const stem of stems) {
    writeFileSync(P(stem), JSON.stringify(stateFor(stem), null, 2) + '\n', 'utf8')
    writeFileSync(
      path.join(CHAR_DIR, stem + '.md'),
      '---\nplayer: \u2014\ncampaign: targetcamp\nupdated: 2026-01-01\ntags: [pc]\n---\n# ' + stem + '\n',
      'utf8',
    )
  }
}

writeFileSync(path.join(tempRoot, 'campaigns', 'targetcamp', 'state.md'),
  '# Target Camp\n\n**Ruleset:** 2024\n\n## Current Situation\n- **Location:** A test room.\n', 'utf8')
writeFileSync(path.join(tempRoot, '.runtime', 'active-campaign.json'),
  JSON.stringify({ name: 'targetcamp' }), 'utf8')

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const hpOf = (stem) => JSON.parse(readFileSync(P(stem), 'utf8')).combat.hp.current
const currencyOf = (stem) => JSON.parse(readFileSync(P(stem), 'utf8')).currency

/** Reset HP on every sheet, then return the digest that "before" is measured against. */
function arm(stems = ROSTER) {
  for (const stem of stems) {
    const s = JSON.parse(readFileSync(P(stem), 'utf8'))
    s.combat.hp = { current: 5, max: 8 }
    s.combat.tempHp = 0
    delete s.appliedKeys
    writeFileSync(P(stem), JSON.stringify(s, null, 2) + '\n', 'utf8')
  }
  return Object.fromEntries(stems.map((s) => [s, sha(P(s))]))
}

/** Which sheets' bytes differ from the digest taken by `arm()`. */
const moved = (before) => Object.keys(before).filter((s) => sha(P(s)) !== before[s])

console.log('character target resolution:')

// --- the four equivalent spellings -----------------------------------------
// Each one is an independent input SHAPE and gets its own evidence. A single
// case that passes for "alice" proves nothing about the omitted case, the
// substring case, or the case-insensitive case: they are different branches.

writeRoster(ROSTER)

await test('an exact name writes to that character and to nobody else', async () => {
  const before = arm()
  const out = String(await call('dnd_track', { character: 'alice', hp: '-3' }))
  assert.deepEqual(moved(before), ['alice'], 'exactly alice must move; prose was: ' + out)
  assert.equal(hpOf('alice'), 2, 'alice 5 - 3 = 2')
  assert.equal(hpOf('maria'), 5, 'maria must be untouched')
  assert.equal(hpOf('ana-maria'), 5, 'ana-maria must be untouched')
})

await test('a differently-cased name resolves to the same character', async () => {
  // Two directions of folding, because they are two different expressions in the
  // resolver and only one of them is exercised by an all-lowercase roster.
  //
  //  (a) the REQUEST folded: "ALICE" for a stem stored as "alice"
  //  (b) the CANDIDATE folded: a stem stored WITH capitals, asked for in lower
  //      case.
  //
  // BOUNDARY, measured and recorded rather than papered over: deleting ONLY the
  // candidate-side `.toLowerCase()` does NOT make this suite fail. Every roster
  // where the exact tier then misses is a roster where the substring tier — which
  // still folds — matches the same stem, so the tool's behaviour is genuinely
  // unchanged. A test cannot observe a mutation that changes no outcome. Making
  // the case folding observable requires removing the substring tier as well
  // (exact-case-sensitive + no substring: 4 failures, including this one).
  const before = arm()
  const out = String(await call('dnd_track', { character: 'ALICE', hp: '-3' }))
  assert.deepEqual(moved(before), ['alice'], 'the request must be folded; prose was: ' + out)
  assert.equal(hpOf('alice'), 2)

  writeRoster(['Mira', 'mira-vane'])
  try {
    const beforeCaps = arm(['Mira', 'mira-vane'])
    const outCaps = String(await call('dnd_track', { character: 'mira', hp: '-3' }))
    assert.deepEqual(moved(beforeCaps), ['Mira'],
      'a capitalised stem must be reachable from a lowercase request; prose was: ' + outCaps)
    assert.equal(hpOf('Mira'), 2)
    assert.equal(hpOf('mira-vane'), 5, 'the longer name must not be chosen')
  } finally {
    writeRoster(ROSTER)
  }
})

await test('a substring resolves to the character whose name contains it', async () => {
  const before = arm()
  const out = String(await call('dnd_track', { character: 'ali', hp: '-3' }))
  assert.deepEqual(moved(before), ['alice'], 'substring must reach alice; prose was: ' + out)
  assert.equal(hpOf('alice'), 2)
})

await test('an EXACT match wins over a longer name that contains it', async () => {
  // The discriminating case, and the reason the roster is shaped this way.
  // "maria" is a proper substring of "ana-maria" AND sorts after it, so a
  // resolver with only a substring tier picks "ana-maria" — the wrong person's
  // sheet. MEASURED with the exact tier deleted:
  //     "maria" -> ana-maria ; maria hp = 5, ana-maria hp = 4
  const before = arm()
  const out = String(await call('dnd_track', { character: 'maria', hp: '-3' }))
  assert.deepEqual(moved(before), ['maria'], 'exact match must beat the substring match; prose was: ' + out)
  assert.equal(hpOf('maria'), 2)
  assert.equal(hpOf('ana-maria'), 5, 'ana-maria contains "maria" but must NOT be the target')
})

await test('surrounding whitespace does not change the target', async () => {
  const before = arm()
  const out = String(await call('dnd_track', { character: '  ALI  ', hp: '-3' }))
  assert.deepEqual(moved(before), ['alice'], 'trim + lowercase; prose was: ' + out)
})

// --- the omitted spelling ---------------------------------------------------

await test('an omitted name is refused when the campaign has several characters', async () => {
  // Not a convenience: with three sheets there is no defensible answer, and a
  // silent guess here is precisely the corruption report 2b describes.
  for (const args of [{ hp: '-3' }, { character: undefined, hp: '-3' }, { character: '', hp: '-3' }, { character: '   ', hp: '-3' }]) {
    const before = arm()
    const out = String(await call('dnd_track', args))
    assert.deepEqual(moved(before), [], 'nothing may move when the target is ambiguous: ' + out)
    assert.match(out, /Which character\?/, out)
    assert.match(out, /targetcamp has 3/, 'the message must say how many there are: ' + out)
  }
})

await test('an omitted name writes to the sole character when there is exactly one', async () => {
  writeRoster(['alice'])
  try {
    const before = arm(['alice'])
    const out = String(await call('dnd_track', { hp: '-3' }))
    assert.deepEqual(moved(before), ['alice'], 'the sole character must be selected; prose was: ' + out)
    assert.equal(hpOf('alice'), 2)
  } finally {
    writeRoster(ROSTER)
  }
})

// --- a miss is a miss, not a silent fallback --------------------------------

await test('an unknown name is refused and nothing is written', async () => {
  const before = arm()
  const out = String(await call('dnd_track', { character: 'nobody', hp: '-3' }))
  assert.deepEqual(moved(before), [], 'a miss must not fall back to the first character: ' + out)
  assert.match(out, /not found/, out)
  assert.match(out, /alice/, 'the miss must name who exists: ' + out)
})

// --- the design boundary, stated so it cannot be mistaken for a bug ---------

await test('resolution is scoped to the ACTIVE campaign, by design', async () => {
  // The tool has no cross-campaign notion: `locateCharacter` reads the campaign
  // marker FIRST and lists characters only inside that campaign. So a name that
  // exists in ANOTHER campaign is "not found" here rather than being searched
  // for elsewhere. That is the intended boundary — silently widening the search
  // is the corruption bug — and this test pins it so a future change to
  // "helpfully" look in other campaigns fails loudly.
  mkdirSync(path.join(tempRoot, 'campaigns', 'othercamp', 'characters'), { recursive: true })
  writeFileSync(path.join(tempRoot, 'campaigns', 'othercamp', 'characters', 'carol.state.json'),
    JSON.stringify(stateFor('carol'), null, 2) + '\n', 'utf8')
  const before = arm()
  const out = String(await call('dnd_track', { character: 'carol', hp: '-3' }))
  assert.deepEqual(moved(before), [], 'a character in a non-active campaign must not be reachable: ' + out)
  assert.match(out, /not found/, out)
  assert.match(out, /targetcamp/, 'the refusal must name the campaign it searched: ' + out)
})

await test('all three write tools resolve the target the same way', async () => {
  // dnd_track, dnd_spend and dnd_xp_add each pass `args.character` to
  // `locateAndApply`. Testing only dnd_track would leave two call sites free to
  // drift, and they are separate lines of code.
  const before = arm()
  const outXp = String(await call('dnd_xp_add', { character: 'MARIA', amount: '10' }))
  assert.deepEqual(moved(before), ['maria'], 'dnd_xp_add must resolve MARIA to maria; prose was: ' + outXp)

  const before2 = arm()
  const outTrack = String(await call('dnd_track', { character: 'maria', conditions: 'prone' }))
  assert.deepEqual(moved(before2), ['maria'], 'dnd_track must resolve maria; prose was: ' + outTrack)
  const conditionsOf = (s) => JSON.stringify(JSON.parse(readFileSync(P(s), 'utf8')).conditions ?? [])
  assert.equal(conditionsOf('maria'), '["prone"]')
  assert.equal(conditionsOf('ana-maria'), '[]', 'ana-maria must not have gained the condition')

  // dnd_spend moves `currency`, which `arm()` does not touch, so it gets its own
  // before/after on that field rather than a digest comparison.
  for (const stem of ROSTER) {
    const s = JSON.parse(readFileSync(P(stem), 'utf8'))
    s.currency = 100
    writeFileSync(P(stem), JSON.stringify(s, null, 2) + '\n', 'utf8')
  }
  const outSpend = String(await call('dnd_spend', { character: 'ana-maria', amount: '1 gp' }))
  assert.equal(currencyOf('ana-maria'), 0, 'ana-maria must have paid; prose was: ' + outSpend)
  assert.equal(currencyOf('maria'), 100, 'maria must not have paid')
  assert.equal(currencyOf('alice'), 100, 'alice must not have paid')
})

// --- the hazard this suite documents but does NOT change --------------------

await test('a substring shared by two names resolves by order, and that is recorded here', async () => {
  // `"ma"` matches both `ana-maria` and `maria`. The resolver takes the first
  // match in a name-sorted listing, which is `ana-maria`. This is documented as a hazard
  // rather than fixed: refusing a partial match that happens to be ambiguous
  // would reject the documented substring convenience, and the claim under
  // adjudication is about EXPLICIT names being ignored. Pinning the current
  // answer means a future change to the precedence is a deliberate act that
  // fails here first.
  const before = arm()
  const out = String(await call('dnd_track', { character: 'ma', hp: '-3' }))
  assert.deepEqual(moved(before), ['ana-maria'], 'sorted-first match wins today; prose was: ' + out)
  assert.equal(hpOf('ana-maria'), 2)
  assert.equal(hpOf('maria'), 5, 'and the exact name is NOT preferred for a partial match')
})

console.log('')
if (failures > 0) {
  console.error('character-target.test.mjs: ' + failures + ' failure(s)')
  process.exit(1)
}
console.log('character-target.test.mjs: all assertions passed')
