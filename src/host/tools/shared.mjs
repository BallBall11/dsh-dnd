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
 * The error every unresolvable-root path funnels into. One string, so tools
 * phrase the failure identically and the fix is always stated: this is a
 * configuration problem for the USER to resolve, not something the bundle can
 * guess its way out of.
 *
 * Background: the data root is the DSH SESSION's workspace (`session.header.cwd`),
 * resolved per tool call — a campaign follows the workspace the session was
 * opened in, so the bundle is portable across machines. When no session takes
 * part (HTTP routes, unit tests calling `execute(args)` directly), the explicit
 * `DND_ROOT` / `DSH_CWD` env is the ONLY fallback. A hard-coded `D:/DND` used
 * to sit at the end of that chain, which meant "could not tell where the data
 * is" silently became "operating on D:/DND" — plausible-looking answers from a
 * workspace nobody chose.
 */
export const ROOT_ERROR = '无法解析数据根：本调用既没有携带工作区的 dsh 会话，也未设置 DND_ROOT / DSH_CWD 环境变量。'
  + '请在目标工作区中打开 dsh 后重试，或显式设置 DND_ROOT 指向战役数据目录。'

/**
 * The env-configured root, or undefined. Read LAZILY — tests and embedded
 * hosts set DND_ROOT after this module has been imported, and a load-time
 * snapshot would freeze whatever the process was launched with.
 * @returns the explicit root, or undefined when none is set.
 */
export function envRoot() {
  const fromEnv = process.env.DND_ROOT ?? process.env.DSH_CWD
  return fromEnv === undefined || fromEnv === '' ? undefined : fromEnv
}

/**
 * Resolve the data root a call should use, or undefined when it cannot be
 * determined. Callers must treat undefined as ROOT_ERROR — loud, addressed to
 * the user — never as "somewhere plausible".
 * @param session - the live Session (session-scope's `sessionOf`), or undefined.
 * @returns the session's workspace, or the env-configured root, or undefined.
 */
export function dndRoot(session) {
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd !== '') return cwd
  return envRoot()
}

/**
 * Resolve the data root for the HTTP routes, which — unlike a tool call —
 * carry NO session. The store's `list()` returns every live session in
 * creation order, so the LAST entry is the most recently opened one: the
 * workspace the DM is looking at. This is what broke in the field report:
 * with no session to ask, the routes fell back to the process-level root and
 * served ANOTHER workspace's campaign while looking perfectly healthy.
 *
 * Fallback is never silent: the caller must surface the returned warnings in
 * its response, so a panel shows "this data came from the env root"
 * instead of plausible data from the wrong campaign. When NO root can be
 * determined — no live session carries a workspace and no env is set — the
 * result is an error, not a guessed directory.
 *
 * @param ctx - the host context.
 * @returns `{ root, source, warnings }` with `source` `'session'` or `'env'`,
 *   or `{ error: ROOT_ERROR, warnings }` when unresolvable.
 */
export function routeRoot(ctx) {
  const warnings = []
  const candidates = []
  try {
    const sessions = ctx.get('sessions')
    if (sessions !== undefined && typeof sessions.list === 'function') {
      for (const session of sessions.list()) {
        const cwd = session?.header?.cwd
        if (typeof cwd !== 'string' || cwd === '') continue
        const normalized = cwd.replace(/\\/g, '/')
        if (!candidates.includes(normalized)) candidates.push(normalized)
      }
    }
  } catch {
    // Enumeration is best-effort; the env root below keeps the panel alive.
  }
  if (candidates.length === 0) {
    const env = envRoot()
    if (env === undefined) {
      return { error: ROOT_ERROR, warnings }
    }
    warnings.push('面板数据来自 DND_ROOT 环境变量指定的根 ' + env
      + '（未能从存活会话解析出工作区）。若这不是预期工作区，请在目标工作区中打开 dsh。')
    return { root: env, source: 'env', warnings }
  }
  const root = candidates[candidates.length - 1]
  if (candidates.length > 1) {
    warnings.push('检测到多个存活会话工作区：' + candidates.join('、')
      + '；已采用最近打开的 ' + root + '。若不是预期工作区，请关闭多余的 dsh 会话。')
  }
  return { root, source: 'session', warnings }
}

/**
 * The active-campaign marker, under the call's data root. Written at
 * /dm:dnd load; tells every tool which campaign is in play. Undefined when no
 * data root can be resolved — callers treat that as ROOT_ERROR.
 */
export function activeMarker(session) {
  const root = dndRoot(session)
  return root === undefined ? undefined : `${root}/.runtime/active-campaign.json`
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
    const marker = activeMarker(session)
    if (marker === undefined) return undefined
    const target = await fs.resolve(marker)
    if ((await fs.stat(target)) === undefined) return undefined
    const parsed = parseJsonLoose(await fs.readText(target))
    return typeof parsed.name === 'string' && parsed.name !== '' ? parsed.name : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the active campaign and its directory.
 *
 * The result is a discriminated union so a caller can distinguish three
 * answers that used to collapse into one:
 *   - `{ error: ROOT_ERROR }` — no data root could be resolved. LOUD: the tool
 *     must return it verbatim, because the fix belongs to the user.
 *   - `undefined` — a root exists but no active campaign is set.
 *   - `{ campaign, dir }` — resolved; proceed.
 *
 * @param fs - the host fs service.
 * @param session - the live Session, or undefined.
 */
export async function activeCampaignDir(fs, session) {
  const root = dndRoot(session)
  if (root === undefined) return { error: ROOT_ERROR }
  const campaign = await readActiveCampaign(fs, session)
  if (campaign === undefined) return undefined
  return { campaign, dir: `${root}/campaigns/${campaign}` }
}

/**
 * The campaign's declared ruleset, from state.md frontmatter
 * ("**Ruleset**: 2024"). Defaults to "2014" — the same default the SRD lookup
 * uses — when the file is absent, unreadable, or silent on the point. Callers
 * echo the value back so the DM always sees which rules a card or answer was
 * built under instead of guessing.
 * @param fs - the host fs service.
 * @param dir - the campaign directory.
 * @returns "2014" or "2024".
 */
export async function readCampaignRuleset(fs, dir) {
  try {
    const text = await fs.readText(await fs.resolve(`${dir}/state.md`))
    const match = String(text).match(/^\s*[-*]?\s*\**\s*Ruleset:?\**\s*:?\s*(2014|2024)\b/im)
    if (match !== null) return match[1]
  } catch { /* fall through to the default */ }
  return '2014'
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
