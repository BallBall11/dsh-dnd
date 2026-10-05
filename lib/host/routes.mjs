/**
 * routes.mjs — the HTTP surface the Client panel reads.
 *
 * ## Why routes instead of a live call
 *
 * A dynamic Cordis plugin can call the host through `harness.handle` +
 * `host.call`. An installed bundle cannot: that path requires a `pluginId` and
 * `pluginRunId`, which only exist for a plugin the dynamic runner is hosting.
 * v0.1.0 shipped a panel built on `host.call` and it could never have worked.
 * A bundle talks to the host over plain HTTP.
 *
 * ## What this deliberately does NOT do
 *
 * The reference implementation (`dsh-task-board`) fences its routes with a
 * loopback check, a CSRF tripwire, a proxy token and a body-size cap. This
 * module has none of that, on purpose:
 *
 *   `dsh-task-board` ships to every DSH user, who may bind `0.0.0.0`, sit
 *   behind a reverse proxy, or expose the port. It has to defend itself.
 *
 *   `dsh-dnd` runs on the author's own machine for their own campaign. The
 *   deployment binds `127.0.0.1` by default
 *   (`dsh-web-app/cordis.patch.yml`: `ctx.webStartup.host ?? '127.0.0.1'`),
 *   and a LAN-exposed port requires someone to deliberately reconfigure it.
 *   Guarding against that inside every plugin is the wrong layer: the fix
 *   would belong to the bind address, not to each route.
 *
 * Copying the reference's defence would be applying a solution to a problem
 * this plugin does not have. See docs/REWRITE-PLAN.md §"关于安全层".
 *
 * ## The one thing that IS load-bearing
 *
 * `webServer.register()` throws on a duplicate `(kind, path)`, because route
 * patterns are a composition-level contract. A reload re-runs `apply`, so a
 * disposer that is dropped rather than registered with `ctx.effect()` makes
 * the second mount fail outright. That is a correctness requirement, not a
 * security one.
 */

import { readCharacter, listCharacters } from './tools/state-io.mjs'
import { activeCampaignDir, exists, routeRoot, readCampaignRuleset } from './tools/shared.mjs'
import { validateState, formatFindings, formatCurrency } from './tools/state-rules.mjs'
import { buildPanelMeta, extractFeatures } from './tools/panel-meta.mjs'

/** Route namespace. Kept under one prefix so the surface is obvious. */
export const API_PREFIX = '/dnd'

/** This plugin's routes. */
export const ROUTES = [
  { kind: 'exact', path: `${API_PREFIX}/characters` },
  { kind: 'exact', path: `${API_PREFIX}/meta` },
  { kind: 'exact', path: `${API_PREFIX}/health` },
]

/**
 * Build the route handlers.
 *
 * @param ctx - the host context; `fs` is read per request so a late- or
 *   re-registered filesystem is picked up rather than frozen at mount time.
 * @returns a map of `path -> handler`.
 */
