/**
 * The client/host route contract.
 *
 * The client hardcodes the route namespace and the Host declares it, in two
 * files that cannot import each other: the client half is a browser bundle
 * that only has `require('react')`, and the Host half is a Node module. A typo
 * on either side would not fail a build — it would show up as an empty panel
 * at runtime, which is the least debuggable kind of failure and the exact
 * shape of the v0.1.0 bug this project exists to undo.
 *
 * So the two are compared here, by reading both sources.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { API_PREFIX, ROUTES } from '../src/host/routes.mjs'

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

const CLIENT_DIR = 'src/client'
// Named `panel`, not `smoke`, and pointing at character.js: the smoke panel was
// deleted in stage 3c and this path used to name it. A stale path here fails
// loudly, but a stale NAME invites the reader to think this file tests
// something other than what it does.
const panel = readFileSync(`${CLIENT_DIR}/panels/character.js`, 'utf8')

test('the client namespace matches the host prefix', () => {
  const m = panel.match(/const DND_API = '([^']+)'/)
  assert.ok(m !== null, 'the client must declare DND_API')
  assert.equal(m[1], API_PREFIX,
    `client says ${m[1]}, host says ${API_PREFIX} — the panel would 404 silently`)
})

test('every client fetch targets a declared host route', () => {
  const declared = ROUTES.map((r) => r.path)
  const calls = [...panel.matchAll(/fetch\(\s*DND_API \+ '([^']+)'/g)].map((m) => API_PREFIX + m[1])
  assert.ok(calls.length > 0, 'expected at least one fetch call')
  for (const call of calls) {
    assert.ok(declared.includes(call),
      `the client fetches ${call}, which the host does not declare. Declared: ${declared.join(', ')}`)
  }
})

test('the client does not use host.call or harness.handle', () => {
  // Defect C: that path needs pluginId + pluginRunId, which a bundle lacks.
  // A v0.1.0 panel was built on it and could never have loaded.
  //
  // Comments are stripped first: this file's own prose names both APIs while
  // explaining why they are unusable, and matching that would make the test
  // fail on its own documentation.
  const code = panel
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/host\.call/.test(code), 'host.call is unavailable to a bundle')
  assert.ok(!/harness\.handle/.test(code), 'harness.handle is unavailable to a bundle')
})

test('the client uses only relative URLs', () => {
  // A relative URL resolves against the page origin, so the panel needs no
  // configuration and works whatever port the profile listens on.
  const calls = [...panel.matchAll(/fetch\(([^)]*)/g)].map((m) => m[1])
  for (const call of calls) {
    assert.ok(!/https?:\/\//.test(call), `absolute URL in a fetch call: ${call}`)
    assert.ok(!/localhost|127\.0\.0\.1/.test(call), `hardcoded origin in a fetch call: ${call}`)
  }
})

test('the client asks for no-store, so numbers cannot go stale', () => {
  assert.match(panel, /cache: 'no-store'/)
})

test('the client sends no credentials and no custom headers', () => {
  // The route is same-origin and the host applies no CSRF fence; adding
  // headers here would imply a contract neither side implements.
  const calls = panel.match(/fetch\([^)]*\)/g) ?? []
  for (const call of calls) {
    assert.ok(!/credentials/.test(call), `unexpected credentials in: ${call}`)
    assert.ok(!/headers/.test(call), `unexpected headers in: ${call}`)
  }
})

test('a fetch failure is caught rather than escaping into render', () => {
  // An unhandled rejection inside a React render surfaces as a blank overlay
  // with the error only in the console.
  //
  // This asserts the PROPERTY (the rejection is handled), not a shape. The
  // earlier version demanded `try { ... await fetch`, which the current panel
  // does not use — it chains .catch() instead, which also covers a rejection
  // from res.json(). Asserting the old shape failed a correct implementation.
  const hasTryAroundFetch = /try \{[\s\S]*?await fetch/.test(panel)
  const hasCatchOnChain = /\.then\([\s\S]*?\.catch\(/.test(panel)
  assert.ok(hasTryAroundFetch || hasCatchOnChain,
    'the fetch rejection must be handled, by try/catch or by .catch() on the chain')
  assert.match(panel, /catch/, 'and the failure must be handled with a catch of some kind')
})

test('the client bundle still declares no ESM syntax', () => {
  // It is pasted inside the loader factory; `export`/`import` would be a
  // syntax error at runtime, not at build time.
  assert.ok(!/^\s*export\s/m.test(panel), 'no export statements in a factory body')
  assert.ok(!/^\s*import\s/m.test(panel), 'no import statements in a factory body')
})

console.log('')
if (failures > 0) {
  console.error(`client-host-contract.test.mjs: ${failures} failure(s)`)
  process.exit(1)
}
console.log('client-host-contract.test.mjs: all assertions passed')
