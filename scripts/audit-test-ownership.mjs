/**
 * scripts/audit-test-ownership.mjs — enforce the test/data ownership rules.
 *
 * A defect that recurred in this project: a test read a LIVE campaign file
 * (`campaigns/morgansfort/characters/alice.md`). The plugin then migrated that
 * character — a legal change — and five suites went red at once. Not a code
 * regression: the test's input had changed shape.
 *
 * The rules that prevent it are written down in
 * docs/harness/TEST-DATA-OWNERSHIP.md, and they are easy to state:
 *
 *   PARSER TEST     owns its input. Reads test/fixtures/. Never live data.
 *   INVARIANT TEST  may read live data, but must assert a PROPERTY
 *                   (unchanged bytes / a shape that holds for any input),
 *                   never a snapshot of one campaign's current values.
 *
 * A rule nobody checks is a rule that decays. This script reads every
 * `test/*.test.mjs` and `scripts/*.mjs`, finds each live-data reference, and
 * requires it to be classified — either the file uses the shared helper
 * (`test/support/live-data.mjs`), or the reference is on an explicit,
 * reviewed allowlist with a stated reason.
 *
 * Anything unclassified fails the run, so a new live-data dependency cannot
 * sneak in without someone deciding which of the two rules applies.
 *
 * Usage: node scripts/audit-test-ownership.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

let failures = 0
const check = (ok, msg) => {
  if (ok) console.log('  ok  ' + msg)
  else { failures += 1; console.log('  FAIL ' + msg) }
}
const section = (t) => console.log('\n' + t)

// --- collect the files to audit --------------------------------------------
const testFiles = readdirSync(path.join(root, 'test'))
  .filter((n) => n.endsWith('.test.mjs'))
  .sort()
  .map((n) => `test/${n}`)

const scriptFiles = readdirSync(path.join(root, 'scripts'))
  .filter((n) => n.endsWith('.mjs'))
  .sort()
  .map((n) => `scripts/${n}`)

const targets = [...testFiles, ...scriptFiles]

/**
 * A live-data reference: a path that resolves into the campaign data root, or
 * a raw `D:/DND/campaigns` / `morgansfort` literal.
 *
 * Deliberately does NOT flag `DND_ROOT`/`LIVE_ROOT` constants themselves — the
 * question is whether a file reaches into live DATA, and a variable holding the
 * root is only a reference once it is used. `LIVE_ROOT` inside the helper
 * module is the definition, not a use.
 */
