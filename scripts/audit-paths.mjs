/**
 * audit-paths — enforce the no-machine-specific-paths convention.
 *
 * The bundle resolves every data root from the live session workspace (or the
 * DND_ROOT / DSH_CWD env chain). A drive-letter path committed anywhere in the
 * production surface reintroduces the "works only on one machine" failure this
 * project has hit twice: the old hard-coded D:/DND root, and the panel that
 * served another workspace's campaign from the process fallback.
 *
 * Scope: src/, cordis.patch.yml and README.md — the surfaces a host or client
 * actually executes or quotes. test/ and scripts/ may use synthetic Windows
 *-looking roots (they remap into temp trees and guard against leaks), so they
 * are exempt. The single legacy 'D:/DND' literal in shared.mjs is allowlisted:
 * it is the documented last-resort default of the env chain, pending a config
 * surface, and it is flagged with a comment there.
 *
 * Run: node scripts/audit-paths.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
// A drive-letter path at a token boundary: the character before the drive
// letter must not be a word character (so regex fragments like `sections:\n`
// or `HP:\d+` do not match), and something path-like must follow the slash.
const DRIVE_LETTER = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/](?=[\w.])/
const ALLOWLIST = new Set([
  'src/host/tools/shared.mjs',
])

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) yield* walk(full)
    else yield full
  }
}

// Scope: the PRODUCTION surface — what the host/client executes or quotes.
// test/ and scripts/ are dev-side: they remap synthetic roots into temp trees
// and guard against leaks, so a Windows-looking literal there is a fixture,
// not a machine dependency.
const targets = []
for (const file of walk(path.join(ROOT, 'src'))) {
  if (file.endsWith('.mjs')) targets.push(file)
}
targets.push(path.join(ROOT, 'cordis.patch.yml'), path.join(ROOT, 'README.md'))

const failures = []
for (const file of targets) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  if (ALLOWLIST.has(rel)) continue
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    if (DRIVE_LETTER.test(line)) failures.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`)
  })
}

if (failures.length > 0) {
  console.log('audit-paths: machine-specific path(s) committed:\n' + failures.join('\n'))
  console.log('\nConvention: production code must not encode machine paths. Resolve roots from')
  console.log('the session workspace or the DND_ROOT / DSH_CWD env chain (see src/host/tools/shared.mjs).')
  process.exitCode = 1
} else {
  console.log('audit-paths: no machine-specific paths in the production surface')
}
