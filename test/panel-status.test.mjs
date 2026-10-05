/**
 * panel-status tests.
 *
 * dnd_panel_status exists because the panel's data-root resolution (routeRoot:
 * the most recently opened live session's workspace) can surprise you when
 * several dsh sessions are alive, and the panel itself cannot say so — it just
 * looks healthy. These tests pin the three observable behaviors:
 *
 *   1. the tool reports the ROUTE's root (the live-session resolution), not
 *      the calling session's, and flags a mismatch between the two;
 *   2. it names the active campaign and every character with headline numbers;
 *   3. it reads only — the campaign tree must be byte-identical afterwards.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { buildTools } from '../src/host/tools/panel.mjs'
import { writeCharacter } from '../src/host/tools/state-io.mjs'
process.env.DND_ROOT ??= 'D:/DND' // direct execute() calls have no session; the env root is the explicit config

async function test(name, fn) {
  try {
    await fn()
    console.log('  ok ' + name)
  } catch (error) {
    console.log('  FAIL ' + name)
    console.log('       ' + (error && error.message ? error.message.split('\n')[0] : error))
    process.exitCode = 1
  }
}

const tempRoot = mkdtempSync(path.join(tmpdir(), 'dnd-panel-')).replace(/\\/g, '/')
process.on('exit', () => { try { rmSync(tempRoot, { recursive: true, force: true }) } catch { /* gone */ } })

mkdirSync(path.join(tempRoot, 'campaigns', 'testcamp', 'characters'), { recursive: true })
mkdirSync(path.join(tempRoot, '.runtime'), { recursive: true })
writeFileSync(path.join(tempRoot, '.runtime', 'active-campaign.json'), JSON.stringify({ name: 'testcamp' }), 'utf8')

const guard = (p, method) => {
  const norm = String(p).replace(/\\/g, '/')
  if (!norm.startsWith(tempRoot)) throw new Error('LEAK: fs.' + method + '() outside the temp tree: ' + norm)
  return norm
}
const nodePath = (p) => String(p).replace(/\//g, path.sep)
const makeTarget = (displayPath) => ({ targetKey: String(displayPath).toLowerCase(), displayPath: String(displayPath) })

const fs = {
  async resolve(p) { return makeTarget(guard(p, 'resolve')) },
  async stat(t) {
    const real = guard(String(t.displayPath), 'stat')
    try { const s = statSync(nodePath(real)); return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs } } catch { return undefined }
  },
  async readText(t) { return readFileSync(nodePath(guard(String(t.displayPath), 'readText')), 'utf8') },
  async writeText(t, text) { writeFileSync(nodePath(guard(String(t.displayPath), 'writeText')), text, 'utf8') },
  async listDir(t) {
    const real = guard(String(t.displayPath), 'listDir')
    return readdirSync(nodePath(real), { withFileTypes: true }).map((e) => ({
      name: e.name, target: makeTarget(guard(real + '/' + e.name, 'listDir')), type: e.isDirectory() ? 'directory' : 'file',
    }))
  },
}

/** The route side resolves from the session store's list(). */
const OTHER_WORKSPACE = 'D:/DND'
const ctx = {
  get: (n) => {
    if (n === 'fs') return fs
    if (n === 'sessions') {
      return {
        list: () => [
          { header: { cwd: OTHER_WORKSPACE } },
          { header: { cwd: tempRoot } },
        ],
      }
    }
    return undefined
  },
}
const exec = { agent: { id: 'session-1' } }

await test('a campaign with one character reports root, campaign and numbers', async () => {
  const written = await writeCharacter(fs, tempRoot + '/campaigns/testcamp/characters', 'alice', {
    state: {
      name: 'Alice',
      identity: { level: 1 },
      abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
      combat: { hp: { current: 8, max: 8 }, tempHp: 0, ac: 12, initiative: 0, speed: 30 },
      currency: 800,
    },
    narrative: '',
    campaign: 'testcamp',
  })
  assert.equal(written.refused, false, JSON.stringify(written))

  const tool = buildTools(ctx).find((x) => x.name === 'dnd_panel_status')
  const out = await tool.execute({}, exec)
  assert.match(out, /Active campaign: testcamp/)
  assert.match(out, /- alice: HP 8\/8, AC 12, 8 gp/)
})

await test('a calling session on a DIFFERENT workspace is flagged, not hidden', async () => {
  const sessionCtx = {
    get: (n) => {
      if (n === 'fs') return fs
      if (n === 'sessions') {
        return {
          get: () => ({ header: { cwd: OTHER_WORKSPACE } }),
          list: () => [{ header: { cwd: OTHER_WORKSPACE } }, { header: { cwd: tempRoot } }],
        }
      }
      return undefined
    },
  }
  const tool = buildTools(sessionCtx).find((x) => x.name === 'dnd_panel_status')
  const out = await tool.execute({}, exec)
  assert.match(out, /NOTE: the calling session workspace/)
  assert.match(out, /differs from the panel/)
})

await test('the tool is a pure read of the campaign tree', async () => {
  const hash = (dir) => {
    const h = createHash('sha256')
    for (const entry of readdirSync(dir, { recursive: true }).sort()) {
      const full = path.join(dir, entry)
      try { if (statSync(full).isFile()) h.update(entry + readFileSync(full)) } catch { /* dir */ }
    }
    return h.digest('hex')
  }
  const before = hash(tempRoot)
  const tool = buildTools(ctx).find((x) => x.name === 'dnd_panel_status')
  await tool.execute({}, exec)
  assert.equal(hash(tempRoot), before, 'dnd_panel_status must not write')
})

console.log(process.exitCode === 1 ? '\npanel-status.test.mjs: FAILURE(S)' : '\npanel-status.test.mjs: all assertions passed')
