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

/**
 * Data root. Campaigns and characters live here; the plugin's data/ does not.
 *
 * The root is the DSH SESSION's workspace (`session.header.cwd`), resolved per
 * tool call — a campaign follows the workspace the session was opened in, so
 * the bundle is portable across machines. When no session takes part (HTTP
 * routes, unit tests calling `execute(args)` directly), the fallback chain is
 * `DND_ROOT` / `DSH_CWD` env, then the historical literal.
 */
export const DND_ROOT = process.env.DND_ROOT ?? process.env.DSH_CWD ?? 'D:/DND'

/**
 * Resolve the data root a call should use.
 * @param session - the live Session (session-scope's `sessionOf`), or undefined.
 * @returns the session's workspace, or the fallback root.
 */
export function dndRoot(session) {
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : DND_ROOT
}

/**
 * The active-campaign marker, under the call's data root. Written at
 * /dm:dnd load; tells every tool which campaign is in play.
 */
export function activeMarker(session) {
  return `${dndRoot(session)}/.runtime/active-campaign.json`
}

/**
 * The bundle's own `data/` directory — the SRD datasets the package ships.
 *
 * These datasets used to be read out of `D:/DND/.agents/skills/dnd/data/`, the
 * installed skill's CODE root. That skill was deleted deliberately, which left
 * `dnd_srd_lookup` reporting "SRD dataset not found" for a dataset that was
 * merely somewhere else. The real defect was the ownership model: a shipped
 * lookup table is a dependency OF THIS PLUGIN, so it belongs inside the
 * package, not in the campaign workspace where any cleanup can take it away.
 *
 * Resolved from `import.meta.url` rather than from a configured root, because
 * the row mounts by bare package name and this file IS the anchor: wherever the
 * package is installed (here a `link:` junction, later a registry tarball),
 * `data/` is two directories up from `lib/host/tools/`. A configured path would
 * reintroduce exactly the failure this replaced — a location that is correct
 * only for one machine's layout.
 *
 * `import.meta` is a language feature, not an imported builtin, so this module
 * still imports nothing (see above). The `data/` dir is plain data, not code:
 * scripts/build.mjs copies only `src/host/**.mjs` into `lib/`, so it must live
 * at the package root to survive a build.
 */
export const DATA_ROOT = new URL('../../../data', import.meta.url).pathname
  // Windows: URL pathnames are `/D:/...`; the fs service wants `D:/...`.
  .replace(/^\/([A-Za-z]:)/, '$1')

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
 * @param session - the live Session, or undefined (then the fallback root is used).
 * @returns the campaign name, or undefined when no campaign is active.
 */
export async function readActiveCampaign(fs, session) {
  try {
    if (fs === undefined) return undefined
    const target = await fs.resolve(activeMarker(session))
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
 * @param session - the live Session, or undefined.
 * @returns `{ campaign, dir }`, or undefined when no campaign is active.
 */
export async function activeCampaignDir(fs, session) {
  const campaign = await readActiveCampaign(fs, session)
  if (campaign === undefined) return undefined
  return { campaign, dir: `${dndRoot(session)}/campaigns/${campaign}` }
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
 *
 * Accepts either an absolute path string or an already-resolved FsTarget, so
 * callers can hand back a directory entry's `target` without re-resolving it.
 *
 * @param fs - the host fs service.
 * @param pathOrTarget - absolute path, or an FsTarget from resolve/listDir.
 */
export async function readTextOrUndefined(fs, pathOrTarget) {
  try {
    const target = typeof pathOrTarget === 'string' ? await fs.resolve(pathOrTarget) : pathOrTarget
    if (target === undefined || target === null) return undefined
    if ((await fs.stat(target)) === undefined) return undefined
    return await fs.readText(target)
  } catch {
    return undefined
  }
}

/**
 * List the file entries of a directory (never throws).
 *
 * Note on the host fs contract: `stat` and `listDir` take a **FsTarget**
 * (the object `resolve` returns), not a path string. Passing a string happens
 * to work against a naive mock but silently yields an empty listing against
 * the real backend, which is how v0.2.0-stage1 shipped a character tool that
 * reported "No character sheets found" for a directory that plainly had one.
 *
 * Each returned entry therefore carries BOTH:
 *   - `name`   the bare filename
 *   - `target` the resolved FsTarget, to hand straight back to readText
 *   - `path`   a display path, for building sibling paths as strings
 *
 * @param fs - the host fs service.
 * @param dir - absolute directory path.
 * @returns entries with `name`, `target` and `path`; empty when unreadable.
 */
export async function listFiles(fs, dir) {
  try {
    const target = await fs.resolve(dir)
    const info = await fs.stat(target)
    if (info === undefined || info.type !== 'directory') return []
    const entries = await fs.listDir(target)
    return entries
      .filter((e) => e.type === 'file')
      .map((e) => ({
        name: e.name,
        target: e.target,
        // Prefer the backend's own display path; fall back to joining.
        path: e.target !== undefined && typeof e.target.displayPath === 'string'
          ? e.target.displayPath
          : `${String(dir).replace(/\/$/, '')}/${e.name}`,
      }))
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
