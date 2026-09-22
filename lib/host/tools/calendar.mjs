/**
 * tools/calendar.mjs — advancing the campaign's WORLD CLOCK.
 *
 *   dnd_calendar   advance / set the active campaign's calendar.json
 *
 * ## The defect this exists to fix
 *
 * `clock.mjs` could READ `calendar.json` — it stamped the `worldTime`
 * frontmatter field on every character write — but nothing in the bundle could
 * WRITE it. World time was therefore read forever and never advanced: short
 * rests, long rests and travel days did not move the clock, so the `worldTime`
 * stamp stayed frozen at the same instant for the life of the campaign.
 *
 * It is the quietest of the three gaps T5 found. It never throws. The number
 * simply does not move, and a DM reading "2 Thawmonth 1247" a month later has
 * no way to tell that from a world where nothing happened.
 *
 * ## The carry arithmetic is a PURE FUNCTION
 *
 * `advanceCalendar` takes a calendar object and an hour count and returns a NEW
 * object. It touches no filesystem, no clock and no random source, which is what
 * makes the boundary cases testable without constructing a campaign at all —
 * the same reason roll.mjs's six tools are easy to reason about.
 *
 * Hours are the single unit of motion, and every other unit is a multiple of
 * them (day = 24, week = 168). Converting to hours first and carrying once is
 * what keeps "end of month +1 day" and "end of year +1 day" from needing
 * separate, separately-wrong code paths.
 *
 * ## Why the carry is done in day-space rather than in while loops
 *
 * The calendar stores `hour` 0..23 and `day` as a 1-based day-of-month. The
 * carry is the ordinary one: hours past 23 become days, days past
 * `month_length` become months, months past the length of `months` become
 * years. `month_length` is read from the file (30 in every campaign here)
 * rather than assumed, because a campaign is allowed to define its own year.
 *
 * Doing it with one division rather than a loop matters for correctness at
 * magnitude: "advance by 200 hours" must not depend on how many times a loop
 * happened to run.
 *
 * ## Where the file is
 *
 * `campaigns/<campaign>/calendar.json` for the ACTIVE campaign, resolved the
 * same way every other tool resolves it (`activeCampaignDir`). The tool takes no
 * `character` argument and no campaign argument: there is one world clock per
 * campaign, and "which campaign" is answered by the active-campaign marker.
 *
 * ## The write path
 *
 * This is a WRITE tool, so it goes through the same policy-threaded path as
 * `dnd_track` / `dnd_spend` / `dnd_xp_add`: `execute(args, exec)` resolves the
 * calling session's policy and passes it as the FIFTH argument to
 * `fs.writeText`. Omitting it is the defect that made every campaign write
 * refusable, because the fs sandbox then judges the path against a root derived
 * from the harness process's cwd (see session-scope.mjs).
 */

import { activeCampaignDir, parseJsonLoose } from './shared.mjs'
import { writePolicyFor } from './session-scope.mjs'
import { withWriteDiagnosis } from './write-errors.mjs'

export const name = 'dnd-calendar'

/** Render a plain string result for the model. */
const renderText = (_args, value) => [{ type: 'text', text: String(value) }]

/** Hours in each unit the tool accepts. A week is 7 days; 5e has no week rule. */
export const HOURS_PER_UNIT = { hour: 1, hours: 1, day: 24, days: 24, week: 168, weeks: 168 }

/**
 * The 5e rest durations, in hours.
 *
 * These are the rules, not a convention of this codebase: a short rest is "a
 * period of downtime, at least 1 hour long", and a long rest is "at least 8
 * hours long". The old skill's calendar.py used exactly the same two values
 * (`_advance_hours(cal, 1)` / `(cal, 8)`), so the behaviour a DM already knows
 * is preserved rather than re-invented.
 */
export const REST_HOURS = { short: 1, long: 8 }

/** How many idempotency keys the calendar file remembers. Mirrors MAX_APPLIED_KEYS. */
export const MAX_CALENDAR_KEYS = 32

const numOr = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** How many months a year has, from the calendar's own month list when present. */
function monthsInYear(calendar) {
  const months = Array.isArray(calendar?.months) ? calendar.months : []
  return months.length > 0 ? months.length : 12
}

/** How many days a month has. The file may define its own; 30 otherwise. */
function daysInMonth(calendar) {
  const length = Number(calendar?.month_length)
  return Number.isFinite(length) && length > 0 ? Math.trunc(length) : 30
}

/**
 * Advance a calendar by a number of hours, carrying correctly at every boundary.
 *
 * PURE: no fs, no `Date`, no randomness. Returns a NEW object; the input is
 * never mutated, so a caller that fails to write cannot leave a half-advanced
 * calendar in memory.
 *
 * @param calendar - the parsed calendar.json (any shape; fields default).
 * @param hours - hours to advance; may be 0.
 * @returns a new calendar object, preserving months / day_names / events /
 *   month_length and any other field the file carries.
 */
