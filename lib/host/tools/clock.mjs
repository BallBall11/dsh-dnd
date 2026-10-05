/**
 * tools/clock.mjs — the two clocks a character file carries.
 *
 * ## Why there are two
 *
 * `updated` is the real-world date: when this file was last written.
 *
 * `worldTime` is the in-world date: when the events in it happened. The two
 * move independently. A DM may play three sessions in one evening (same real
 * date, the world advances weeks) or leave a campaign untouched for a month
 * (real date jumps, the world is frozen mid-dungeon). Recording only one loses
 * information that the other cannot reconstruct.
 *
 * The distinction is not academic — it is what produced the conflict that
 * motivated this whole split. `alice.md` was stamped `2026-09-04` (real) while
 * `state.md` read `2 Thawmonth 1247` (world), and there was no rule for which
 * was "newer", because they were never comparable in the first place.
 *
 * ## Where the world clock comes from
 *
 * `campaigns/<campaign>/calendar.json`, which is machine-readable:
 *
 *   { "day": 2, "month": 3, "year": 1247, "hour": 8,
 *     "months": ["Frostfall", "Deepwinter", "Thawmonth", ...] }
 *
 * Reading it directly is straightforward and correct. `state.md` also carries
 * prose forms (`**In-world date/time:** 2 Thawmonth 1247 AR, pre-dawn`), which
 * are for humans and are not parsed here: two sources for one value is how the
 * original drift started.
 */

/**
 * Format a real-world date as `YYYY-MM-DD`.
 * @param date - defaults to now.
 */
export function realDate(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Render a calendar object as the in-world date string.
 *
 * Falls back to the numeric month when the calendar carries no name list, so a
 * hand-made calendar still yields something usable rather than a blank.
 *
 * @param calendar - parsed calendar.json, or null.
 * @returns e.g. `"2 Thawmonth 1247 AR"`, or null when unreadable.
 */
export function formatWorldTime(calendar) {
  if (calendar === null || typeof calendar !== 'object') return null
  const { day, month, year, hour, months } = calendar
  if (year === undefined && month === undefined && day === undefined) return null

  const monthName = Array.isArray(months) && months[Number(month) - 1] !== undefined
    ? months[Number(month) - 1]
    : `month ${month ?? '?'}`
  const parts = [day ?? '?', monthName, year ?? '?'].join(' ')
  const withEra = `${parts} AR`
  return hour !== undefined && hour !== null ? `${withEra}, ${formatHour(hour)}` : withEra
}

/** `8` -> `"08:00"`. */
function formatHour(hour) {
  const h = Number(hour)
  if (!Number.isFinite(h)) return String(hour)
  return `${String(Math.floor(h)).padStart(2, '0')}:00`
}

/**
 * Read the campaign calendar. Never throws — a missing or malformed calendar
 * means the world time is simply unknown, which is normal for a new campaign.
 *
 * @param fs - the host fs service.
 * @param campaignDir - absolute path to the campaign directory.
 * @returns the parsed calendar, or null.
 */
export async function readCalendar(fs, campaignDir) {
  try {
    const target = await fs.resolve(`${campaignDir}/calendar.json`)
    if ((await fs.stat(target)) === undefined) return null
    const text = await fs.readText(target)
    const parsed = JSON.parse(stripBom(text))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Strip a UTF-8 BOM. */
function stripBom(text) {
  const s = String(text ?? '')
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

/**
 * Build the metadata block for a character file.
 *
 * Both clocks are stamped on every write, which is the rule: any change to the
 * state or the narrative updates both, so a stale timestamp cannot silently
 * claim a file is current.
 *
 * @param options - `{ player, campaign, calendar, tags }` plus an optional
 *   `now` for testing.
 * @returns the frontmatter data object.
 */
export function buildMetadata({ player = null, campaign = null, calendar = null, tags = ['pc'], now = new Date() } = {}) {
  return {
    player,
    campaign,
    updated: realDate(now),
    worldTime: formatWorldTime(calendar),
    tags,
  }
}

/** The order these keys appear in the file. */
export const METADATA_ORDER = ['player', 'campaign', 'updated', 'worldTime', 'tags']
