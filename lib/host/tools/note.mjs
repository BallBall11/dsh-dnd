/**
 * tools/note.mjs — dnd_note, the campaign session log's write tool.
 *
 * The campaign tools were ALL read-only: the agent playing the DM could read
 * state.md and search the corpus, but recording a loot handout or a plot hook
 * meant editing campaign markdown BY HAND — outside the write path, outside
 * the session policy, and invisible to the tools' own conventions. dnd_note
 * closes that loop: one tool, one file, an append-only report the DM agent
 * and the corpus search both own.
 *
 * ## Why session-log.md, and why a read-modify-write
 *
 * session-log.md already exists as the campaign's log file and is already in
 * dnd_campaign_search's corpus — writing there costs the search nothing. The
 * host fs has no append primitive, so the write is read-whole, append, write-
 * whole, serialized under a per-campaign lock (the same promise-chain shape
 * track.mjs uses per character): two notes interleaved would otherwise drop
 * one of them, the lost-update that made the character lock exist.
 *
 * ## Why fingerprint dedup instead of idempotency keys
 *
 * dnd_track's appliedKeys live in the character's state.json; a note has no
 * state file to keep keys in. A sidecar key file would add a second piece of
 * bookkeeping state for exactly ONE failure mode — the same note retried
 * after a lost reply. A trailing-content check covers that mode with no new
 * state: if the file already ends with this exact section (same kind, same
 * body), the tool says so and writes nothing. A GENUINELY identical note
 * twice at the table is meaningless anyway; one with new content appends.
 */

import { activeCampaignDir, readTextOrUndefined } from './shared.mjs'
import { readCalendar, formatWorldTime } from './clock.mjs'
import { sessionOf, writePolicyFor } from './session-scope.mjs'

export const name = 'dnd-note'

const KINDS = ['loot', 'hook', 'recap', 'freeform']
const LOG_FILE = 'session-log.md'
const MAX_NOTE_CHARS = 4000

/**
 * Serialize one note section. `## <worldTime> — <kind>` heads it so the
 * corpus search hits on either the kind or the time; the body rides below.
 */
function renderSection(worldTime, kind, body) {
  return `\n## ${worldTime} — ${kind}\n\n${body.trim()}\n`
}

/**
 * The per-campaign write chains, keyed on the resolved campaign directory —
 * the same shape as track.mjs's per-character chains. One process, one chain,
 * and a rejection never poisons the link for the next note.
 * @type {Map<string, Promise<unknown>>}
 */
const writeChains = new Map()

async function withCampaignLock(key, work) {
  const prior = writeChains.get(key) ?? Promise.resolve()
  const run = prior.then(work, work)
  const link = run.then(() => undefined, () => undefined)
  writeChains.set(key, link)
  try {
    return await run
  } finally {
    if (writeChains.get(key) === link) writeChains.delete(key)
  }
}

/**
 * Build this module's tools.
 * @param ctx - host context; `fs` is optional.
 * @returns an array of tool definitions.
 */
export function buildTools(ctx) {
  const getFs = () => ctx.get('fs')
  const renderText = (_args, value) => [{ type: 'text', text: String(value) }]

  const note = {
    name: 'dnd_note',
    description: 'Append a dated entry to the campaign\'s session log (session-log.md): loot handed out, a plot hook planted, a session recap, or freeform notes. '
      + 'The entry is searchable through dnd_campaign_search. Writing the SAME entry twice is refused (the tail is checked), not doubled. '
      + 'This tool does NOT touch state.md — updating Active Quests or Open Threads there is a separate decision.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'What kind of entry. Required.', enum: KINDS },
        body: { type: 'string', description: 'The entry text. Required. Keep it to what a future session needs to remember.' },
      },
      required: ['kind', 'body'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'

      const kind = String(args.kind ?? '').trim().toLowerCase()
      if (!KINDS.includes(kind)) {
        return `dnd_note needs ` + '`kind`' + `, one of: ${KINDS.join(', ')}. Nothing was written.`
      }
      const body = String(args.body ?? '').trim()
      if (body === '') return 'dnd_note needs a `body` — the entry text. Nothing was written.'
      if (body.length > MAX_NOTE_CHARS) {
        return `dnd_note: the entry is ${body.length} characters; keep it under ${MAX_NOTE_CHARS} and split if needed. Nothing was written.`
      }

      const campaign = await activeCampaignDir(fs, sessionOf(ctx, exec))
      if (campaign === undefined) return 'No active campaign. Load one with /dm:dnd load <campaign> first.'
      const logPath = `${campaign.dir}/${LOG_FILE}`
      const calendar = await readCalendar(fs, campaign.dir)
      const worldTime = formatWorldTime(calendar)
      const section = renderSection(worldTime, kind, body)
      const policy = writePolicyFor(ctx, exec)

      const outcome = await withCampaignLock(campaign.dir.toLowerCase(), async () => {
        const existing = await readTextOrUndefined(fs, logPath)
        // Fingerprint: the file's tail already carrying this EXACT section is
        // the retry case. Compare against the tail so a big log costs a slice,
        // not a scan.
        const tail = existing === undefined ? '' : existing.slice(-section.length)
        if (tail === section || (existing ?? '').endsWith(section)) {
          return { duplicate: true }
        }
        const header = existing === undefined
          ? `# Session Log — ${campaign.campaign}\n`
          : (existing.endsWith('\n') ? existing : existing + '\n')
        const next = header + section
        await fs.writeText(await fs.resolve(logPath), next, undefined, undefined, policy)
        return { duplicate: false, lines: next.split('\n').length }
      })

      if (outcome.duplicate === true) {
        return `Already written: ${LOG_FILE} already ends with this exact ${kind} entry. Nothing was written.`
      }
      return `Appended a ${kind} entry to ${LOG_FILE} in ${campaign.campaign} (world time: ${worldTime}). `
        + `Find it with dnd_campaign_search.`
    },
  }

  return [note]
}
