/**
 * campaign-init.test.mjs — dnd_campaign_status and dnd_campaign_create.
 *
 * This suite owns a throwaway temp workspace and drives both tools against it
 * through the real call path (execute with a mocked host fs). It also carries
 * the regression test for the removed root fallback: with no session and no
 * DND_ROOT/DSH_CWD, every tool must answer the loud ROOT_ERROR instead of
 * silently operating on D:/DND.
 *
 * Like the other fs suites, production paths are remapped into the temp tree
 * and every mock method guards against a write escaping it. The mock's
 * writeText CREATES parent directories, modelling the real backend's behaviour
 * that campaign scaffolding depends on; the failure test pins what the tool
 * does when the backend refuses.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

process.env.DND_ROOT ??= 'D:/DND' // suites call tools with no session; the env root IS the config

import { buildTools } from '../src/host/tools/campaign-init.mjs'
import { ROOT_ERROR } from '../src/host/tools/shared.mjs'

const section = (title) => console.log('\n' + title)

const tempRoot = mkdtempSync(path.join(tmpdir(), 'dnd-campinit-')).replace(/\\/g, '/')
process.on('exit', () => { try { rmSync(tempRoot, { recursive: true, force: true }) } catch { /* gone */ } })

const TEMP_CAMPAIGNS = path.join(tempRoot, 'campaigns').replace(/\\/g, '/')
const TEMP_RUNTIME = path.join(tempRoot, '.runtime').replace(/\\/g, '/')
const TEMP_PREFIX = String(tempRoot).replace(/\\/g, '/')
const nodePath = (p) => String(p).replace(/\//g, path.sep)

const remap = (p) => String(p)
  .replace(/^D:\/DND\/campaigns/i, TEMP_CAMPAIGNS)
  .replace(/^D:\/DND\/\.runtime/i, TEMP_RUNTIME)

function guard(mapped, method) {
  const norm = String(mapped).replace(/\\/g, '/')
  if (!norm.startsWith(TEMP_PREFIX)) {
    throw new Error('LEAK: fs.' + method + '() resolved outside the temp tree: ' + norm)
  }
  return norm
}

const makeTarget = (displayPath) => ({ targetKey: String(displayPath).toLowerCase(), displayPath: String(displayPath) })

/** Count of writeText calls since the last reset — the "zero writes" probe. */
let writes = 0
let failWritesFrom = -1

const fs = {
  async resolve(p) { return makeTarget(guard(remap(p), 'resolve')) },
  async stat(t) {
    const real = nodePath(guard(String(t.displayPath), 'stat'))
    return existsSync(real) ? { type: existsSync(real) && !real.split(path.sep).pop().includes('.') ? 'directory' : 'file', mtime: 0 } : undefined
  },
  async readText(t) { return readFileSync(nodePath(guard(String(t.displayPath), 'readText')), 'utf8') },
  async writeText(t, text) {
    writes += 1
    if (failWritesFrom >= 0 && writes >= failWritesFrom) {
      throw new Error('ENOENT: no such file or directory, open \'' + String(t.displayPath) + '\'')
    }
    const real = nodePath(guard(String(t.displayPath), 'writeText'))
    mkdirSync(path.dirname(real), { recursive: true })
    writeFileSync(real, text, 'utf8')
  },
  async listDir(t) {
    const real = nodePath(guard(String(t.displayPath), 'listDir'))
    if (!existsSync(real)) return []
    return [{ name: 'testcamp', target: makeTarget(TEMP_CAMPAIGNS + '/testcamp'), type: 'directory' }]
  },
}

const ctx = { get: (n) => (n === 'fs' ? fs : undefined) }
const tools = buildTools(ctx)
const status = tools.find((t) => t.name === 'dnd_campaign_status')
const create = tools.find((t) => t.name === 'dnd_campaign_create')
const update = tools.find((t) => t.name === 'dnd_campaign_update')

const reset = () => {
  rmSync(nodePath(TEMP_CAMPAIGNS), { recursive: true, force: true })
  rmSync(nodePath(TEMP_RUNTIME), { recursive: true, force: true })
  writes = 0
  failWritesFrom = -1
}

// ─── registration ───────────────────────────────────────────────────────────
section('registration')

await test('the family exports exactly the two bootstrap tools', () => {
  assert.deepEqual(tools.map((t) => t.name), ['dnd_campaign_status', 'dnd_campaign_create', 'dnd_campaign_update'])
})

// ─── dnd_campaign_status ────────────────────────────────────────────────────
section('dnd_campaign_status')

await test('an empty workspace is answered with guidance, not a shell hint', async () => {
  reset()
  const out = await status.execute({})
  return /Data root/.test(out) && /none/.test(out) && /dnd_campaign_create/.test(out)
})

await test('an existing campaign is listed with its ruleset and active marker', async () => {
  reset()
  mkdirSync(path.join(nodePath(TEMP_CAMPAIGNS), 'testcamp'), { recursive: true })
  mkdirSync(nodePath(TEMP_RUNTIME), { recursive: true })
  writeFileSync(path.join(nodePath(TEMP_CAMPAIGNS), 'testcamp', 'state.md'),
    '# Test\n\n**Ruleset:** 2024\n', 'utf8')
  writeFileSync(path.join(nodePath(TEMP_RUNTIME), 'active-campaign.json'), '{"name":"testcamp"}', 'utf8')
  const out = await status.execute({})
  return /testcamp \(active\)/.test(out) && /ruleset 2024/.test(out)
})

await test('a stale marker is named as stale, not read as no campaign', async () => {
  reset()
  mkdirSync(nodePath(TEMP_RUNTIME), { recursive: true })
  writeFileSync(path.join(nodePath(TEMP_RUNTIME), 'active-campaign.json'), '{"name":"gone"}', 'utf8')
  const out = await status.execute({})
  return /MARKER STALE/.test(out) && /gone/.test(out)
})

await test('no session and no env yields the loud ROOT_ERROR, and touches no file', async () => {
  reset()
  const savedDnd = process.env.DND_ROOT
  const savedDsh = process.env.DSH_CWD
  delete process.env.DND_ROOT
  delete process.env.DSH_CWD
  try {
    const out = await status.execute({})
    assert.equal(out, ROOT_ERROR)
    return writes === 0
  } finally {
    if (savedDnd !== undefined) process.env.DND_ROOT = savedDnd
    if (savedDsh !== undefined) process.env.DSH_CWD = savedDsh
  }
})

// ─── dnd_campaign_create ────────────────────────────────────────────────────
section('dnd_campaign_create')

await test('create scaffolds five documents and writes the marker LAST', async () => {
  reset()
  const out = await create.execute({ name: 'Tide Test', title: 'The Tide', ruleset: '2024', description: 'A test premise.' })
  const camp = path.join(nodePath(TEMP_CAMPAIGNS), 'tide-test')
  const state = readFileSync(path.join(camp, 'state.md'), 'utf8')
  return /# The Tide/.test(state)
    && /\*\*Ruleset:\*\* 2024/.test(state)
    && /## Current Situation/.test(state)
    && /## Live State Flags/.test(state)
    && existsSync(path.join(camp, 'arc.md'))
    && existsSync(path.join(camp, 'world.md'))
    && existsSync(path.join(camp, 'npcs.md'))
    && existsSync(path.join(camp, 'session-log.md'))
    && /A test premise\./.test(readFileSync(path.join(camp, 'session-log.md'), 'utf8'))
    && existsSync(path.join(camp, 'calendar.json'))
    && JSON.parse(readFileSync(path.join(camp, 'calendar.json'), 'utf8')).year === 1492
    && readFileSync(path.join(nodePath(TEMP_RUNTIME), 'active-campaign.json'), 'utf8') === '{"name":"tide-test"}\n'
    && /ACTIVE/.test(out)
})

await test('a scaffolded calendar is immediately usable by dnd_calendar', async () => {
  reset()
  await create.execute({ name: 'timed' })
  // dnd_calendar must read the scaffold's default clock without any hand setup.
  const { buildTools: buildCalendar } = await import('../src/host/tools/calendar.mjs')
  const cal = buildCalendar(ctx).find((t) => t.name === 'dnd_calendar')
  const out = await cal.execute({})
  return /1492/.test(out)
})

await test('calendarYear and calendarHour override the default clock', async () => {
  reset()
  await create.execute({ name: 'timed2', calendarYear: 1372, calendarHour: 20 })
  const cal = JSON.parse(readFileSync(path.join(nodePath(TEMP_CAMPAIGNS), 'timed2', 'calendar.json'), 'utf8'))
  return cal.year === 1372 && cal.hour === 20
})

await test('a second create on the same name is refused with ZERO writes', async () => {
  reset()
  await create.execute({ name: 'exists' })
  const afterFirst = writes
  const out = await create.execute({ name: 'exists' })
  return /refused/.test(out) && /Nothing was written/.test(out) && writes === afterFirst
})

await test('a name that is not a slug is refused before anything is touched', async () => {
  reset()
  const out = await create.execute({ name: '../escape' })
  const out2 = await create.execute({ name: 'White Rabbit!' })
  return /refused/.test(out) && /refused/.test(out2) && writes === 0
})

await test('activate:false scaffolds the campaign but leaves the marker alone', async () => {
  reset()
  await create.execute({ name: 'quiet', activate: false })
  return !existsSync(path.join(nodePath(TEMP_RUNTIME), 'active-campaign.json'))
})

await test('a backend write failure surfaces the backend error, names what was written, and leaves no marker', async () => {
  reset()
  failWritesFrom = 3 // fail on the third of five scaffold writes
  const out = await create.execute({ name: 'halfway' })
  failWritesFrom = -1
  return /failed after writing 2 file/.test(out)
    && /ENOENT/.test(out)
    && !existsSync(path.join(nodePath(TEMP_RUNTIME), 'active-campaign.json'))
})

await test('the write carries the CALLING SESSION policy as the 5th argument', async () => {
  reset()
  let seenPolicy = 'NOT-CALLED'
  const ctxWithPolicy = {
    get: (n) => {
      if (n === 'fs') return { ...fs, writeText: async (t, text, a, b, policy) => { seenPolicy = policy; return fs.writeText(t, text) } }
      if (n === 'sessions') return { get: () => ({ header: { cwd: 'D:/DND' } }) }
      if (n === 'sandboxPolicy') return { resolve: ({ session }) => ({ workspaceRoot: session.header.cwd, mode: 'workspace-write', sessionId: 'session-1' }) }
      return undefined
    },
  }
  const toolWithPolicy = buildTools(ctxWithPolicy).find((t) => t.name === 'dnd_campaign_create')
  await toolWithPolicy.execute({ name: 'policycheck' }, { agent: { id: 'session-1' } })
  return seenPolicy !== 'NOT-CALLED'
    && seenPolicy.workspaceRoot === 'D:/DND'
    && seenPolicy.sessionId === 'session-1'
})

await test('create without a resolvable root answers ROOT_ERROR and writes nothing', async () => {
  reset()
  const savedDnd = process.env.DND_ROOT
  const savedDsh = process.env.DSH_CWD
  delete process.env.DND_ROOT
  delete process.env.DSH_CWD
  try {
    const out = await create.execute({ name: 'nowhere' })
    assert.equal(out, ROOT_ERROR)
    return writes === 0
  } finally {
    if (savedDnd !== undefined) process.env.DND_ROOT = savedDnd
    if (savedDsh !== undefined) process.env.DSH_CWD = savedDsh
  }
})

// ---------------------------------------------------------------------------
// dnd_campaign_update
// ---------------------------------------------------------------------------
section('dnd_campaign_update')

const statePath = () => path.join(nodePath(TEMP_CAMPAIGNS), 'tide-test', 'state.md')

await test('set-section replaces a section body verbatim and keeps the preamble byte-identical', async () => {
  reset()
  await create.execute({ name: 'tide-test', title: 'The Tide', ruleset: '2024', description: 'A premise.' })
  const before = readFileSync(statePath(), 'utf8')
  const preambleBefore = before.slice(0, before.indexOf('## '))
  const out = await update.execute({ op: 'set-section', section: 'Current Situation',
    body: '- **Location:** the Longshore' + String.fromCharCode(10) + String.fromCharCode(10) + '盐沼的夜，钟声无人敲而自鸣。' })
  const after = readFileSync(statePath(), 'utf8')
  return /replaced/.test(out)
    && after.slice(0, after.indexOf('## ')) === preambleBefore
    && after.includes('钟声无人敲而自鸣')
    && after.includes('**Ruleset:** 2024')
})

await test('append adds lines and remove drops them; untouched sections stay byte-identical', async () => {
  reset()
  await create.execute({ name: 'tide-test' })
  await update.execute({ op: 'append', section: 'Recent Events', text: '- 丧钟自鸣。' })
  const mid = readFileSync(statePath(), 'utf8')
  assert.ok(mid.includes('丧钟自鸣'))
  const flagsBefore = mid.slice(mid.indexOf('## Live State Flags'), mid.indexOf('## World State'))
  await update.execute({ op: 'remove', section: 'Recent Events', match: '丧钟自鸣' })
  const after = readFileSync(statePath(), 'utf8')
  return !after.includes('丧钟自鸣')
    && after.slice(after.indexOf('## Live State Flags'), after.indexOf('## World State')) === flagsBefore
})

await test('flag sets and updates a Live State Flags entry, reporting the old value', async () => {
  reset()
  await create.execute({ name: 'tide-test' })
  const first = await update.execute({ op: 'flag', name: 'town_alarm', value: 'high' })
  const second = await update.execute({ op: 'flag', name: 'town_alarm', value: 'low' })
  const state = readFileSync(statePath(), 'utf8')
  return /did not exist before/.test(first)
    && /high -> low/.test(second)
    && state.includes('- **town_alarm:** low')
    && !state.includes('**town_alarm:** high')
})

await test('activate switches the marker and refuses an unknown campaign', async () => {
  reset()
  await create.execute({ name: 'alpha', activate: false })
  await create.execute({ name: 'beta', activate: false })
  const out = await update.execute({ op: 'activate', name: 'beta' })
  const marker = readFileSync(path.join(nodePath(TEMP_RUNTIME), 'active-campaign.json'), 'utf8')
  const bad = await update.execute({ op: 'activate', name: 'gamma' })
  return /Active campaign switched/.test(out)
    && marker === JSON.stringify({ name: 'beta' }) + '\n'
    && /No campaign "gamma"/.test(bad)
})

await test('missing section is refused with the heading list; create:true adds it', async () => {
  reset()
  await create.execute({ name: 'tide-test' })
  const miss = await update.execute({ op: 'append', section: 'Weather', text: 'fog' })
  await update.execute({ op: 'set-section', section: 'Weather', body: 'Cold fog.', create: true })
  const state = readFileSync(statePath(), 'utf8')
  return /No section "Weather"/.test(miss) && state.includes('## Weather') && state.includes('Cold fog.')
})

await test('a refused update writes nothing', async () => {
  reset()
  await create.execute({ name: 'tide-test' })
  writes = 0
  const out = await update.execute({ op: 'set-section', section: 'Current Situation' })
  return /needs `body`/.test(out) && writes === 0
})
