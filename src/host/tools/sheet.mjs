/**
 * tools/sheet.mjs — character sheet access (read-only).
 *
 *   dnd_character_get  parse one or all character sheets in the active
 *                      campaign into compact JSON or a readable card
 *
 * Reads characters/ for the active campaign and falls back to the global
 * roster at <root>/characters/ for a name not present locally. The parsing
 * itself lives in sheet-parse.mjs, which is unit-tested.
 */

import { DND_ROOT, activeCampaignDir, listMarkdown, readTextOrUndefined } from './shared.mjs'
import { formatCharacter, parseCharacterSheet } from './sheet-parse.mjs'

export const name = 'dnd-sheet'

/**
 * Build this module's tools.
 * @param ctx - host context; `fs` is optional.
 * @returns an array of tool definitions.
 */
export function buildTools(ctx) {
  const fs = ctx.get('fs')
  const renderText = (_args, value) => [{ type: 'text', text: String(value) }]

  /**
   * Load and parse every character sheet for a campaign.
   * @returns `{ campaign, characters, warnings }` or `{ error }`.
   */
  async function loadCharacters(campaign, dir) {
    const characters = []
    const warnings = []
    const files = await listMarkdown(fs, `${dir}/characters`)
    if (files.length === 0) {
      // Fall back to the global roster only when the campaign has no
      // characters/ directory of its own.
      const globalFiles = await listMarkdown(fs, `${DND_ROOT}/characters`)
      for (const file of globalFiles) {
        const text = await readTextOrUndefined(fs, file.target ?? `${DND_ROOT}/characters/${file.name}`)
        if (text === undefined) continue
        characters.push({ file: file.name, ...parseCharacterSheet(text) })
      }
      if (characters.length > 0) warnings.push('Read from the global roster; this campaign has no characters/.')
      return { campaign, characters, warnings }
    }
    for (const file of files) {
      const text = await readTextOrUndefined(fs, file.target ?? `${dir}/characters/${file.name}`)
      if (text === undefined) {
        warnings.push(`Could not read ${file.name}.`)
        continue
      }
      const parsed = parseCharacterSheet(text)
      for (const warning of parsed.warnings) warnings.push(`${file.name}: ${warning}`)
      characters.push({ file: file.name, ...parsed })
    }
    return { campaign, characters, warnings }
  }

  const get = {
    name: 'dnd_character_get',
    description: 'Read character sheet(s) from the active campaign as compact JSON (HP, AC, abilities, skills, attacks, spell slots per level, XP, currency), or as a readable card with asMarkdown. Omit `character` to read the whole party. The same parser feeds the character panel.',
    parameters: {
      type: 'object',
      properties: {
        character: { type: 'string', description: 'Character name or sheet filename stem, e.g. "alice". Omit for the whole party.' },
        asMarkdown: { type: 'boolean', description: 'Render a readable card instead of raw JSON.' },
      },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      if (fs === undefined) return 'fs service unavailable'
      const located = await activeCampaignDir(fs)
      if (located === undefined) {
        return 'No active campaign. Load one with /dm:dnd load <campaign> first.'
      }
      const loaded = await loadCharacters(located.campaign, located.dir)
      if (loaded.characters.length === 0) {
        return `No character sheets found for campaign ${located.campaign}.`
      }

      let selected = loaded.characters
      if (args.character !== undefined && String(args.character).trim() !== '') {
        const wanted = String(args.character).toLowerCase().trim()
        selected = loaded.characters.filter((c) =>
          String(c.name ?? '').toLowerCase() === wanted
          || String(c.file ?? '').toLowerCase().replace(/\.md$/, '') === wanted
          || String(c.name ?? '').toLowerCase().includes(wanted))
        if (selected.length === 0) {
          const available = loaded.characters.map((c) => c.name ?? c.file).join(', ')
          return `Character "${args.character}" not found in ${located.campaign}. Available: ${available}`
        }
      }

      if (args.asMarkdown) {
        const cards = selected.map((c) => formatCharacter(c))
        const warn = loaded.warnings.length > 0 ? `\n\n⚠ ${loaded.warnings.join('\n⚠ ')}` : ''
        return `*Campaign: ${located.campaign}*\n\n${cards.join('\n\n---\n\n')}${warn}`
      }
      return JSON.stringify(
        { campaign: located.campaign, characters: selected, warnings: loaded.warnings },
        null,
        2,
      )
    },
  }

  return [get]
}