export function advanceCalendar(calendar, hours) {
  const src = calendar !== null && typeof calendar === 'object' ? calendar : {}

  const perMonth = daysInMonth(src)
  const perYear = monthsInYear(src)

  // Collapse the date to a single count of hours from a fixed epoch, add the
  // elapsed hours, then unpack. One conversion each way, so the arithmetic is
  // identical for any magnitude.
  const startHour = numOr(src.hour, 0)
  const startDay = numOr(src.day, 1)
  const startMonth = numOr(src.month, 1)
  const startYear = numOr(src.year, 1)

  const monthsBefore = (startYear - 1) * perYear + (startMonth - 1)
  const totalDays = monthsBefore * perMonth + (startDay - 1)
  const totalHours = totalDays * 24 + startHour + Math.trunc(numOr(hours, 0))

  // Floor rather than truncate, so a negative total (unreachable through the
  // tool, which refuses a negative advance) still lands on a coherent date.
  const dayHours = ((totalHours % 24) + 24) % 24
  const allDays = Math.floor(totalHours / 24)

  const yearIndex = Math.floor(allDays / (perMonth * perYear))
  const withinYear = allDays - yearIndex * perMonth * perYear
  const monthIndex = Math.floor(withinYear / perMonth)
  const dayIndex = withinYear - monthIndex * perMonth

  return {
    ...src,
    year: yearIndex + 1,
    month: monthIndex + 1,
    day: dayIndex + 1,
    hour: dayHours,
  }
}

/**
 * Set the hour of the current day, without changing the date.
 *
 * Kept separate from `advanceCalendar` because it is not motion: it selects a
 * point within the current day rather than moving the date.
 *
 * @param calendar - the parsed calendar.
 * @param hour - the hour 0..23 to set; wrapped into range.
 * @returns a new calendar object.
 */
export function setHour(calendar, hour) {
  const src = calendar !== null && typeof calendar === 'object' ? calendar : {}
  return { ...src, hour: ((Math.trunc(numOr(hour, 0)) % 24) + 24) % 24 }
}

/** The in-world date line a human reads, matching clock.mjs's wording. */
export function describeCalendar(calendar) {
  const months = Array.isArray(calendar?.months) ? calendar.months : []
  const monthNumber = numOr(calendar?.month, 1)
  const monthName = months[monthNumber - 1] !== undefined ? months[monthNumber - 1] : 'month ' + monthNumber
  const hour = numOr(calendar?.hour, 0)
  return numOr(calendar?.day, 1) + ' ' + monthName + ' ' + numOr(calendar?.year, 1) + ' AR, ' + String(hour).padStart(2, '0') + ':00'
}

/**
 * Read the campaign's calendar, distinguishing "absent" from "unreadable".
 *
 * `clock.mjs`'s `readCalendar` collapses both to null, which is right for
 * STAMPING a character (an unknown world time is normal) but wrong for ADVANCING
 * one: a DM who asked to advance the clock must be told the calendar could not
 * be read, rather than being handed a silent no-op.
 *
 * @param fs - the host fs service.
 * @param campaignDir - absolute path to the campaign directory.
 * @returns `{ calendar, exists, malformed, warnings }`.
 */
export async function readCalendarFile(fs, campaignDir) {
  const warnings = []
  const path = campaignDir + '/calendar.json'
  let text
  try {
    const target = await fs.resolve(path)
    if ((await fs.stat(target)) === undefined) return { calendar: null, exists: false, malformed: false, warnings }
    text = await fs.readText(target)
  } catch {
    return { calendar: null, exists: false, malformed: false, warnings }
  }
  try {
    const parsed = parseJsonLoose(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push('calendar.json is not a JSON object')
      return { calendar: null, exists: true, malformed: true, warnings }
    }
    return { calendar: parsed, exists: true, malformed: false, warnings }
  } catch (error) {
    warnings.push('calendar.json could not be parsed: ' + (error && error.message ? error.message : error))
    return { calendar: null, exists: true, malformed: true, warnings }
  }
}

/**
 * Build this module's tools.
 * @param ctx - host context; `fs` is optional and read lazily per call.
 * @returns an array of tool definitions.
 */
