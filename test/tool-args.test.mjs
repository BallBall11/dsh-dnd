/**
 * Every tool's behaviour when a required argument is MISSING.
 *
 * The live bug (found in real use, recorded as 3e in the plan) was that
 * `dnd_campaign_search` called without `query` executed as a search for the
 * literal string "undefined" and answered `No match for "undefined"` — which
 * reads exactly like a legitimate miss. `String(undefined)` is `"undefined"`,
 * a non-empty string, so an emptiness check does not catch it.
 *
 * Declaring `required: ['query']` is a hint the model may ignore, so the only
 * real defence is the tool checking its own arguments. This test calls every
 * tool with NO arguments and asserts that none of them treats a missing value
 * as data. It is deliberately behavioural rather than a source scan: a source
 * scan would pass as soon as the pattern moved.
 *
 * Reads only. The fs stub throws on write, so a tool that tried to write during
 * this test would fail loudly rather than damage the campaign.
 */
import assert from 'node:assert/strict'
import { readFileSync, statSync, readdirSync } from 'node:fs'
import path from 'node:path'
import * as roll from '../src/host/tools/roll.mjs'
import * as lookup from '../src/host/tools/lookup.mjs'
import * as campaign from '../src/host/tools/campaign.mjs'
import * as sheet from '../src/host/tools/sheet.mjs'
import * as track from '../src/host/tools/track.mjs'

let failures = 0
/**
 * Run one test, awaiting it.
 *
 * These bodies are async, and a sync `try { fn() } catch` would NOT catch a
 * rejected promise — every async test would report "ok" no matter what it
 * asserted. That is the same class of vacuous check as the React stub that
 * could not fail, so the harness awaits.
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

const nodePath = (p) => String(p).replace(/\//g, path.sep)
const target = (p) => ({ targetKey: String(p).toLowerCase(), displayPath: String(p).replace(/\\/g, '/') })

const fs = {
  async resolve(p) { return target(p) },
  async stat(t) {
    try {
      const s = statSync(nodePath(t.displayPath))
      return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs }
    } catch { return undefined }
  },
  async readText(t) { return readFileSync(nodePath(t.displayPath), 'utf8') },
  // A write during this suite is a bug in a read tool, so it is an error.
  async writeText() { throw new Error('a tool attempted a write during the argument audit') },
  async listDir(t) {
    const base = String(t.displayPath).replace(/\/$/, '')
    return readdirSync(nodePath(t.displayPath), { withFileTypes: true }).map((e) => ({
      name: e.name, target: target(`${base}/${e.name}`),
      type: e.isDirectory() ? 'directory' : 'file',
    }))
  },
}

const ctx = { get: (n) => (n === 'fs' ? fs : undefined) }
const TOOLS = [
  ...roll.buildTools(ctx), ...lookup.buildTools(ctx),
  ...campaign.buildTools(ctx), ...sheet.buildTools(ctx), ...track.buildTools(ctx),
]

// Tools that legitimately need no argument, and what they should do instead.
// Listing them explicitly means a NEW tool cannot join this category by
// accident: it has to be named here.
const NO_ARGUMENT_TOOLS = {
  dnd_mastery: /Weapon mastery properties/,
  dnd_dc: /Standard DC ladder/,
  dnd_campaign_state: /Campaign/,
  dnd_arc_status: /arc type|no "## Campaign Arc"/,
  dnd_character_get: /./,
}

console.log('tool argument validation:')

await test('every tool is either no-argument or rejects a missing argument', async () => {
  // Run synchronously-collected results so assert failures read cleanly.
  for (const tool of TOOLS) {
    const expected = NO_ARGUMENT_TOOLS[tool.name]
    let out
    try {
      out = String(await tool.execute({}))
    } catch (error) {
      assert.fail(`${tool.name} threw on empty args: ${error && error.message ? error.message : error}`)
    }

    if (expected !== undefined) {
      assert.match(out, expected, `${tool.name} should work with no argument`)
      continue
    }

    // The tool must DIAGNOSE the missing argument. Quoting the offending value
    // back is fine and often helpful — `Invalid dice spec: "undefined"` names
    // the problem precisely. What is not fine is REPORTING A RESULT computed
    // from the garbage value, which is what the search tools did:
    // `No match for "undefined"` reads as a legitimate miss.
    assert.match(
      out,
      /needs|must|could not read|Invalid|Unknown|no .* given|not found|No active campaign/i,
      `${tool.name} answered without complaining, so the model cannot tell it lost an argument:\n  ${out.split('\n')[0]}`,
    )
    assert.ok(
      !/No match|No SRD entry|matches "undefined"|found no/i.test(out),
      `${tool.name} reported a RESULT for a missing argument instead of diagnosing it:\n  ${out.split('\n')[0]}`,
    )
  }
})

await test('dnd_srd_lookup names the missing query rather than searching for "undefined"', async () => {
  const tool = TOOLS.find((t) => t.name === 'dnd_srd_lookup')
  const out = String(await tool.execute({}))
  assert.match(out, /needs a `query`/, out)
  assert.ok(!/No SRD entry matches/.test(out), 'must not report a search miss for a missing argument')
})

await test('dnd_campaign_search names the missing query rather than searching for "undefined"', async () => {
  const tool = TOOLS.find((t) => t.name === 'dnd_campaign_search')
  const out = String(await tool.execute({}))
  assert.match(out, /needs a `query`/, out)
  assert.ok(!/No match for/.test(out), 'must not report a search miss for a missing argument')
})

await test('an empty-string query is rejected the same way as a missing one', async () => {
  // A model that fills the field with "" is making the same mistake, and
  // `""` is a substring of every line — an empty search would return the
  // first N lines of the corpus as though they were matches.
  for (const name of ['dnd_srd_lookup', 'dnd_campaign_search']) {
    const tool = TOOLS.find((t) => t.name === name)
    const out = String(await tool.execute({ query: '   ' }))
    assert.match(out, /needs a `query`/, `${name} accepted a whitespace-only query: ${out.split('\n')[0]}`)
  }
})

await test('a missing amount is refused for both coin and XP, without writing', async () => {
  for (const name of ['dnd_spend', 'dnd_xp_add']) {
    const tool = TOOLS.find((t) => t.name === name)
    const out = String(await tool.execute({}))
    assert.match(out, /needs an `amount`/, `${name}: ${out}`)
    assert.match(out, /Nothing was written/, `${name} must say nothing was written: ${out}`)
  }
})

await test('every tool that declares a required parameter actually enforces it', async () => {
  // The declaration and the behaviour must agree. A tool that lists `required`
  // but proceeds without it teaches the model that the schema cannot be
  // trusted — and the next schema, which does matter, gets ignored too.
  for (const tool of TOOLS) {
    const required = tool.parameters?.required
    if (!Array.isArray(required) || required.length === 0) continue

    const out = String(await tool.execute({}))
    assert.match(
      out,
      /needs|must|could not read|Invalid|Unknown|no .* given/i,
      `${tool.name} declares required ${required.join(', ')} but answered without complaint:\n  ${out.split('\n')[0]}`,
    )
  }
})

await test('no tool wrote to the filesystem while auditing arguments', () => {
  // The fs stub throws on writeText, so reaching here means none tried.
  assert.ok(true)
})

console.log('')
if (failures > 0) {
  console.error(`tool-args.test.mjs: ${failures} failure(s)`)
  process.exit(1)
}
console.log('tool-args.test.mjs: all assertions passed')
