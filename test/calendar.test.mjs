/**
 * calendar.test.mjs — the world clock (T10).
 *
 * Two halves, deliberately separated:
 *
 *   1. the CARRY ARITHMETIC, tested as a pure function with no filesystem at
 *      all. Month-end, year-end and multi-month jumps are properties of a
 *      computation, not of a campaign, so they need no fixture to be tested
 *      honestly.
 *   2. the WRITE PATH, tested against a mock fs whose resolve()/stat()/readText()
 *      REMAP the literal `D:/DND` prefix into a temp tree this file owns.
 *
 * ## Why the remap is mandatory rather than tidy
 *
 * shared.mjs hard-codes `DND_ROOT = 'D:/DND'` and `activeCampaignDir()` builds
 * `${DND_ROOT}/campaigns/${campaign}` from it. No argument or environment
 * variable changes that. So a mock fs that merely points at a temp directory is
 * NOT enough — the tool resolves a real path and writes to the LIVE campaign.
 * That is not hypothetical: it is exactly what happened during this task's
 * development, and the campaign the marker named was damaged before it was
 * caught. The remap below is the fix, and `guard()` below makes a leak
 * impossible rather than merely unlikely.
 *
 * Rules: test/support/live-data.mjs · docs/harness/TEST-DATA-OWNERSHIP.md
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { advanceCalendar, setHour, describeCalendar, readCalendarFile, buildTools, REST_HOURS, HOURS_PER_UNIT } from '../src/host/tools/calendar.mjs'

let failures = 0
/**
 * Run one assertion, awaiting it.
 *
 * The await matters and is not ceremony: an earlier version of this harness
 * called `fn()` without awaiting, so every async case below resolved AFTER the
 * comma-separated test list had already run to completion. The tests reported
 * "ok" from a truthiness accident and the tree was torn down underneath a
 * still-pending write.
 */
async function test(name, fn) {
  let out
  try {
    out = await fn()
  } catch (error) {
    failures += 1
    console.error('  FAIL ' + name)
    console.error('       ' + (error && error.message ? error.message : error))
    return
  }
  if (out === false) { failures += 1; console.error('  FAIL ' + name) }
  else console.log('  ok  ' + name)
}
function section(title) { console.log('\n' + title) }

const MONTHS = ['Frostfall','Deepwinter','Thawmonth','Seedtime','Bloomtide','Highsun','Harvestmoon','Duskfall','Leafall','Chillreach','Longnight','Stormrise']
const base = () => ({ day: 2, month: 3, year: 1247, hour: 8, months: [...MONTHS], month_length: 30, day_names: [], events: [] })

// ─── the pure carry ────────────────────────────────────────────────────────
section('the carry arithmetic is pure and correct at every boundary')

await test('a plain hour advance moves only the hour', () => {
  const r = advanceCalendar(base(), 3)
  return r.hour === 11 && r.day === 2 && r.month === 3 && r.year === 1247
})

await test('the input calendar is not mutated', () => {
  const c = base()
  advanceCalendar(c, 100)
  return c.hour === 8 && c.day === 2 && c.month === 3
})

await test('hours roll into a day at 24', () => {
  const r = advanceCalendar({ ...base(), hour: 22 }, 3)
  return r.hour === 1 && r.day === 3
})

await test('END OF MONTH: 30th + 1 day lands on the 1st of the next month', () => {
  const r = advanceCalendar({ ...base(), day: 30, month: 3, hour: 8 }, 24)
  return r.day === 1 && r.month === 4 && r.year === 1247
})

await test('END OF YEAR: 30th of month 12 + 1 day lands on 1/1 of the next year', () => {
  const r = advanceCalendar({ ...base(), day: 30, month: 12, hour: 8 }, 24)
  return r.day === 1 && r.month === 1 && r.year === 1248
})

await test('END OF YEAR at the last hour: 30/12 23:00 + 1 hour carries month AND year together', () => {
  const r = advanceCalendar({ ...base(), day: 30, month: 12, year: 1247, hour: 23 }, 1)
  return r.day === 1 && r.month === 1 && r.year === 1248 && r.hour === 0
})