export function buildTools(ctx) {
  const getFs = () => ctx.get('fs')

  const calendar = {
    name: 'dnd_calendar',
    description:
      'Read or advance the active campaign' + String.fromCharCode(39) + 's WORLD clock (calendar.json). '
      + 'Advance by hours/days/weeks, take a short rest (+1 hour) or a long rest (+8 hours), or set the hour. '
      + 'World time moves independently of the real date: it is what stamps the worldTime field on character files, '
      + 'and nothing else in the bundle can move it. Omit every argument to just read the current world time.',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'integer', description: 'How much to advance, e.g. 3. Requires unit. Negative is refused.' },
        unit: { type: 'string', description: 'Unit for amount.', enum: ['hour', 'day', 'week'] },
        rest: { type: 'string', description: 'Take a rest: "short" is +1 hour, "long" is +8 hours (5e durations).', enum: ['short', 'long'] },
        hour: { type: 'integer', description: 'Set the hour of the current day, 0-23, without changing the date.' },
        key: { type: 'string', description: 'Idempotency key. Repeating a call with the same key changes nothing the second time.' },
        reason: { type: 'string', description: 'Short note recorded in the returned summary, e.g. "travel to the keep".' },
      },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'

      const located = await activeCampaignDir(fs)
      if (located === undefined) {
        return 'No active campaign. Load one with /dm:dnd load <campaign> first.'
      }

      const wantsAdvance = args.amount !== undefined && args.amount !== null && String(args.amount).trim() !== ''
      const wantsRest = args.rest !== undefined && String(args.rest).trim() !== ''
      const wantsSetHour = args.hour !== undefined && args.hour !== null && String(args.hour).trim() !== ''

      if (wantsAdvance && args.unit === undefined) {
        return 'dnd_calendar: amount needs a unit — one of "hour", "day" or "week". Nothing was written.'
      }
      if (wantsRest && !Object.prototype.hasOwnProperty.call(REST_HOURS, String(args.rest).toLowerCase())) {
        return 'dnd_calendar: unknown rest "' + args.rest + '". Use "short" (+1 hour) or "long" (+8 hours). Nothing was written.'
      }

      let hours = 0
      let label = ''
      if (wantsAdvance) {
        const amount = Number(args.amount)
        if (!Number.isFinite(amount)) {
          return 'dnd_calendar could not read amount "' + args.amount + '" as a number. Nothing was written.'
        }
        const unit = String(args.unit).toLowerCase()
        const perUnit = HOURS_PER_UNIT[unit]
        if (perUnit === undefined) {
          return 'dnd_calendar: unknown unit "' + args.unit + '". Use "hour", "day" or "week". Nothing was written.'
        }
        if (Math.trunc(amount) < 0) {
          return 'dnd_calendar: refusing to advance by ' + amount + ' ' + unit + '; time moves forward. Nothing was written.'
        }
        hours = Math.trunc(amount) * perUnit
        label = '+' + Math.trunc(amount) + ' ' + unit
      }
      if (wantsRest) {
        const kind = String(args.rest).toLowerCase()
        hours += REST_HOURS[kind]
        const restLabel = kind + ' rest (+' + REST_HOURS[kind] + ' hour' + (REST_HOURS[kind] === 1 ? '' : 's') + ')'
        label = label === '' ? restLabel : label + ', ' + restLabel
      }

      if (!wantsAdvance && !wantsRest && !wantsSetHour) {
        // A pure read. It must not create or stamp anything: a call that asks a
        // question must not change the answer.
        const read = await readCalendarFile(fs, located.dir)
        if (read.calendar === null) {
          return 'Campaign "' + located.campaign + '" has no readable calendar.json, so its world time is unknown.'
        }
        return '**' + located.campaign + '** world time: ' + describeCalendar(read.calendar)
      }

      const read = await readCalendarFile(fs, located.dir)
      if (read.calendar === null) {
        return 'Campaign "' + located.campaign + '" has no readable calendar.json. '
          + 'Create one first (day, month, year, hour, months, month_length); dnd_calendar will not invent a calendar.'
      }

      // Idempotency is checked BEFORE the arithmetic, so a retry cannot
      // half-apply and then discover it was a duplicate.
      const key = args.key === undefined || args.key === null || String(args.key).trim() === ''
        ? null
        : String(args.key).trim()
      const applied = Array.isArray(read.calendar.appliedKeys) ? read.calendar.appliedKeys : []
      if (key !== null && applied.includes(key)) {
        return 'Already applied (key "' + key + '"); nothing changed.'
      }

      const before = describeCalendar(read.calendar)
      let next = hours !== 0 ? advanceCalendar(read.calendar, hours) : { ...read.calendar }
      if (wantsSetHour) {
        const h = Number(args.hour)
        if (!Number.isFinite(h)) return 'dnd_calendar could not read hour "' + args.hour + '". Nothing was written.'
        next = setHour(next, h)
      }
      if (key !== null) {
        // The key list lives in the calendar file itself, so a retry is caught
        // even after a restart. Bounded, like the character write path's.
        const keys = [...applied.filter((k) => k !== key), key]
        next.appliedKeys = keys.slice(Math.max(0, keys.length - MAX_CALENDAR_KEYS))
      }

      const policy = writePolicyFor(ctx, exec)
      const path = located.dir + '/calendar.json'
      // Translated on refusal so a denial is actionable rather than a bare
      // restatement of the mode (T7).
      await withWriteDiagnosis(
        async () => fs.writeText(await fs.resolve(path), JSON.stringify(next, null, 2) + '\n', undefined, undefined, policy),
        { policy, operation: 'calendar write', campaign: located.campaign },
      )

      const after = describeCalendar(next)
      const what = label !== '' ? ' (' + label + ')' : ''
      const note = args.reason !== undefined && String(args.reason).trim() !== '' ? ' — ' + String(args.reason).trim() : ''
      return located.campaign + what + note + '\n  ' + before + ' -> ' + after
    },
  }

  return [calendar]
}
