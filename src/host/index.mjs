/**
 * Host entry — the node half of the dsh-dnd bundle.
 *
 * Plain ESM: this half really is a module. (`cordis.patch.yml` mounts the row
 * by bare package name, and node resolves this file through `exports["."]`.)
 *
 * The tool families live in ./tools/*.mjs, each owning one domain and exposing
 * `buildTools(ctx)`. This file only composes them, so a family can be read,
 * tested, or disabled on its own.
 *
 *   tools/roll.mjs      dnd_roll dnd_check dnd_attack dnd_save dnd_mastery dnd_dc
 *   tools/lookup.mjs    dnd_srd_lookup
 *   tools/campaign.mjs  dnd_campaign_state dnd_campaign_search dnd_arc_status
 *   tools/sheet.mjs     dnd_character_get
 *   tools/character-create.mjs  dnd_character_create
 *   tools/track.mjs     dnd_track dnd_spend dnd_xp_add
 *   tools/calendar.mjs  dnd_calendar
 *   tools/initiative.mjs  dnd_initiative dnd_initiative_end
 *   tools/effects.mjs   dnd_effect dnd_concentration dnd_death_save
 *   tools/panel.mjs     dnd_panel_status
 *
 * track.mjs is the only family that writes. Everything above it is pure, which
 * is what lets the write path be reasoned about on its own.
 *
 * The webServer routes that feed the client panel live in routes.mjs. That
 * channel is HTTP because v0.1.0's host.call / harness.handle approach cannot
 * work for a bundle at all (both require a pluginId + pluginRunId that only
 * dynamic plugins have).
 */

import * as roll from './tools/roll.mjs'
import * as characterCreate from './tools/character-create.mjs'
import * as panel from './tools/panel.mjs'
import * as lookup from './tools/lookup.mjs'
import * as campaign from './tools/campaign.mjs'
import * as sheet from './tools/sheet.mjs'
import * as track from './tools/track.mjs'
import * as calendar from './tools/calendar.mjs'
import * as initiative from './tools/initiative.mjs'
import * as effects from './tools/effects.mjs'
import { mountRoutes } from './routes.mjs'
import { createProbeState, setWriteProbeState } from './tools/write-probe.mjs'

/**
 * Every tool family, in mount order.
 *
 * Exported so host.test.mjs can derive the expected tool count instead of
 * hard-coding it. A hard-coded 14 was correct until T8/T9/T10 each added a
 * family, at which point three unrelated suites would have gone red for a
 * change that was entirely intended. Deriving the number from this list keeps
 * "every family registered" as the actual invariant under test.
 */
export const FAMILIES = [roll, lookup, campaign, sheet, characterCreate, track, calendar, initiative, effects, panel]

export const name = 'dnd-host'

/**
 * Services this plugin hard-depends on. Cordis holds the fiber until these
 * exist, and reactivates it if one appears later.
 *
 * `tools` is the only hard dependency, because it is the only one whose
 * absence makes the plugin meaningless.
 *
 * `fs` is deliberately NOT here, and that is a considered choice rather than an
 * oversight. Two facts drive it:
 *
 *   1. It would be an over-broad gate. tools/roll.mjs is six tools of pure
 *      arithmetic that need no filesystem at all. Declaring fs as a hard
 *      dependency means a filesystem outage unmounts those six as collateral
 *      damage, which contradicts the per-family failure isolation this plugin
 *      is built around (see the try/catch in apply below).
 *
 *   2. It is not needed for correctness. The original live failure was NOT
 *      the missing declaration — it was that the families captured
 *      `ctx.get('fs')` once at mount and never looked again, so a mount that
 *      lost the startup race cached `undefined` forever. Reading the service
 *      lazily per call (which every family now does) fixes that on its own,
 *      and additionally survives a filesystem that is re-registered later.
 *
 * So: tools hard, fs soft-but-required-per-tool. The five fs-backed tools each
 * report "fs service unavailable" when it is missing; the six pure ones keep
 * working, which is what the isolation is for.
 */
export const inject = ['tools']

/**
 * Mount every tool family.
 * @param ctx - the host context.
 * @returns a disposer removing every registration this mount made.
 */
export function apply(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('dsh-dnd: tools service unavailable')

  const disposers = []
  const failed = []

  for (const family of FAMILIES) {
    try {
      for (const tool of family.buildTools(ctx)) {
        const dispose = tools.register(tool)
        disposers.push(typeof dispose === 'function' ? dispose : () => {})
      }
    } catch (error) {
      // One broken family must not take down the other three, and must not
      // take down the profile's boot either.
      failed.push(`${family.name ?? 'unknown'}: ${error && error.message ? error.message : error}`)
    }
  }

  if (failed.length > 0) {
    const logger = ctx.get('logger')
    for (const message of failed) {
      if (logger !== undefined && typeof logger.warn === 'function') {
        logger.warn('[dsh-dnd] family failed — ' + message)
      }
    }
  }

  // ── Startup write self-check (T6) ────────────────────────────────────────
  //
  // The defect behind this whole board was ASYMMETRIC: reads and dice worked,
  // only writes were refused. A session therefore looked healthy right up to
  // the moment a DM discovered nothing had been saved.
  //
  // The probe is NOT run here, and that is the load-bearing decision. At mount
  // there is no session, so a probe could only ever test the process-cwd
  // fallback — a configuration NO real write uses, because every write tool
  // resolves its caller's session policy (T2, session-scope.mjs). Probing here
  // would therefore report a FALSE FAILURE on a perfectly healthy host.
  //
  // Instead the probe runs on the FIRST write-tool call, where `exec.agent`
  // yields a genuine session. See runWriteSelfCheck in write-probe.mjs.
  setWriteProbeState(createProbeState())

  // The HTTP surface the Client panel reads.
  //
  // `webServer` is a SOFT dependency, so it is reached through
  // `ctx.inject(['webServer'], cb)` rather than declared in `inject`. That
  // matters for two reasons:
  //
  //   Declaring it in `inject` would make the plugin's mount depend on a web
  //   server. A headless run has none, and the fourteen tools — the plugin's
  //   main purpose — must keep working there.
  //
  //   `ctx.inject` also hands back a SCOPED CHILD CONTEXT whose fiber belongs
  //   to `webServer`. Registering through it is what the platform's own
  //   plugins do (dsh-client-connection:758, dsh-client-modules:487) and it is
  //   load-bearing: calling `ctx.effect` on the outer context, which declares
  //   no webServer dependency, registers the route nowhere. That failure is
  //   silent — `register()` succeeds and returns a disposer, the route simply
  //   never answers, and the SPA fallback returns 404 with an empty body.
  //   Observed exactly that way before this fix.
  //
  // `ctx.effect` is still correct *inside* the scoped context: it ties the
  // route disposers to a fiber, so unloading removes them. Without it a
  // reload would leave the route registered and the next mount would throw on
  // the duplicate.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      // Throws rather than returning null when it cannot mount, so a wiring
      // fault is visible instead of surfacing as an empty 404 much later.
      return mountRoutes(webCtx)
    }, 'dsh-dnd routes')
  })

  // A fiber effect must be a function, nullish, or an iterable of disposers.
  // Returning a bare object throws `Invalid effect` and unwinds everything
  // collected above.
  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* a failing disposer must not block the rest */ }
    }
  }
}
