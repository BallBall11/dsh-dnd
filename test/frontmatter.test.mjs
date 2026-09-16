/**
 * frontmatter tests.
 *
 * The failure mode that matters here is data loss. Frontmatter sits at the top
 * of a file whose body is hand-written prose, so a parser that mangles or
 * swallows the header risks the whole document. Every case below is really
 * asking one question: does the input come back intact?
 */
import assert from 'node:assert/strict'
import {
  parseFrontmatter,
  renderFrontmatter,
  writeFrontmatter,
} from '../src/host/tools/frontmatter.mjs'

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

const DOC = `---
player: —
campaign: morgansfort
updated: 2026-09-04
worldTime: 2 Thawmonth 1247 AR, 08:00
tags: [pc]
---

# Alice
## Backstory & Notes
- prose here
`

// --- parsing --------------------------------------------------------------
test('parses a block and separates the body', () => {
  const { data, body, present } = parseFrontmatter(DOC)
  assert.equal(present, true)
  assert.equal(data.campaign, 'morgansfort')
  assert.ok(body.includes('# Alice'))
  assert.ok(body.includes('- prose here'))
})

test('a date stays a string', () => {
  const { data } = parseFrontmatter(DOC)
  assert.equal(data.updated, '2026-09-04')
  assert.equal(typeof data.updated, 'string', 'a date must not be coerced to a number')
})

test('an in-world date with spaces and a comma stays one string', () => {
  const { data } = parseFrontmatter(DOC)
  assert.equal(data.worldTime, '2 Thawmonth 1247 AR, 08:00')
})

test('an inline list parses', () => {
  const { data } = parseFrontmatter(DOC)
  assert.deepEqual(data.tags, ['pc'])
})

test('a block list parses', () => {
  const { data } = parseFrontmatter(`---
tags:
  - pc
  - wizard
---
body
`)
  assert.deepEqual(data.tags, ['pc', 'wizard'])
})

test('a bare number still becomes a number', () => {
  const { data } = parseFrontmatter('---\nlevel: 3\n---\nx\n')
  assert.equal(data.level, 3)
  assert.equal(typeof data.level, 'number')
})

test('booleans parse', () => {
  const { data } = parseFrontmatter('---\nalive: true\ndead: false\n---\nx\n')
  assert.equal(data.alive, true)
  assert.equal(data.dead, false)
})

test('a quoted value keeps its spaces and punctuation', () => {
  const { data } = parseFrontmatter('---\nplayer: "Sam, the Bold"\n---\nx\n')
  assert.equal(data.player, 'Sam, the Bold')
})

test('comments and blank lines are skipped', () => {
  const { data } = parseFrontmatter('---\n# a comment\n\ncampaign: x\n---\nbody\n')
  assert.equal(data.campaign, 'x')
})

test('no frontmatter leaves the document whole', () => {
  const plain = '# Alice\n## Notes\n- x\n'
  const { data, body, present } = parseFrontmatter(plain)
  assert.equal(present, false)
  assert.deepEqual(data, {})
  assert.equal(body, plain, 'a file without frontmatter must be returned unchanged')
})

test('an unterminated block is treated as body, not swallowed', () => {
  // Losing the top of a document because a closing fence was forgotten would
  // be far worse than failing to parse the header.
  const broken = '---\ncampaign: x\n\n# Alice\n- prose\n'
  const { present, body, warnings } = parseFrontmatter(broken)
  assert.equal(present, false)
  assert.equal(body, broken, 'the document must survive intact')
  assert.ok(warnings.length > 0, 'the problem must be reported')
})

test('an empty block parses to no data', () => {
  const { data, present } = parseFrontmatter('---\n---\nbody\n')
  assert.equal(present, true)
  assert.deepEqual(data, {})
})

test('a BOM before the fence does not break parsing', () => {
  const { data, present } = parseFrontmatter('\uFEFF---\ncampaign: x\n---\nbody\n')
  assert.equal(present, true)
  assert.equal(data.campaign, 'x')
})

// --- rendering ------------------------------------------------------------
test('renders a block with both fences', () => {
  const out = renderFrontmatter({ campaign: 'x' })
  assert.ok(out.startsWith('---\n'))
  assert.ok(out.trimEnd().endsWith('---'))
})