await test('a MULTI-MONTH jump crosses more than one month correctly', () => {
  // 2 Thawmonth (month 3) + 90 days = exactly 3 months forward -> 2 Highsun (month 6)
  const r = advanceCalendar(base(), 90 * 24)
  return r.day === 2 && r.month === 6 && r.year === 1247
})

await test('a multi-year jump is correct (not dependent on loop count)', () => {
  const r = advanceCalendar(base(), 12 * 30 * 24 * 2) // two 360-day years
  return r.day === 2 && r.month === 3 && r.year === 1249
})

await test('a calendar WITHOUT a months list still carries, defaulting to 12 months', () => {
  const r = advanceCalendar({ day: 30, month: 12, year: 5, hour: 8 }, 24)
  return r.day === 1 && r.month === 1 && r.year === 6
})

await test('a calendar with a CUSTOM month_length is honoured, not assumed to be 30', () => {
  const r = advanceCalendar({ day: 10, month: 1, year: 1, hour: 0, months: ['A','B'], month_length: 10 }, 24)
  return r.day === 1 && r.month === 2
})

await test('extra fields (day_names, events, month_length) survive an advance', () => {
  const r = advanceCalendar(base(), 24)
  return Array.isArray(r.months) && r.month_length === 30 && Array.isArray(r.events) && r.months.length === 12
})

await test('advancing by 0 changes nothing', () => {
  const r = advanceCalendar(base(), 0)
  return r.day === 2 && r.month === 3 && r.year === 1247 && r.hour === 8
})

await test('the 5e rest durations are exactly 1 hour and 8 hours', () => {
  return REST_HOURS.short === 1 && REST_HOURS.long === 8 && HOURS_PER_UNIT.day === 24 && HOURS_PER_UNIT.week === 168
})

await test('a long rest from 20:00 crosses midnight into the next day', () => {
  const r = advanceCalendar({ ...base(), hour: 20 }, REST_HOURS.long)
  return r.hour === 4 && r.day === 3
})

await test('a short rest does not change the date', () => {
  const r = advanceCalendar(base(), REST_HOURS.short)
  return r.hour === 9 && r.day === 2
})

await test('setHour selects within the day without moving the date', () => {
  const r = setHour(base(), 21)
  return r.hour === 21 && r.day === 2 && r.month === 3
})

await test('describeCalendar names the month from the calendar list', () => {
  return describeCalendar(base()) === '2 Thawmonth 1247 AR, 08:00'
})

// ─── the write path ────────────────────────────────────────────────────────
section('the write path advances the campaign calendar and threads the policy')

const tempRoot = mkdtempSync(path.join(tmpdir(), 'dnd-calendar-'))
process.on('exit', () => { try { rmSync(tempRoot, { recursive: true, force: true }) } catch { /* gone */ } })

const TEMP_CAMPAIGNS = path.join(tempRoot, 'campaigns').replace(/\\/g, '/')
const TEMP_RUNTIME = path.join(tempRoot, '.runtime').replace(/\\/g, '/')
mkdirSync(path.join(tempRoot, 'campaigns', 'testcamp', 'characters'), { recursive: true })
mkdirSync(path.join(tempRoot, '.runtime'), { recursive: true })
writeFileSync(path.join(tempRoot, '.runtime', 'active-campaign.json'), JSON.stringify({ name: 'testcamp' }), 'utf8')

const CAL_PATH = path.join(tempRoot, 'campaigns', 'testcamp', 'calendar.json')
const resetCalendar = () => writeFileSync(CAL_PATH, JSON.stringify(base(), null, 2) + '\n', 'utf8')
resetCalendar()

/** The temp tree's own root, as the mock sees it. */
const TEMP_PREFIX = String(tempRoot).replace(/\\/g, '/')

/**
 * Map a production path into the temp tree, exactly as host.test.mjs does.
 * Every mock fs method runs its argument through this, so the tool's hard-coded
 * `D:/DND/...` string lands inside the temp tree.
 */
const remap = (p) => String(p)
  .replace(/^D:\/DND\/campaigns/i, TEMP_CAMPAIGNS)
  .replace(/^D:\/DND\/\.runtime/i, TEMP_RUNTIME)

