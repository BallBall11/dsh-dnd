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
 *
 * Stage 2 adds tools/track.mjs (writes) plus the webServer routes that feed the
 * client panel — that channel is deliberately absent here, because v0.1.0's
 * host.call / harness.handle approach cannot work for a bundle at all (both
 * require a pluginId + pluginRunId that only dynamic plugins have).
 */

import * as roll from './tools/roll.mjs'
import * as lookup from './tools/lookup.mjs'
import * as campaign from './tools/campaign.mjs'
import * as sheet from './tools/sheet.mjs'

/** Every tool family, in mount order. */
const FAMILIES = [roll, lookup, campaign, sheet]

export const name = 'dnd-host'

/**
 * Hard dependency: the fiber waits for `tools` rather than reading an
 * undefined ctx property. `fs` is intentionally NOT injected — some tools
 * work without it, and the families that need it degrade with a message
 * instead of failing the whole mount.
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

  // A fiber effect must be a function, nullish, or an iterable of disposers.
  // Returning a bare object throws `Invalid effect` and unwinds everything
  // collected above.
  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* a failing disposer must not block the rest */ }
    }
  }
}
