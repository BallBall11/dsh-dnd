/**
 * build.test.mjs — the stage-0 acceptance gate for the emitted client half.
 *
 * v0.1.0 shipped a lib/client.js that was plain ESM, so the loader reported
 * "loaded without registering dsh-dnd via __ModuleLoader__.load" and the whole
 * plugin silently contributed nothing. Nothing in the repo caught it, because
 * nothing asserted the *artifact's* shape — only the source parser had tests.
 *
 * This test asserts the artifact directly, and fails the build rather than
 * letting a non-registering bundle reach a profile again.
 */
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const clientPath = new URL('../lib/client.js', import.meta.url)

try {
  await access(clientPath)
} catch {
  console.error('build.test.mjs: lib/client.js is missing — run `npm run build` first')
  process.exit(1)
}
const source = await readFile(clientPath, 'utf8')

// --- the registration contract -------------------------------------------
// The id must equal the package name: the loader matches it against the graph
// row, and a mismatch registers under a name the row never looks for.
const expectedOpen = `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`
assert.ok(
  source.startsWith(expectedOpen),
  `client.js must OPEN with the loader banner.\n  expected: ${expectedOpen}\n  actual:   ${source.slice(0, 120)}`,
)

assert.ok(
  source.trimEnd().endsWith('return module.exports; } });'),
  'client.js must END with the factory footer `return module.exports; } });`',
)

assert.ok(
  source.includes('var module = { exports: {} }; var exports = module.exports;'),
  'client.js must inject the CJS shim (`intro`) before the module body',
)

// --- it must not still be an ES module ------------------------------------
// This is precisely the v0.1.0 defect: export/import syntax left in place,
// which the loader evaluates as a script and therefore registers nothing.
for (const [label, re] of [
  ['`export const`', /\bexport\s+const\b/],
  ['`export function`', /\bexport\s+function\b/],
  ['`export {`', /\bexport\s*\{/],
  ['a top-level `import`', /^\s*import\s.+from\s/m],
]) {
  assert.ok(!re.test(source), `client.js still contains ESM syntax: ${label}`)
}

// --- the React dependency comes from the module table ---------------------
// `react` is a Platform module, so require('react') is answered by the loader.
// A bare global `React` (the dynamic-plugin contract) would be undefined here.
assert.ok(
  source.includes("require('react')") || source.includes('require("react")'),
  "client.js must obtain React through require('react') (the loader module table), not a bare global",
)

// --- we must actually register something ----------------------------------
assert.ok(
  source.includes('sidebar.footer.action'),
  'client.js should register into sidebar.footer.action (the stage-0 acceptance target)',
)
assert.ok(
  source.includes('shell.overlay'),
  'client.js should register into shell.overlay',
)

// --- the host half --------------------------------------------------------
const hostPath = new URL('../lib/host/index.mjs', import.meta.url)
await access(hostPath)
const host = await readFile(hostPath, 'utf8')
assert.ok(
  /export\s+function\s+apply/.test(host),
  'lib/host/index.mjs must export `apply`',
)
assert.ok(
  /export\s+const\s+inject\s*=/.test(host),
  'lib/host/index.mjs must export `inject`',
)

// --- the patch row names the package, not a path --------------------------
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
assert.ok(
  new RegExp(`name:\\s*${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(patch),
  `cordis.patch.yml must mount the row by bare package name (${pkg.name})`,
)
assert.ok(
  !/name:\s*\.\//.test(patch),
  'cordis.patch.yml must not mount by relative path (./lib/...)',
)

console.log('build.test.mjs: all assertions passed')
console.log('  client.js:', source.length, 'bytes')
console.log('  plugin id:', pkg.name)