/**
 * The leak guard. After remapping, a path MUST still be inside the temp tree.
 * A path that escaped the remap would otherwise be written to the real
 * D:\DND — the exact accident this task hit during development.
 */
function guard(mapped, method) {
  const norm = String(mapped).replace(/\\/g, '/')
  if (!norm.startsWith(TEMP_PREFIX)) {
    throw new Error('LEAK: fs.' + method + '() resolved outside the temp tree: ' + norm)
  }
  return norm
}

const nodePath = (p) => String(p).replace(/\//g, path.sep)
const makeTarget = (displayPath) => ({ targetKey: String(displayPath).toLowerCase(), displayPath: String(displayPath) })

let lastPolicy = 'WRITE-NOT-CALLED'
const fs = {
  async resolve(p) { return makeTarget(guard(remap(p), 'resolve')) },
  async stat(t) {
    const real = guard(String(t.displayPath), 'stat')
    try { const s = statSync(nodePath(real)); return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs } } catch { return undefined }
  },
  async readText(t) { return readFileSync(nodePath(guard(String(t.displayPath), 'readText')), 'utf8') },
  async writeText(t, text, a, b, policy) {
    lastPolicy = policy
    writeFileSync(nodePath(guard(String(t.displayPath), 'writeText')), text, 'utf8')
  },
  async listDir(t) {
    const real = guard(String(t.displayPath), 'listDir')
    return readdirSync(nodePath(real), { withFileTypes: true }).map((e) => ({
      name: e.name, target: makeTarget(real + '/' + e.name), type: e.isDirectory() ? 'directory' : 'file',
    }))
  },
}

const ctx = { get: (n) => (n === 'fs' ? fs : undefined) }
const tool = buildTools(ctx).find((x) => x.name === 'dnd_calendar')
const readCal = () => JSON.parse(readFileSync(nodePath(CAL_PATH), 'utf8'))

/** A ToolRunContext stub whose agent resolves to a session with a known cwd. */
const execWithSession = { agent: { id: 'session-1' } }
const ctxWithPolicy = {
  get: (n) => {
    if (n === 'fs') return fs
    if (n === 'sessions') return { get: () => ({ header: { cwd: 'D:/DND' } }) }
    if (n === 'sandboxPolicy') return { resolve: ({ session }) => ({ workspaceRoot: session.header.cwd, mode: 'workspace-write', sessionId: 'session-1' }) }
    return undefined
  },
}
const toolWithPolicy = buildTools(ctxWithPolicy).find((x) => x.name === 'dnd_calendar')

await test('a read with no arguments reports the world time and writes nothing', async () => {
  resetCalendar()
  const before = readFileSync(nodePath(CAL_PATH), 'utf8')
  const out = await tool.execute({})
  return readFileSync(nodePath(CAL_PATH), 'utf8') === before && /2 Thawmonth 1247 AR/.test(out)
})

await test('advancing by days rewrites the calendar file', async () => {
  resetCalendar()
  await tool.execute({ amount: 1, unit: 'day' })
  return readCal().day === 3 && readCal().hour === 8
})

await test('a short rest advances exactly one hour', async () => {
  resetCalendar()
  await tool.execute({ rest: 'short' })
  return readCal().hour === 9
})

await test('a long rest advances exactly eight hours and can cross midnight', async () => {
  resetCalendar()
  writeFileSync(CAL_PATH, JSON.stringify({ ...base(), hour: 20 }, null, 2) + '\n', 'utf8')
  await tool.execute({ rest: 'long' })
  return readCal().hour === 4 && readCal().day === 3
})

await test('the month-end boundary is correct THROUGH THE TOOL, not just the pure function', async () => {
  writeFileSync(CAL_PATH, JSON.stringify({ ...base(), day: 30, month: 3 }, null, 2) + '\n', 'utf8')
  await tool.execute({ amount: 1, unit: 'day' })
  return readCal().day === 1 && readCal().month === 4
})

await test('the year-end boundary is correct THROUGH THE TOOL', async () => {
  writeFileSync(CAL_PATH, JSON.stringify({ ...base(), day: 30, month: 12 }, null, 2) + '\n', 'utf8')
  await tool.execute({ amount: 1, unit: 'day' })
  return readCal().day === 1 && readCal().month === 1 && readCal().year === 1248
})

