/**
 * tools/shared.mjs — filesystem and campaign-location helpers.
 *
 * Every read-only tool needs the same three things: where the campaign data
 * lives, how to read a file through the host `fs` service, and how to pull a
 * `## Heading` section out of a markdown document. Keeping them here means the
 * tool modules carry only their own logic.
 *
 * The `fs` service is the HOST filesystem service (ctx.get('fs')), not a realm
 * and not node:fs — this module never imports node builtins, because a plugin
 * row is evaluated by the host loader and must use the injected services.
 */

/** Data root. Campaigns and characters live here; scripts/ and data/ do not. */
export const DND_ROOT = 'D:/DND'

/** Written at /dm:dnd load; tells every tool which campaign is in play. */
export const ACTIVE_MARKER = DND_ROOT + '/.runtime/active-campaign.json'

/** Skill root — the bundled SRD datasets live under here. */
export const SKILL_ROOT = DND_ROOT + '/.agents/skills/dnd'

/**
 * Strip a leading UTF-8 BOM.
 *
 * The campaign marker is written by Python (the skill's runtime dir helper),
 * and on Windows Python writes UTF-8 *with* a BOM. `JSON.parse` rejects the
 * leading \uFEFF with "Unexpected token", which surfaced as "no active
 * campaign" for a marker that plainly existed. v0.1.0 had the same bare
 * JSON.parse and the same latent failure.
 *
 * @param text - file contents.
 * @returns the contents without a leading BOM.
 */
export function stripBom(text) {
  return String(text).replace(/^\uFEFF/, '')
}

/**
 * Parse JSON, tolerating a UTF-8 BOM.
 * @param text - file contents.
 */
export function parseJsonLoose(text) {
  return JSON.parse(stripBom(text))
}

/**
 * Read the active campaign name from the runtime marker.
 * @param fs - the host fs service.
 * @returns the campaign name, or undefined when no campaign is active.
 */
export async function readActiveCampaign(fs) {
  try {
    if (fs === undefined) return undefined
    const target = await fs.resolve(ACTIVE_MARKER)
    if ((await fs.stat(target)) === undefined) return undefined
    const parsed = parseJsonLoose(await fs.readText(target))
    return typeof parsed.name === 'string' && parsed.name !== '' ? parsed.name : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the active campaign and its directory.
 * @param fs - the host fs service.
 * @returns `{ campaign, dir }`, or undefined when no campaign is active.
 */
export async function activeCampaignDir(fs) {
  const campaign = await readActiveCampaign(fs)
  if (campaign === undefined) return undefined
  return { campaign, dir: `${DND_ROOT}/campaigns/${campaign}` }
}

/**
 * Test whether a path exists.
 * @param fs - the host fs service.
 * @param path - absolute path in the fs service's own coordinate space.
 */
export async function exists(fs, path) {
  try {
    return (await fs.stat(await fs.resolve(path))) !== undefined
  } catch {
    return false
  }
}

/**
 * Read a file's text, or undefined when it does not exist / cannot be read.
 * @param fs - the host fs service.
 * @param path - absolute path.
 */
export async function readTextOrUndefined(fs, path) {
  try {
    const target = await fs.resolve(path)
    if ((await fs.stat(target)) === undefined) return undefined
    return await fs.readText(target)
  } catch {
    return undefined
  }
}

/**
 * List the file entries of a directory (never throws).
 * @param fs - the host fs service.
 * @param dir - absolute directory path.
 * @returns entries with `name` and `target`; empty when unreadable.
 */
export async function listFiles(fs, dir) {
  try {
    const target = await fs.resolve(dir)
    const stat = await fs.stat(target)
    if (stat === undefined || stat.type !== 'directory') return []
    const entries = await fs.listDir(target)
    return entries.filter((e) => e.type === 'file')
  } catch {
    return []
  }
}

/**
 * List markdown files in a directory, sorted by name.
 * @param fs - the host fs service.
 * @param dir - absolute directory path.
 */
export async function listMarkdown(fs, dir) {
  const files = await listFiles(fs, dir)
  return files.filter((f) => /\.md$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Split a markdown document into `## Heading` sections.
 * @param text - the document.
 * @param headingLevel - `2` for `##` (default) or `3` for `###`.
 * @returns a Map of heading text to body (without the heading line).
 */
export function splitSections(text, headingLevel = 2) {
  const re = new RegExp(`^#{${headingLevel}}\\s+(.+)$`)
  const out = new Map()
  let current = '(preamble)'
  out.set(current, '')
  for (const raw of String(text).split(/\r?\n/)) {
    const match = raw.match(re)
    if (match !== null) {
      current = match[1].trim()
      if (!out.has(current)) out.set(current, '')
      continue
    }
    out.set(current, (out.get(current) ?? '') + raw + '\n')
  }
  return out
}

/**
 * Find the first section whose heading contains `needle`, case-insensitively.
 * @param text - the document.
 * @param needle - heading fragment, e.g. "situation" or "live state".
 * @returns the section body, or undefined.
 */
export function findSection(text, needle) {
  const key = String(needle).toLowerCase()
  for (const [heading, body] of splitSections(text)) {
    if (heading.toLowerCase().includes(key)) return { heading, body: body.trim() }
  }
  return undefined
}

/**
 * Pull the first capture of a regex out of a string.
 * @param text - haystack.
 * @param re - a regex with at least one capture group.
 * @returns the trimmed capture, or '' when absent.
 */
export function grab(text, re) {
  const match = String(text).match(re)
  return match !== null && match[1] !== undefined ? match[1].trim() : ''
}

/**
 * Parse a base-10 integer, returning null rather than NaN when absent.
 * @param text - haystack.
 * @param re - a regex with one capture group.
 */
export function grabInt(text, re) {
  const value = grab(text, re)
  if (value === '') return null
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

/** Escape a string for literal use inside a RegExp. */
export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A tiny keyed cache with mtime invalidation, for expensive parses.
 *
 * `dnd_srd_lookup` re-parsed a 1453-entry JSON document on every call in
 * v0.1.0. A cache keyed on the file's mtime keeps that to one parse per file
 * version, without ever serving stale data after a dataset rebuild.
 */
export class MtimeCache {
  constructor() {
    this.entries = new Map()
  }

  /**
   * Get a cached value, loading it when the stamp changed.
   * @param key - cache key.
   * @param stamp - any cheap change token (e.g. `${mtime}:${size}`).
   * @param load - async producer invoked only on a miss.
   */
  async get(key, stamp, load) {
    const hit = this.entries.get(key)
    if (hit !== undefined && hit.stamp === stamp) return hit.value
    const value = await load()
    this.entries.set(key, { stamp, value })
    return value
  }
}
