/**
 * tools/campaign.mjs — read-only campaign document access.
 *
 *   dnd_campaign_state   key sections of the active campaign's state.md
 *   dnd_campaign_search  substring search across the campaign's markdown corpus
 *   dnd_arc_status       the campaign arc's current act/beat
 *
 * All three are read-only and all three are cheap at the table but expensive
 * through a shell. The search tool keeps a per-campaign mtime-stamped index so
 * repeated queries do not re-read the whole corpus each time.
 */

import {
  DND_ROOT,
  MtimeCache,
  activeCampaignDir,
  findSection,
  listMarkdown,
  readTextOrUndefined,
  splitSections,
} from './shared.mjs'

/** Sections dnd_campaign_state reports when the caller names none. */
const DEFAULT_SECTIONS = [
  'Current Situation',
  'Active Quests',
  'Open Threads',
  'Live State Flags',
  'World State',
  'Recent Events',
]

export const name = 'dnd-campaign'

/** Per-campaign file index, invalidated on the directory listing stamp. */
const indexCache = new MtimeCache()

/**
 * Build the campaign corpus index: one entry per markdown file.
 * @param fs - the host fs service.
 * @param dir - the campaign directory.
 * @returns `{ files: [{ name, path, text }], stamp }`.
 */
async function buildIndex(fs, dir) {
  const files = await listMarkdown(fs, dir)
  const out = []
  for (const file of files) {
    const text = await readTextOrUndefined(fs, file.target ?? `${dir}/${file.name}`)
    if (text === undefined) continue
    out.push({ name: file.name, path: `${dir}/${file.name}`, text })
  }
  // Subdirectories that hold reviewable prose (not characters/, which the
  // sheet tool owns).
  for (const sub of ['source']) {
    for (const file of await listMarkdown(fs, `${dir}/${sub}`)) {
      const text = await readTextOrUndefined(fs, file.target ?? `${dir}/${sub}/${file.name}`)
      if (text === undefined) continue
      out.push({ name: `${sub}/${file.name}`, path: `${dir}/${sub}/${file.name}`, text })
    }
  }
  return out
}

/**
 * Build this module's tools.
 * @param ctx - host context; `fs` is optional.
 * @returns an array of tool definitions.
 */
