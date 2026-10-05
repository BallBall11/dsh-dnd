/**
 * Tests for the client comment stripper.
 *
 * The stripper rewrites the file that ships to the browser, so a mistake here
 * corrupts the bundle in a way no other test would catch — the emitted JS
 * would still be syntactically valid, just wrong. Every case below is one a
 * regex-based stripper gets wrong.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

let failures = 0
function test(name, fn) {
  try {
    fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failures += 1
    console.log('  FAIL ' + name)
    console.log('       ' + (error && error.message ? error.message : error))
  }
}

// The build script runs on import, so the stripper is exercised by building
// and inspecting the artifact rather than by importing a private function.
// That is the stronger check anyway: it verifies what actually ships.
const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')) + '/..'
const bundle = readFileSync(path.join(root, 'lib/client.js'), 'utf8')

test('the shipped bundle contains no block comments', () => {
  assert.ok(!/\/\*/.test(bundle), 'a block comment survived into the bundle')
})

test('the shipped bundle contains no line comments', () => {
  // `//` may legitimately appear inside a string or a URL, so this checks for
  // the shape a comment would take at the start of a line.
  const suspicious = bundle.split('\n').filter((l) => /^\s*\/\//.test(l))
  assert.deepEqual(suspicious, [], 'line comments survived: ' + suspicious.slice(0, 3).join(' | '))
})

test('the bundle is smaller than the sum of its sources', () => {
  const dir = path.join(root, 'src/client')
  let source = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name))
      else if (e.name.endsWith('.js')) source += readFileSync(path.join(d, e.name), 'utf8').length
    }
  }
  walk(dir)
  assert.ok(bundle.length < source,
    `bundle ${bundle.length} should be smaller than sources ${source}, or comments were not stripped`)
})

test('strings containing comment-like text survive', () => {
  // The panel builds URLs and messages; `//` inside a string is not a comment.
  assert.ok(bundle.includes("'/dnd'"), 'the URL string must survive intact')
  assert.ok(!bundle.includes("'\\/dnd'"), 'and must not be mangled')
})

test('the emitted JS still parses', () => {
  // The real check: if the stripper mangled a regex or a string, this throws.
  //
  // Parsed in-process rather than by spawning `node --check`, because the
  // sandbox denies a child process with piped stdio (`spawnSync ... EPERM`).
  // `new Function` performs a full parse of the body without executing it, so
  // it catches exactly what `--check` would.
  const body = bundle
    .replace('window.__ModuleLoader__.load(', 'globalThis.__noop = (')
    .replace(/return module\.exports; \} \}\);$/, '')
  assert.doesNotThrow(() => new Function(body), 'the emitted bundle must be syntactically valid')
})

test('the loader contract survived stripping', () => {
  assert.match(bundle, /window\.__ModuleLoader__\.load\(\{ id: "dsh-dnd"/)
  assert.ok(bundle.trimEnd().endsWith('return module.exports; } });'))
})

test('the fetch call survived stripping', () => {
  // The query rides the same route (the enemy section option), so the literal
  // is the route + query, not the bare path.
  assert.ok(bundle.includes("fetch(DND_API + '/characters?include=enemies'"), 'the request must still be made')
  assert.ok(bundle.includes("cache: 'no-store'"), 'the cache option must survive')
})

console.log('')
if (failures > 0) {
  console.error(`build-strip.test.mjs: ${failures} failure(s)`)
  process.exit(1)
}
console.log('build-strip.test.mjs: all assertions passed')
