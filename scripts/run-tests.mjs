/**
 * scripts/run-tests.mjs — discover and run every suite in test/, sequentially.
 *
 * The test script used to be a hand-maintained `&&` chain in package.json:
 * one line naming all suites in a fixed order. The chain and the disk agreed
 * only because someone remembered to keep them agreeing. A new suite that was
 * not appended to the chain was silently never run — not by CI, not by
 * pre-commit, by anyone — no error, no signal. With parallel sessions adding
 * suites, both editing that one line, the drift was a matter of time.
 *
 * This script makes forgetting structurally impossible: it globs
 * `test/*.test.mjs` from disk, sorts the names for a deterministic order
 * across machines, and runs each suite as a child process with inherited
 * stdio, so output streams straight through and each start is announced.
 *
 * Fail-fast semantics match the old chain exactly: the first failing suite
 * stops the run, and its exit code becomes the run's. A suite killed by a
 * signal has no exit code — the runner names the signal in its failure line
 * and stops with exit code 1, rather than report a number the suite never
 * returned.
 *
 * Plain Node ESM, zero dependencies. Paths are built with node:path so the
 * one script is correct on the Windows dev machine and on POSIX CI alike.
 *
 * Usage: node scripts/run-tests.mjs   (usually via `npm test`)
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const testDir = path.join(root, 'test')

const suites = readdirSync(testDir, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.test.mjs'))
  .map((e) => e.name)
  .sort()

if (suites.length === 0) {
  console.error('run-tests: no suite found in test/*.test.mjs')
  process.exit(1)
}

console.log(`run-tests: ${suites.length} suite(s) discovered in test/`)

for (const name of suites) {
  const suitePath = path.join(testDir, name)
  console.log(`\n--- node test/${name} ---`)
  const result = spawnSync(process.execPath, [suitePath], { stdio: 'inherit' })
  if (result.status !== 0) {
    if (result.status === null) {
      console.error(
        `\nrun-tests: test/${name} exited with signal ${result.signal ?? 'unknown'} — stopping.`,
      )
      process.exit(1)
    }
    console.error(`\nrun-tests: test/${name} exited with code ${result.status} — stopping.`)
    process.exit(result.status)
  }
}

console.log(`\nrun-tests: all ${suites.length} suite(s) passed`)