export function buildHandlers(ctx) {
  const getFs = () => ctx.get('fs')

  /**
   * Resolve the active campaign's character directory, or an error. The root
   * comes from routeRoot() — the live session workspace — NEVER silently from
   * the process fallback: `warnings` travels into every response so the panel
   * says so when the fallback had to be used.
   */
  async function locate() {
    const fs = getFs()
    if (fs === undefined) return { error: 'fs service unavailable', status: 503 }
    const origin = routeRoot(ctx)
    const found = await activeCampaignDir(fs, { header: { cwd: origin.root } })
    if (found === undefined) {
      return {
        error: 'No active campaign. Load one with /dm:dnd load <campaign> (this writes .runtime/active-campaign.json).',
        status: 404,
        warnings: origin.warnings,
        rootSource: origin.source,
      }
    }
    if (found === undefined) {
      return {
        error: 'No active campaign. Load one with /dm:dnd load <campaign> (this writes .runtime/active-campaign.json).',
        status: 404,
      }
    }
    // The marker names a campaign; it does not prove one exists. Without this
    // check a stale marker pointing at a deleted campaign reads as "this
    // campaign has no characters", which sends the DM looking in the wrong
    // place entirely.
    const dir = `${found.dir}/characters`
    if (!(await exists(fs, found.dir))) {
      return {
        error: `Active campaign "${found.campaign}" has no directory at ${found.dir}. The marker in .runtime/active-campaign.json is stale.`,
        status: 404,
        warnings: origin.warnings,
        rootSource: origin.source,
      }
    }
    return { fs, campaign: found.campaign, dir, campaignDir: found.dir, warnings: origin.warnings, rootSource: origin.source }
  }

  return {
    /**
     * `GET /dnd/characters` — every character in the active campaign.
     *
     * Returns the state as stored, plus the display strings the panel would
     * otherwise have to reimplement: formatted money and the generated
     * summary. Findings from validation are included rather than withheld, so
     * the panel can show a doubtful value instead of hiding it.
     */
    async [`${API_PREFIX}/characters`](req, res) {
      const found = await locate()
      if (found.error !== undefined) {
        return sendJson(res, found.status, { error: found.error, warnings: found.warnings ?? [], rootSource: found.rootSource })
      }

      // `?include=enemies` adds the hostile cards. The default stays PC-only:
      // the panel's primary view is the party, and an old client that does not
      // know the query must keep reading the same response shape.
      const includeEnemies = (() => {
        try { return new URL(req.url, 'http://localhost').searchParams.get('include') === 'enemies' }
        catch { return false }
      })()

      const { fs, campaign, dir, campaignDir } = found
      const listed = await listCharacters(fs, dir)
      const characters = []
      const enemies = []
      const warnings = []
      let excludedNonPC = 0

      for (const { name, hasStateFile } of listed) {
        const c = await readCharacter(fs, dir, name)
        // The campaign characters/ directory is home to PCs AND monster
        // statblocks — the frontmatter tags are the model's distinction.
        // Missing tags count as `pc`: every card written before the
        // distinction existed is a PC. `enemy` cards surface only through
        // `?include=enemies`; `npc` cards stay readable through the tools.
        const tags = Array.isArray(c.metadata?.tags) ? c.metadata.tags : ['pc']
        const isPC = tags.includes('pc')
        const isEnemy = tags.includes('enemy')
        if (!isPC) {
          if (!isEnemy) { excludedNonPC += 1; continue }
          if (!includeEnemies) continue
        }
        for (const w of c.warnings) warnings.push(`${name}: ${w}`)
        if (c.state === null) {
          const entry = { name, hasStateFile, error: 'no readable state' }
          if (isPC) characters.push(entry)
          else enemies.push(entry)
          continue
        }
        const findings = validateState(c.state)
        const entry = {
          name,
          hasStateFile,
          needsMigration: c.needsMigration,
          state: c.state,
          // Display-only projections, so the panel does not format money or
          // recompute modifiers on its own and drift from the host.
          display: {
            currency: formatCurrency(c.state.currency),
            hp: c.state.combat.hp,
            level: c.state.identity.level,
            class: c.state.identity.class,
            race: c.state.identity.race,
          },
          findings: formatFindings(findings),
        }
        if (isPC) {
          // Features & Traits is narrative in the sheet model, so the
          // structured state cannot carry it. The panel shows the list, so the
          // Host extracts it here rather than teaching the client to parse
          // sheet markdown — one parser, and it lives with the writer.
          entry.features = extractFeatures(c.narrative)
          characters.push(entry)
        } else {
          // An enemy card is a combat read: real HP (the videogame view the
          // players plan with), AC, and the live conditions — including the
          // `dead` mark dnd_attack leaves when a hostile reaches 0 HP. No
          // purse, no spellbook: those are PC-only sections.
          entry.display.conditions = Array.isArray(c.state.conditions) ? c.state.conditions : []
          entry.display.ac = c.state.combat.ac
          entry.tags = tags
          enemies.push(entry)
        }
      }

      sendJson(res, 200, {
        campaign,
        characters,
        ...(includeEnemies ? { enemies } : {}),
        // Which ruleset the campaign declares — the panel uses it to pick the
        // right per-class feature table out of /dnd/meta.
        ruleset: await readCampaignRuleset(fs, campaignDir),
        warnings: [...(found.warnings ?? []), ...warnings],
        rootSource: found.rootSource,
        // Reported so a client can tell an empty campaign from a broken one.
        counts: {
          characters: characters.length,
          withStateFile: characters.filter((c) => c.hasStateFile).length,
          excludedNonPC,
          enemies: enemies.length,
        },
      })
    },

    /**
     * `GET /dnd/meta` — the display index the panel renders against: the
     * EN->CN maps, per-spell combat info (dice / damage type / save), the
     * per-class per-level feature tables, and the weapon/armor index. Built
     * from the shipped datasets and data/i18n-zh.json, cached per process.
     */
    async [`${API_PREFIX}/meta`](req, res) {
      const fs = getFs()
      if (fs === undefined) return sendJson(res, 503, { error: 'fs service unavailable' })
      const built = await buildPanelMeta(fs)
      if (built.error !== undefined) return sendJson(res, 500, { error: built.error })
      sendJson(res, 200, built.data)
    },

    /** `GET /dnd/health` — whether the panel's data source is usable at all. */
    async [`${API_PREFIX}/health`](req, res) {
      const fs = getFs()
      if (fs === undefined) {
        return sendJson(res, 200, { ok: false, fs: false, campaign: null, reason: 'fs service unavailable' })
      }
      const origin = routeRoot(ctx)
      const found = await activeCampaignDir(fs, { header: { cwd: origin.root } })
      if (found === undefined) {
        return sendJson(res, 200, { ok: false, fs: true, campaign: null, reason: 'no active campaign', warnings: origin.warnings, rootSource: origin.source })
      }
      // A marker without a directory is a distinct failure from no marker at
      // all: one means "load a campaign", the other means "the one you loaded
      // is gone". Reporting both as `campaign: null` would hide that.
      if (!(await exists(fs, found.dir))) {
        return sendJson(res, 200, {
          ok: false,
          fs: true,
          campaign: found.campaign,
          reason: `campaign directory missing: ${found.dir}`,
        })
      }
      sendJson(res, 200, { ok: true, fs: true, campaign: found.campaign, rootSource: origin.source, warnings: origin.warnings })
    },
  }
}

