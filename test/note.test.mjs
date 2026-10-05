/**
 * note.test.mjs — dnd_note (GAP plan, project 6).
 *
 * The write path is read-modify-write under a per-campaign lock, so the suite
 * runs the real tool against a temp-tree fs (session cwd IS the root) and
 * checks the FILE, not just the reply. The corpus-search integration is
 * asserted through the campaign tool's own index: a note the search cannot
 * find is a note that was never written.
 *
 * Rules: docs/harness/GAP-TOOLS-PLAN.md · src/host/tools/note.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}\n       ${error.message.split('\n')[0]}`)
  }
}

const root = mkdtempSync(path.join(tmpdir(), 'dnd-note-')).replace(/\\/g, '/')
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }) } catch { /* gone */ } })
mkdirSync(path.join(root, 'campaigns', 'testcamp', 'characters'), { recursive: true })
mkdirSync(path.join(root, '.runtime'), { recursive: true })
writeFileSync(path.join(root, '.runtime', 'active-campaign.json'), JSON.stringify({ name: 'testcamp' }), 'utf8')
writeFileSync(path.join(root, 'campaigns', 'testcamp', 'state.md'),
  '---\n- **Name**: testcamp\n- **Ruleset**: 2024\n---\n', 'utf8')

const nodePath = (p) => String(p).replace(/\//g, path.sep)
const makeTarget = (d) => ({ targetKey: String(d).toLowerCase(), displayPath: String(d) })
const guard = (p, method) => {
  const norm = String(p).replace(/\\/g, '/')
  if (!norm.startsWith(root)) throw new Error('LEAK: fs.' + method + '() outside the temp tree: ' + norm)
  return norm
}
const fs = {
  async resolve(p) { return makeTarget(guard(p, 'resolve')) },
  async stat(t) { try { const s = statSync(nodePath(guard(String(t.displayPath), 'stat'))); return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs } } catch { return undefined } },
  async readText(t) { return readFileSync(nodePath(guard(String(t.displayPath), 'readText')), 'utf8') },
  async writeText(t, text) { writeFileSync(nodePath(guard(String(t.displayPath), 'writeText')), text, 'utf8') },
  async listDir(t) {
    const real = guard(String(t.displayPath), 'listDir')
    return readdirSync(nodePath(real), { withFileTypes: true }).map((e) => ({ name: e.name, target: makeTarget(guard(real + '/' + e.name, 'listDir')), type: e.isDirectory() ? 'directory' : 'file' }))
  },
}
const ctx = {
  get: (n) => {
    if (n === 'fs') return fs
    if (n === 'sessions') return { get: () => ({ header: { cwd: root } }) }
    if (n === 'sandboxPolicy') return { resolve: ({ session }) => ({ workspaceRoot: session.header.cwd, mode: 'workspace-write', sessionId: 'note-1' }) }
    return undefined
  },
}
const exec = { agent: { id: 'note-1' } }
const { buildTools: buildNote } = await import('../src/host/tools/note.mjs')
const note = buildNote(ctx).find((t) => t.name === 'dnd_note')
const { buildTools: buildCampaign } = await import('../src/host/tools/campaign.mjs')
const search = buildCampaign(ctx).find((t) => t.name === 'dnd_campaign_search')
const logPath = () => nodePath(root + '/campaigns/testcamp/session-log.md')
const readLog = () => readFileSync(logPath(), 'utf8')

await test('a note creates the log file when it does not exist', async () => {
  const out = await note.execute({ kind: 'loot', body: '一只银匕首（价值 20 gp）交给了 Alice。' }, exec)
  assert.match(String(out), /Appended a loot entry/)
  const text = readLog()
  assert.match(text, /^# Session Log — testcamp/, 'a fresh log gets a title')
  assert.match(text, /— loot\n\n一只银匕首/, 'the section heading and body land')
})

await test('a second note appends after the first, both survive', async () => {
  await note.execute({ kind: 'hook', body: '铁匠暗示地下有扇上锁的门。' }, exec)
  const text = readLog()
  assert.match(text, /银匕首/, 'the first entry survives the append')
  assert.match(text, /铁匠暗示/, 'the second entry is present')
  assert.ok(text.indexOf('银匕首') < text.indexOf('铁匠暗示'), 'append order is chronological')
})

await test('the exact same entry is refused as a duplicate, not doubled', async () => {
  const before = readLog()
  const out = await note.execute({ kind: 'hook', body: '铁匠暗示地下有扇上锁的门。' }, exec)
  assert.match(String(out), /Already written/)
  assert.equal(readLog(), before, 'a duplicate writes NOTHING')
})

await test('the same body under a different kind is a NEW entry', async () => {
  const before = readLog()
  const out = await note.execute({ kind: 'recap', body: '铁匠暗示地下有扇上锁的门。' }, exec)
  assert.match(String(out), /Appended/, 'different kind, different section')
  assert.ok(readLog().length > before.length)
})

await test('a note is findable through dnd_campaign_search', async () => {
  const out = await search.execute({ query: '银匕首' }, exec)
  assert.match(String(out), /session-log\.md/, String(out))
})

await test('bad calls are refused before anything is read or written', async () => {
  assert.match(String(await note.execute({}, exec)), /needs `kind`/)
  assert.match(String(await note.execute({ kind: 'loot' }, exec)), /needs a `body`/)
  assert.match(String(await note.execute({ kind: 'gossip', body: 'x' }, exec)), /one of: loot/)
  assert.match(String(await note.execute({ kind: 'loot', body: 'x'.repeat(5000) }, exec)), /under 4000/)
})


// --- non-ASCII bodies must survive the write path byte-for-byte -------------
// The field report said Chinese written by dnd_note came back as '?' garbage.
// The write path itself is UTF-8 end to end (readText/writeText carry strings);
// this test pins that so a future encoding change cannot ship silently.
await test('a Chinese body survives the round trip intact', async () => {
  const body = '【错误报告】中文内容：丧钟自鸣，盐沼的夜。'
  const out = await note.execute({ kind: 'freeform', body }, exec)
  assert.match(out, /Appended a freeform entry/)
  const text = readFileSync(logPath(), 'utf8')
  assert.ok(text.includes(body), 'the body must appear verbatim in session-log.md; file tail was: ' + JSON.stringify(text.slice(-300)))
  // And the corpus search the reply advertises must find it again.
  const search = buildCampaign(ctx).find((t) => t.name === 'dnd_campaign_search')
  const found = await search.execute({ query: '丧钟自鸣' }, exec)
  assert.match(String(found), /match/)
})

console.log(failures === 0 ? 'note.test.mjs: all passed' : `note.test.mjs: ${failures} failure(s)`)
if (failures > 0) process.exit(1)
