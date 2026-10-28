/**
 * audit-paths — two source-hygiene audits over the repo's own files.
 *
 * 1. No machine-specific paths in the production surface.
 *
 * The bundle resolves every data root from the live session workspace (or the
 * DND_ROOT / DSH_CWD env chain). A drive-letter path committed anywhere in the
 * production surface reintroduces the "works only on one machine" failure this
 * project has hit twice: the old hard-coded D:/DND root, and the panel that
 * served another workspace's campaign from the process fallback.
 *
 * 2. No mojibake anywhere in the source trees.
 *
 * src/, scripts/ and test/ are scanned for the known mojibake code points
 * (U+9225, U+951F) — the residue of UTF-8 text misread as GBK in a
 * Windows-encoding incident. Mojibake in comments defeats every exact-match
 * edit and every grep (one such incident seeded three files and forced regex
 * workarounds on the next editor), so the gate refuses it outright rather
 * than waiting for the next victim. The patterns are written as \u escapes:
 * spelling them out literally would put the scan's own target back into the
 * one file that must stay clean.
 *
 * Scope: the path audit covers the PRODUCTION surface — src/, cordis.patch.yml
 * and README.md, what a host or client actually executes or quotes; test/ and
 * scripts/ may use synthetic Windows-looking roots (they remap into temp trees
 * and guard against leaks), so they are exempt there. The single legacy
 * 'D:/DND' literal in shared.mjs is allowlisted: it is the documented
 * last-resort default of the env chain, pending a config surface, and it is
 * flagged with a comment there. The mojibake scan covers every .mjs/.js under
 * src/, scripts/ and test/ — comments and string literals alike.
 *
 * Run: node scripts/audit-paths.mjs
 *
 * ## Falsifiability (one-time evidence, 2026-10-28)
 *
 * The mojibake scan landed on the DIRTY tree and failed before the cleanup
 * ran — the natural mutation, stronger than an injection:
 *
 *   audit-paths: mojibake committed in source:
 *   <40 hits, all the misread em-dash shape>
 *   src/host/tools/effects.mjs — 19, test/effects-rules.test.mjs — 6,
 *   test/encounter-effects.test.mjs — 15   (exit 1)
 *
 * It also caught the freshest mojibake in the repo on its own first draft:
 * this header originally spelled the patterns out literally and the scan
 * flagged the scanner. The cleanup in the same change turned the tree green —
 * the scanner demonstrably bites, proven by the very defect it exists to
 * prevent. The path audit's evidence predates this header; its live specimen
 * is the allowlisted 'D:/DND' literal in shared.mjs.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
// A drive-letter path at a token boundary: the character before the drive
// letter must not be a word character (so regex fragments like `sections:\n`
// or `HP:\d+` do not match), and something path-like must follow the slash.
const DRIVE_LETTER = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/](?=[\w.])/
const MOJIBAKE = /[\u9225\u951f]/
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

// Path-audit scope: the PRODUCTION surface — what the host/client executes or
// quotes. test/ and scripts/ are dev-side: they remap synthetic roots into
// temp trees and guard against leaks, so a Windows-looking literal there is a
// fixture, not a machine dependency.
const pathTargets = []
for (const file of walk(path.join(ROOT, 'src'))) {
  if (file.endsWith('.mjs')) pathTargets.push(file)
}
pathTargets.push(path.join(ROOT, 'cordis.patch.yml'), path.join(ROOT, 'README.md'))

const pathFailures = []
for (const file of pathTargets) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  if (ALLOWLIST.has(rel)) continue
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    if (DRIVE_LETTER.test(line)) pathFailures.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`)
  })
}

// Mojibake scope: every JS source the repo owns, comments included.
const mojibakeTargets = []
for (const dir of ['src', 'scripts', 'test']) {
  for (const file of walk(path.join(ROOT, dir))) {
    if (file.endsWith('.mjs') || file.endsWith('.js')) mojibakeTargets.push(file)
  }
}

const mojibakeFailures = []
for (const file of mojibakeTargets) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    if (MOJIBAKE.test(line)) mojibakeFailures.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`)
  })
}

if (pathFailures.length > 0) {
  console.log('audit-paths: machine-specific path(s) committed:\n' + pathFailures.join('\n'))
  console.log('\nConvention: production code must not encode machine paths. Resolve roots from')
  console.log('the session workspace or the DND_ROOT / DSH_CWD env chain (see src/host/tools/shared.mjs).')
}

if (mojibakeFailures.length > 0) {
  console.log('audit-paths: mojibake committed in source:\n' + mojibakeFailures.join('\n'))
  console.log('\nConvention: mojibake (UTF-8 misread as GBK; code points U+9225 / U+951F) defeats')
  console.log('exact-match edits and greps. Restore the intended characters (U+9225 followed by')
  console.log('"?" is a misread em-dash + space): fix the text, do not teach tools to match corruption.')
}

if (pathFailures.length > 0 || mojibakeFailures.length > 0) {
  process.exitCode = 1
} else {
  console.log('audit-paths: production surface clean (no machine paths, no mojibake)')
}