const LIVE_PATTERNS = [
  /D:\/DND\/campaigns/i,
  /['"`][^'"`]*campaigns\/morgansfort/i,
  /\bmorgansfort\b/,
]

/**
 * The allowlist: files permitted to reference live data, each with the reason
 * and the rule it obeys. Adding an entry is a deliberate act.
 */
const ALLOWED = {
  'test/routes.test.mjs': {
    rule: 'invariant',
    reason: 'reads the live character directory once, hashes it, re-reads, requires no change',
  },
  'test/state-io.test.mjs': {
    rule: 'invariant',
    reason: 'reads the live character and asserts nothing moved; the read is self-consistent',
  },
  'test/sheet-parse.test.mjs': {
    rule: 'parser',
    reason: 'reads test/fixtures/; the morgansfort mentions are comments and fixture provenance',
  },
  'test/sheet-split.test.mjs': {
    rule: 'parser',
    reason: 'reads test/fixtures/; the morgansfort mentions are comments and fixture provenance',
  },
  'test/state-schema.test.mjs': {
    rule: 'parser',
    reason: 'a `campaign: morgansfort` string is test DATA, not a file path',
  },
  'test/frontmatter.test.mjs': {
    rule: 'parser',
    reason: 'a `campaign: morgansfort` string is test DATA, not a file path',
  },
  'test/host.test.mjs': {
    rule: 'parser',
    reason: 'reads only its own temp campaign; the live references are the remap pattern, an '
      + 'exempted code-root path, and comments explaining why',
  },
  'scripts/write-tools-scenario.mjs': {
    rule: 'invariant',
    reason: 'writes only to campaigns/stage2-test; hashes the live campaign before and after',
  },
  'scripts/concurrency-scenario.mjs': {
    rule: 'invariant',
    reason: 'writes only to campaigns/stage2-test; hashes the live campaign before and after',
  },
  'scripts/scenario-test.mjs': {
    rule: 'scratch',
    reason: 'writes only to campaigns/stage2-test, the disposable scratch campaign',
  },
  'scripts/refusal-test.mjs': {
    rule: 'scratch',
    reason: 'writes only to campaigns/stage2-test, the disposable scratch campaign',
  },
  'scripts/migrate-test.mjs': {
    rule: 'scratch',
    reason: 'one-off migration driver for campaigns/stage2-test; run manually',
  },
  'scripts/migrate-real.mjs': {
    rule: 'operator',
    reason: 'the deliberate, human-run migration of the live campaign; not part of npm run check',
  },
  'scripts/migrate-real-dryrun.mjs': {
    rule: 'operator',
    reason: 'a dry run that reads the live sheet and cannot write (writeText throws)',
  },
  'scripts/browser-verify.mjs': {
    rule: 'diagnostic',
    reason: 'checks the rendered panel against whatever the live campaign shows; reports PASS/FAIL, '
      + 'does not throw, and is not wired into npm run check',
  },
  'test/write-errors.test.mjs': {
    rule: 'parser',
    reason: 'the live references are sample STRINGS passed to describeWriteRefusal() to pin the '
      + 'wording of a refusal message; the suite writes only to its own mkdtemp tree and a leak '
      + 'guard fails the run if any mock resolves outside it',
  },
  'scripts/audit-test-ownership.mjs': {
    rule: 'self',
    reason: 'this audit; its patterns and allowlist necessarily name the paths it looks for',
  },
}

// --- audit ------------------------------------------------------------------
section('every live-data reference is classified')

const unclassified = []
const usesHelper = new Set()

for (const rel of targets) {
  const text = readFileSync(path.join(root, rel), 'utf8')
  const hits = LIVE_PATTERNS
    .map((re) => text.match(re))
    .filter((m) => m !== null)

  const hasHelperImport = /support\/live-data\.mjs/.test(text)
  if (hasHelperImport) usesHelper.add(rel)

  if (hits.length === 0) continue

  const allowed = ALLOWED[rel]
  if (allowed === undefined) {
    unclassified.push(`${rel} (${hits.length} live reference(s): ${hits.map((h) => h[0]).join(', ')})`)
    continue
  }

  // An invariant test must actually use the shared machinery — otherwise the
  // classification is a claim the file does not back up.
  if (allowed.rule === 'invariant' && !hasHelperImport) {
    unclassified.push(
      `${rel} is classified "invariant" but does not import test/support/live-data.mjs — `
      + 'an unverified invariant classification',
    )
  }
}

for (const rel of Object.keys(ALLOWED)) {
  check(existsSync(path.join(root, rel)), `${rel} exists (allowlist entry is live)`)
}

check(unclassified.length === 0,
  unclassified.length === 0
    ? `all ${targets.length} files audited; every live reference classified`
    : 'unclassified live-data reference(s):\n       - ' + unclassified.join('\n       - '))

// --- no test may read the live campaign as a parser input -------------------
section('no *.test.mjs reads live campaign data as a parser input')

const PARSER_SUITES = [
  'test/sheet-parse.test.mjs',
  'test/sheet-split.test.mjs',
  'test/state-schema.test.mjs',
  'test/frontmatter.test.mjs',
  'test/state-rules.test.mjs',
]

for (const rel of PARSER_SUITES) {
  const text = readFileSync(path.join(root, rel), 'utf8')
  // A parser suite must not construct a live campaign path at all. A bare
  // `campaigns/morgansfort` inside a string is test data (a YAML field), so
  // match only the forms that would reach the filesystem.
  const reachesLive = /D:\/DND\/campaigns/i.test(text)
    || /new URL\([^)]*campaigns\/morgansfort/i.test(text)
    || /['"`][A-Za-z]:[^'"`]*morgansfort[^'"`]*['"`]/.test(text)
  check(!reachesLive,
    `${rel} does not reach into live campaign data`
    + (reachesLive ? ' — a parser test must own its input (use test/fixtures/)' : ''))
}

// --- the fixture is frozen and pinned --------------------------------------
section('the frozen fixture exists and is pinned by digest')

const FIXTURE = 'test/fixtures/alice-unmigrated.md'
check(existsSync(path.join(root, FIXTURE)), `${FIXTURE} exists`)
check(!existsSync(path.join(root, 'test/fixtures/alice.state.json')),
  'no state fixture is smuggled in beside it')

for (const rel of ['test/sheet-parse.test.mjs', 'test/sheet-split.test.mjs']) {
  const text = readFileSync(path.join(root, rel), 'utf8')
  check(/FIXTURE_SHA256\s*=\s*'[0-9a-f]{64}'/.test(text),
    `${rel} pins the fixture digest`)
  check(!/skip real morgansfort/i.test(text),
    `${rel} fails loudly when the fixture is missing instead of skipping`)
}

// --- invariant tests assert properties, not snapshots -----------------------
section('invariant tests assert properties, not campaign snapshots')

// Values that describe ONE campaign at ONE moment. An invariant test must not
// contain them: the campaign is allowed to change.
const SNAPSHOT_VALUE = /\b(?:hp|currency|INT|ac)\s*[:=]\s*\{?\s*(?:current:)?\s*8\b|currency,\s*800|=== *800\b/

/**
 * Slice out the file's LIVE block: the region that actually reaches live data.
 *
 * Anchored on a real code boundary — the `const REAL_DIR =` / `const
 * LIVE_CHAR_DIR =` declaration — not on any prose mention of "the real
 * character", which appears in comments throughout these files and would make
 * the slice start on line 7 and swallow temp-tree assertions.
 */
function liveBlockOf(text) {
  const m = text.match(/^const (?:REAL_DIR|LIVE_CHAR_DIR|LIVE_CAMPAIGN)\s*=/m)
  return m === null ? '' : text.slice(m.index)
}

for (const rel of ['test/state-io.test.mjs', 'test/routes.test.mjs']) {
  const block = liveBlockOf(readFileSync(path.join(root, rel), 'utf8'))
  check(block !== '', `${rel} has a locatable live block`)
  const found = block.match(SNAPSHOT_VALUE)
  check(found === null,
    `${rel}'s live block asserts no campaign snapshot value`
    + (found !== null ? ` — found ${JSON.stringify(found[0])}; a number is allowed to change` : ''))
}

// --- the helper is real ------------------------------------------------------
section('the shared helper provides the invariant machinery')

const helper = readFileSync(path.join(root, 'test/support/live-data.mjs'), 'utf8')
for (const fn of ['hashLivePath', 'snapshotTree', 'diffTree', 'liveWitness', 'liveExists']) {
  check(new RegExp(`export function ${fn}\\b`).test(helper), `helper exports ${fn}()`)
}

check(usesHelper.size >= 2,
  `at least two files use the helper (found ${usesHelper.size}: ${[...usesHelper].join(', ')})`)

console.log('')
if (failures > 0) {
  console.error(`ownership.audit: ${failures} failure(s)`)
  process.exit(1)
}
console.log(`ownership.audit: all assertions passed (${targets.length} files audited)`)
