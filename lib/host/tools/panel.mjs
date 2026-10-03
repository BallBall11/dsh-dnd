/**
 * tools/panel.mjs — dnd_panel_status.
 *
 * ## What this tool is for
 *
 * The panel reads GET /dnd/characters, whose data root is resolved from the
 * live session store (shared.mjs's routeRoot). That resolution is exactly the
 * thing a field report showed can surprise you: a panel can point at a
 * different workspace's campaign while looking healthy. This tool is the DM's
 * (and dsh's) way to ASK what the panel is actually serving right now — the
 * same resolution, the same campaign, the same character list, as a tool
 * result that can be read in conversation rather than in a browser.
 *
 * It is deliberately a READ of the same pipeline, not a second data path:
 * there is no snapshot copy to drift, and nothing here writes.
 */

import { activeCampaignDir, routeRoot } from './shared.mjs'
import { sessionOf } from './session-scope.mjs'
import { listCharacters } from './state-io.mjs'
import { validateState, formatFindings, formatCurrency } from './state-rules.mjs'
import { readCharacter } from './state-io.mjs'

/** Render a plain string result for the model. */
const renderText = (_args, value) => [{ type: 'text', text: String(value) }]

/**
 * Build this module's tools.
 * @param ctx - the host context.
 * @returns an array of tool definitions.
 */
export function buildTools(ctx) {
  const getFs = () => ctx.get('fs')

  const refresh = {
    name: 'dnd_panel_status',
    description: 'Report exactly what the Client character panel is (or would be) serving right now: the resolved data root, the active campaign and its characters with headline numbers. Call it to verify the panel points at the expected workspace and campaign — e.g. after opening a new workspace or before trusting the panel in play. Reads only; writes nothing.',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'

      // The session comes from the CALL when dsh invokes this tool, so the
      // tool-side view uses the caller's workspace. The HTTP route side uses
      // routeRoot()'s live-session resolution; both are reported so a mismatch
      // between "what my session says" and "what the panel serves" is visible
      // in one reply.
      const session = sessionOf(ctx, exec)
      const origin = routeRoot(ctx)
      const toolRoot = typeof session?.header?.cwd === 'string' && session.header.cwd !== ''
        ? session.header.cwd.replace(/\\/g, '/')
        : origin.root

      const lines = []
      if (toolRoot.replace(/\\/g, '/') !== origin.root) {
        lines.push('NOTE: the calling session workspace (' + toolRoot
          + ') differs from the panel\'s resolved root (' + origin.root + '). '
          + 'The panel serves the resolved root; close stale dsh sessions or restart if this is unexpected.')
      }

      const found = await activeCampaignDir(fs, { header: { cwd: origin.root } })
      if (found === undefined) {
        lines.push('Panel data root: ' + origin.root + ' (' + origin.source + ')')
        lines.push('No active campaign is visible to the panel — it would show "no characters".')
        return lines.join('\n')
      }

      lines.push('Panel data root: ' + origin.root + ' (' + origin.source + ')')
      lines.push('Active campaign: ' + found.campaign)

      const dir = found.dir + '/characters'
      const listed = await listCharacters(fs, dir)
      if (listed.length === 0) {
        lines.push('Characters: none. The panel would show an empty party.')
        return lines.join('\n')
      }
      for (const { name, hasStateFile } of listed) {
        const c = await readCharacter(fs, dir, name)
        if (c.state === null) {
          lines.push('- ' + name + ': UNREADABLE' + (c.error ? ' (' + c.error + ')' : ''))
          continue
        }
        const findings = formatFindings(validateState(c.state)).filter((f) => f.startsWith('ERROR'))
        const hp = c.state.combat.hp ?? {}
        lines.push('- ' + name
          + ': HP ' + (hp.current ?? '—') + '/' + (hp.max ?? '—')
          + ', AC ' + (c.state.combat.ac ?? '—')
          + ', ' + formatCurrency(c.state.currency)
          + (hasStateFile ? '' : ' (unmigrated sheet)')
          + (findings.length > 0 ? ' — INVALID: ' + findings.join('; ') : ''))
      }
      return lines.join('\n')
    },
  }

  return [refresh]
}