test('renders keys in the requested order', () => {
  const out = renderFrontmatter({ tags: ['pc'], campaign: 'x', updated: '2026-09-04' },
    ['campaign', 'updated', 'tags'])
  const lines = out.split('\n')
  assert.equal(lines[1], 'campaign: x')
  assert.equal(lines[2], 'updated: 2026-09-04')
  assert.equal(lines[3], 'tags: [pc]')
})

test('rendering is deterministic', () => {
  const data = { campaign: 'x', updated: '2026-09-04', tags: ['pc'] }
  assert.equal(renderFrontmatter(data, ['campaign', 'updated', 'tags']),
    renderFrontmatter(data, ['campaign', 'updated', 'tags']))
})

test('an empty object renders nothing at all', () => {
  // A bare `---\n---` would swallow the document on the next read.
  assert.equal(renderFrontmatter({}), '')
  assert.equal(renderFrontmatter(null), '')
})

test('values needing quotes get them', () => {
  const out = renderFrontmatter({ player: 'true', campaign: '3', name: '"quoted"' })
  assert.ok(out.includes('player: "true"'), out)
  assert.ok(out.includes('campaign: "3"'), out)
  assert.ok(out.includes('name: "\\"quoted\\""'), out)
})

test('a comma inside a plain scalar needs no quotes', () => {
  // YAML treats `,` as structure only inside a flow collection (`[...]` or
  // `{...}`). As a top-level plain scalar, `Sam, the Bold` is unambiguous.
  const out = renderFrontmatter({ name: 'Sam, the Bold' })
  assert.ok(out.includes('name: Sam, the Bold'), out)
  const { data } = parseFrontmatter(out + '\nbody\n')
  assert.equal(data.name, 'Sam, the Bold')
})

test('plain values stay unquoted for readability', () => {
  const out = renderFrontmatter({ campaign: 'morgansfort' })
  assert.ok(out.includes('campaign: morgansfort'), out)
})

// --- round trips ----------------------------------------------------------
test('render -> parse round-trips', () => {
  const data = { player: '—', campaign: 'morgansfort', updated: '2026-09-04', worldTime: '2 Thawmonth 1247 AR, 08:00', tags: ['pc'] }
  const { data: back } = parseFrontmatter(renderFrontmatter(data, ['player', 'campaign', 'updated', 'worldTime', 'tags']) + '\nbody\n')
  assert.deepEqual(back, data)
})

test('CJK values round-trip', () => {
  const { data } = parseFrontmatter(renderFrontmatter({ player: '贤者' }) + '\nbody\n')
  assert.equal(data.player, '贤者')
})

test('writeFrontmatter replaces an existing block', () => {
  const out = writeFrontmatter(DOC, { campaign: 'other' })
  assert.ok(out.includes('campaign: other'))
  assert.ok(!out.includes('morgansfort'), 'the old block must be replaced, not appended')
  assert.equal(out.split('---').length - 1, 2, 'exactly one block')
})

test('writeFrontmatter prepends to a file with no block', () => {
  const out = writeFrontmatter('# Alice\n- prose\n', { campaign: 'x' })
  assert.ok(out.startsWith('---\n'))
  assert.ok(out.includes('# Alice'), 'the body must be kept')
  assert.ok(out.includes('- prose'))
})

test('writeFrontmatter preserves the body exactly', () => {
  const plain = '# Alice\n## Notes\n- a line\n- another\n'
  const out = writeFrontmatter(plain, { campaign: 'x' })
  const { body } = parseFrontmatter(out)
  // The body is what follows the blank line after the closing fence, so it
  // comes back with the newline that separated it still attached.
  assert.equal(body.replace(/^\n/, ''), plain, 'the prose must be byte-identical')
})

test('writeFrontmatter is idempotent', () => {
  const once = writeFrontmatter(DOC, { campaign: 'x', updated: '2026-09-04' }, ['campaign', 'updated'])
  const twice = writeFrontmatter(once, { campaign: 'x', updated: '2026-09-04' }, ['campaign', 'updated'])
  assert.equal(once, twice)
})

console.log('')
if (failures > 0) {
  console.error(`frontmatter.test.mjs: ${failures} failure(s)`)
  process.exit(1)
}
console.log('frontmatter.test.mjs: all assertions passed')