export function buildTools(ctx) {
  const fs = ctx.get('fs')
  const renderText = (_args, value) => [{ type: 'text', text: String(value) }]

  /** Shared preamble: resolve the campaign or return a message. */
  async function locate() {
    if (fs === undefined) return { error: 'fs service unavailable' }
    const found = await activeCampaignDir(fs)
    if (found === undefined) {
      return { error: 'No active campaign. Load one with /dm:dnd load <campaign> (this writes .runtime/active-campaign.json).' }
    }
    return found
  }

  const state = {
    name: 'dnd_campaign_state',
    description: 'Read the active campaign\'s state.md: Current Situation, Active Quests, Open Threads, Live State Flags, World State and Recent Events. Pass `section` to read one named section instead (substring match, case-insensitive).',
    parameters: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Read only the section whose heading contains this text, e.g. "quests".' },
        list: { type: 'boolean', description: 'List every section heading in state.md instead of reading them.' },
      },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      const located = await locate()
      if (located.error !== undefined) return located.error
      const text = await readTextOrUndefined(fs, `${located.dir}/state.md`)
      if (text === undefined) return `No state.md in campaign "${located.campaign}".`

      const sections = splitSections(text)
      if (args.list) {
        const headings = [...sections.keys()].filter((h) => h !== '(preamble)')
        return `**${located.campaign}** state.md sections:\n` + headings.map((h) => `- ${h}`).join('\n')
      }
      if (args.section !== undefined) {
        const hit = findSection(text, String(args.section))
        if (hit === undefined) {
          const headings = [...sections.keys()].filter((h) => h !== '(preamble)')
          return `No section matching "${args.section}" in ${located.campaign}. Available: ${headings.join(', ')}`
        }
        return `# ${hit.heading}\n${hit.body}`
      }
      const blocks = []
      for (const wanted of DEFAULT_SECTIONS) {
        const hit = findSection(text, wanted)
        if (hit !== undefined && hit.body !== '') blocks.push(`## ${hit.heading}\n${hit.body}`)
      }
      if (blocks.length === 0) return `state.md for ${located.campaign} has none of the expected sections.`
      return `**Campaign:** ${located.campaign}\n\n${blocks.join('\n\n')}`
    },
  }

  const search = {
    name: 'dnd_campaign_search',
    description: 'Full-text search across the active campaign\'s markdown corpus (state.md, world.md, npcs.md, npcs-full.md, arc.md, session-log.md, source/*). Returns matching lines with their file and line number. Use this BEFORE reading whole files — it is the cheap way to find where something is written.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to find (case-insensitive substring).', required: true },
        file: { type: 'string', description: 'Restrict to one file, e.g. "npcs-full.md" or "source/1.1.md".' },
        max: { type: 'integer', description: 'Maximum matching lines to return (default 30).' },
        context: { type: 'integer', description: 'Lines of context to include around each match (default 0).' },
      },
      required: ['query'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      const located = await locate()
      if (located.error !== undefined) return located.error
      const query = String(args.query).toLowerCase()
      if (query === '') return '`query` must not be empty.'
      const max = Number(args.max) > 0 ? Number(args.max) : 30
      const context = Number(args.context) > 0 ? Math.min(Number(args.context), 5) : 0

      const listing = await listMarkdown(fs, located.dir)
      const wanted = args.file !== undefined ? String(args.file) : undefined
      const stamp = listing.map((f) => `${f.name}:${f.mtime ?? ''}`).join(',')
      const index = await indexCache.get(located.campaign, stamp, () => buildIndex(fs, located.dir))

      const results = []
      for (const entry of index) {
        if (wanted !== undefined && !entry.name.toLowerCase().includes(wanted.toLowerCase())) continue
        const lines = entry.text.split(/\r?\n/)
        for (let i = 0; i < lines.length; i += 1) {
          if (!lines[i].toLowerCase().includes(query)) continue
          const from = Math.max(0, i - context)
          const to = Math.min(lines.length, i + context + 1)
          results.push({
            file: entry.name,
            line: i + 1,
            text: lines.slice(from, to).map((l, k) => `${from + k + 1}: ${l}`).join('\n'),
          })
          if (results.length >= max) break
        }
        if (results.length >= max) break
      }

      if (results.length === 0) {
        return `No match for "${args.query}" in campaign ${located.campaign}${wanted !== undefined ? ` (file filter: ${wanted})` : ''}.`
      }
      const head = `${results.length}${results.length >= max ? '+' : ''} match${results.length === 1 ? '' : 'es'} for "${args.query}" in ${located.campaign}:`
      return `${head}\n\n` + results.map((r) => `**${r.file}:${r.line}**\n${r.text}`).join('\n\n')
    },
  }

  const arc = {
    name: 'dnd_arc_status',
    description: 'Report the campaign arc\'s current position: for a dynamic arc, the act and beat with what changes; for a structured (imported) arc, the current act/chapter and outstanding beats. Reads state.md first and only touches arc.md when more detail is needed.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: renderText },
    async execute() {
      const located = await locate()
      if (located.error !== undefined) return located.error
      const stateText = await readTextOrUndefined(fs, `${located.dir}/state.md`)
      if (stateText === undefined) return `No state.md in campaign "${located.campaign}".`

      const arcSection = findSection(stateText, 'Campaign Arc')
      if (arcSection === undefined || arcSection.body === '') {
        return `Campaign ${located.campaign} has no "## Campaign Arc" section in state.md (a sandbox campaign).`
      }
      const body = arcSection.body
      const type = body.match(/type:\s*(\w+)/)?.[1] ?? 'unknown'
      const lines = [`**${located.campaign}** — arc type: ${type}`, '']

      const pick = (label) => {
        const match = body.match(new RegExp(`^\\s*-?\\s*\\*\\*${label}:\\*\\*\\s*(.+)$`, 'im'))
          ?? body.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, 'im'))
        return match !== null && match !== undefined ? match[1].trim() : undefined
      }

      for (const label of ['Current act', 'Current beat', 'Current chapter', 'What changes', 'Steering notes', 'Outstanding beats']) {
        const value = pick(label)
        if (value !== undefined && value !== '') lines.push(`- **${label}:** ${value}`)
      }
      if (lines.length === 2) lines.push(body.trim().slice(0, 1500))
      return lines.join('\n')
    },
  }

  return [state, search, arc]
}
