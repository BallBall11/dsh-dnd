/**
 * audit-syntax — the gate's first step: `node --check` over every JS file the
 * repo owns, so a half-applied edit goes red in seconds, before build or any
 * suite runs. This is a plain-JS repo: no ESLint, no typecheck — without this
 * audit, a truncated edit surfaces as a runtime import failure (which is
 * exactly how one half-applied edit shipped before this gate existed).
 *
 * Scope: every `.mjs` under src/, scripts/ and test/, plus the client
 * fragments (`src/client/**.js`). The client half is NOT ordinary ESM: each
 * fragment is a factory BODY that build.mjs wraps as `(function(){...})()`
 * and concatenates into lib/client.js — its top-level `return` is the
 * contract (see src/client/index.js). Bare `node --check` would misread it
 * as CommonJS, and even as ESM would reject the contract-legal `return`. So
 * fragments are parsed inside the same wrap the build applies — a PLAIN
 * function, matching scripts/build.mjs. Top-level `await` therefore fails
 * here, as it should: the shipped program would throw at load time.
 *
 * Run: node scripts/audit-syntax.mjs   (wired as the FIRST step of `npm run check`)
 *
 * ## Falsifiability (one-time evidence, 2026-10-28)
 *
 * Injected `const {{{` at the end of scripts/watch.mjs, then ran this audit:
 *
 *   audit-syntax: 1 file(s) failed the syntax check:
 *
 *   scripts/watch.mjs
 *       [stdin]:17
 *       const {{{
 *              ^
 *
 *   (exit 1)
 *
 * Reverted with `git checkout -- scripts/watch.mjs`: exit 0, 90 files green.
 * A scanner that cannot be made to fail proves nothing; this one demonstrably
 * bites. The gate is its test — no permanent self-test suite.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// Rel paths allowed to fail the check. Empty by design; if a file ever must
// carry deliberately-invalid syntax, add it here WITH the reason on the line.
const ALLOWLIST = new Set()

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else yield full
  }
}

// Every JS file the repo owns. `lib/` is build output, not a source.
const files = []
for (const dir of ['src', 'scripts', 'test']) {
  for (const file of walk(path.join(ROOT, dir))) {
    if (file.endsWith('.mjs') || file.endsWith('.js')) files.push(file)
  }
}

/**
 * The text to parse for one file. Client fragments get the build's own
 * wrapper — a plain function, exactly as scripts/build.mjs wraps them; the
 * opening brace shares the body's first line so `[stdin]` line numbers in an
 * error still match the file's.
 */
function checkInput(file) {
  const text = readFileSync(file, 'utf8')
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  if (rel.startsWith('src/client/') && rel.endsWith('.js')) {
    return `(function () {` + text + `\n})`
  }
  return text
}

const failures = []
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  if (ALLOWLIST.has(rel)) continue
  const result = spawnSync(process.execPath, ['--check', '--input-type=module'], {
    input: checkInput(file),
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    const detail = (result.stderr || 'no stderr').trim().split('\n').slice(0, 4).join('\n    ')
    failures.push(`${rel}\n    ${detail}`)
  }
}

if (failures.length > 0) {
  console.log(`audit-syntax: ${failures.length} file(s) failed the syntax check:\n\n${failures.join('\n\n')}`)
  console.log('\nFix the file (this is usually a half-applied edit) or, if the file must stay')
  console.log('unparseable, add an explicit allowlist entry here with a reason.')
  process.exitCode = 1
} else {
  console.log(`audit-syntax: ${files.length} JS files parse clean`)
}