/** Write a JSON response. One helper, so every route answers the same way. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // The panel polls; a cached response would show stale numbers.
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Mount every route.
 *
 * @param ctx - a context that HAS `webServer` in scope. The outer context of a
 *   plugin that does not declare `webServer` in `inject` will not have it; use
 *   `ctx.inject(['webServer'], (webCtx) => mountRoutes(webCtx))` and pass the
 *   callback's scoped context.
 * @returns a disposer removing every route registered here.
 * @throws when `webServer` is unavailable. Returning null here is what hid a
 *   broken panel for an entire debugging session: the caller could not tell
 *   "no web server in this run" from "registration failed", and the symptom —
 *   a 404 with an empty body — looked like a routing mistake rather than a
 *   wiring one.
 */
export function mountRoutes(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    throw new Error(
      'dsh-dnd: webServer is not in scope. Mount routes from '
      + "ctx.inject(['webServer'], (webCtx) => mountRoutes(webCtx)), not from the outer context.",
    )
  }

  const handlers = buildHandlers(ctx)
  const disposers = []
  for (const route of ROUTES) {
    const handler = handlers[route.path]
    if (handler === undefined) continue
    // The disposer is collected, never dropped: a duplicate (kind, path)
    // throws, so a reload with a leaked route would fail to mount.
    disposers.push(webServer.register({ kind: route.kind, path: route.path, handler }))
  }
  return () => { for (const dispose of disposers) dispose() }
}