await test('setting the hour changes no date field', async () => {
  resetCalendar()
  await tool.execute({ hour: 23 })
  const c = readCal()
  return c.hour === 23 && c.day === 2 && c.month === 3 && c.year === 1247
})

await test('a negative advance is refused and writes nothing', async () => {
  resetCalendar()
  const before = readFileSync(nodePath(CAL_PATH), 'utf8')
  const out = await tool.execute({ amount: -5, unit: 'day' })
  return readFileSync(nodePath(CAL_PATH), 'utf8') === before && /refusing/i.test(out)
})

await test('an unknown unit is refused and writes nothing', async () => {
  resetCalendar()
  const before = readFileSync(nodePath(CAL_PATH), 'utf8')
  const out = await tool.execute({ amount: 1, unit: 'fortnight' })
  return readFileSync(nodePath(CAL_PATH), 'utf8') === before && /unknown unit/i.test(out)
})

await test('amount without a unit is refused and writes nothing', async () => {
  resetCalendar()
  const before = readFileSync(nodePath(CAL_PATH), 'utf8')
  const out = await tool.execute({ amount: 3 })
  return readFileSync(nodePath(CAL_PATH), 'utf8') === before && /needs a unit/i.test(out)
})

await test('a repeated key does not advance twice', async () => {
  resetCalendar()
  await tool.execute({ amount: 1, unit: 'day', key: 'k1' })
  const once = readCal().day
  await tool.execute({ amount: 1, unit: 'day', key: 'k1' })
  return readCal().day === once
})

await test('a missing calendar is reported rather than invented', async () => {
  const saved = readFileSync(nodePath(CAL_PATH), 'utf8')
  rmSync(nodePath(CAL_PATH))
  const out = await tool.execute({ amount: 1, unit: 'day' })
  writeFileSync(CAL_PATH, saved, 'utf8')
  return !existsSync(nodePath(CAL_PATH)) === false && /no readable calendar\.json/i.test(out)
})

await test('a corrupt calendar is reported rather than silently reset', async () => {
  const saved = readFileSync(nodePath(CAL_PATH), 'utf8')
  writeFileSync(CAL_PATH, '{ this is not json', 'utf8')
  const out = await tool.execute({ amount: 1, unit: 'day' })
  const untouched = readFileSync(nodePath(CAL_PATH), 'utf8') === '{ this is not json'
  writeFileSync(CAL_PATH, saved, 'utf8')
  return untouched && /no readable calendar\.json/i.test(out)
})

await test('the write carries the CALLING SESSION policy as writeText 5th argument', async () => {
  resetCalendar()
  lastPolicy = 'WRITE-NOT-CALLED'
  await toolWithPolicy.execute({ amount: 1, unit: 'hour' }, execWithSession)
  return lastPolicy !== 'WRITE-NOT-CALLED' && lastPolicy.workspaceRoot === 'D:/DND' && lastPolicy.sessionId === 'session-1'
})

await test('with no session the policy is undefined (fail closed, never widened)', async () => {
  resetCalendar()
  lastPolicy = 'WRITE-NOT-CALLED'
  await tool.execute({ amount: 1, unit: 'hour' })
  return lastPolicy === undefined
})

await test('the worldTime a character write would stamp reflects the advanced clock', async () => {
  // clock.mjs's buildMetadata is what stamps a character file. T10 must not
  // rewrite it, only feed it a moved calendar — so this asserts the SEAM: the
  // object that gets written to disk is the one buildMetadata formats.
  resetCalendar()
  await tool.execute({ amount: 1, unit: 'day' })
  const { buildMetadata } = await import('../src/host/tools/clock.mjs')
  const meta = buildMetadata({ campaign: 'testcamp', calendar: readCal() })
  return meta.worldTime === '3 Thawmonth 1247 AR, 08:00'
})

console.log('')
if (failures > 0) {
  console.error('calendar.test.mjs: ' + failures + ' failure(s)')
  process.exit(1)
}
console.log('calendar.test.mjs: all assertions passed')
