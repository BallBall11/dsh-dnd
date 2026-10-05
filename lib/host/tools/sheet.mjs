/**
 * tools/sheet.mjs — character sheet access (read-only).
 *
 *   dnd_character_get  parse one or all character sheets in the active
 *                      campaign into compact JSON or a readable card
 *
 * Reads characters/ for the active campaign only — the old workspace-root
 * global-roster fallback is removed, because a character with two possible
 * homes is a drift vector, and a campaign is the scope of its own party. The
 * parsing itself lives in sheet-parse.mjs, which is unit-tested.
 */

import { activeCampaignDir, listMarkdown, readTextOrUndefined } from './shared.mjs'
import { sessionOf } from './session-scope.mjs'
import { formatCharacter, parseCharacterSheet } from './sheet-parse.mjs'
import { readCharacter } from './state-io.mjs'
import { readEncounter, EFFECTS_SECTION } from './encounter-io.mjs'
import { CONCENTRATION_SECTION } from './effects.mjs'
import { formatCurrency } from './state-rules.mjs'

export const name = 'dnd-sheet'

/**
 * Project a `.state.json` character into the flat shape this tool has always
 * returned.
 *
 * The shape is kept deliberately unchanged: `dnd_character_get` has consumers
 * (the markdown card renderer, the model's own reading habits) that expect
 * `hitPoints`, `abilityScores`, `spellSlotsByLevel` and friends. Rewriting them
 * to mirror the nested state object would be a breaking change for no gain —
 * what matters is that the numbers now come from the authoritative file.
 *
 * `parseVersion: 2` marks the difference, so a caller can tell which source
 * produced a given row.
 *
 * @param character - a `readCharacter` result whose state is present.
 * @returns the flat projection.
 */
function projectState(character) {
  const s = character.state
  const skills = {}
  for (const [skillName, entry] of Object.entries(s.skills ?? {})) {
    skills[skillName] = {
      ability: entry.ability ?? null,
      bonus: entry.bonus,
      proficient: entry.proficient === true,
    }
  }

  const abilityScores = {}
  for (const [key, score] of Object.entries(s.abilities ?? {})) {
    abilityScores[key] = score === null || score === undefined
      ? null
      : { score, modifier: Math.floor((score - 10) / 2) }
  }

  const slotsByLevel = {}
  for (const [level, slot] of Object.entries(s.spellSlots ?? {})) {
    slotsByLevel[level] = { total: slot.total, used: slot.used }
  }
  const firstLevel = Object.keys(slotsByLevel).sort((a, b) => Number(a) - Number(b))[0]

  return {
    parseVersion: 2,
    name: s.name ?? character.name,
    level: s.identity?.level ?? null,
    xp: s.identity?.xp ?? null,
    xpNext: s.identity?.xpNext ?? null,
    klass: s.identity?.class ?? null,
    race: s.identity?.race ?? null,
    background: s.identity?.background ?? null,
    alignment: s.identity?.alignment ?? null,

    hitPoints: s.combat?.hp ?? { current: null, max: null },
    tempHp: s.combat?.tempHp ?? 0,
    ac: s.combat?.ac ?? null,
    mageArmorAc: s.combat?.mageArmorAc ?? null,
    initiative: s.combat?.initiative ?? null,
    speed: s.combat?.speed ?? null,
    hitDice: s.combat?.hitDice?.die ?? null,
    hitDiceRemaining: s.combat?.hitDice?.remaining ?? null,
    inspiration: false, // not part of the structured state
    deathSaves: {
      success: s.combat?.deathSaves?.successes ?? 0,
      fail: s.combat?.deathSaves?.failures ?? 0,
    },

    abilityScores,
    saves: s.saves ?? {},
    proficientSaves: s.proficientSaves ?? [],
    skills,

    spellSaveDC: s.spellcasting?.saveDC ?? null,
    spellAttack: s.spellcasting?.attackBonus === null || s.spellcasting?.attackBonus === undefined
      ? null
      : String(s.spellcasting.attackBonus >= 0 ? `+${s.spellcasting.attackBonus}` : s.spellcasting.attackBonus),
    spellcastingAbility: s.spellcasting?.ability ?? null,
    spellSlots: firstLevel === undefined ? null : slotsByLevel[firstLevel],
    spellSlotsByLevel: slotsByLevel,
    cantrips: (s.spells?.cantrips ?? []).join(', ') || null,
    spellbook: (s.spells?.spellbook ?? []).join(', ') || null,
    prepared: (s.spells?.prepared ?? []).join(', ') || null,

    equipment: s.equipment ?? { weapons: {}, armour: {}, gear: {} },
    conditions: s.conditions ?? [],
    currency: formatCurrency(s.currency ?? 0),
    currencyCp: s.currency ?? 0,
    warnings: [],
  }
}

/**
 * Build this module's tools.
 * @param ctx - host context; `fs` is optional.
 * @returns an array of tool definitions.
 */
export function buildTools(ctx) {
  // Lazy: a mount running before the filesystem backend is ready must not
  // capture undefined permanently.
  const getFs = () => ctx.get('fs')
  const renderText = (_args, value) => [{ type: 'text', text: String(value) }]

  /**
   * Load and parse every character for a campaign.
   *
   * Each character is read through `readCharacter`, so the `.state.json` is
   * authoritative when it exists and the sheet's inline sections are the source
   * only for an unmigrated sheet. The first version called `parseCharacterSheet`
   * directly on the `.md`, which meant that once a character was migrated this
   * tool returned `hitPoints: null` and warned that `## Combat Stats` was
   * missing — while the correct numbers sat in the state file beside it. The
   * panel read the state file and the tool did not, so the two disagreed, which
   * is the exact drift this design exists to remove.
   *
   * The parsed shape is kept as it was, so existing consumers are unaffected.
   *
   * @param fs - the resolved filesystem service.
   * @returns `{ campaign, characters, warnings }` or `{ error }`.
   */
  // The global workspace-root `characters/` roster is gone, deliberately.
  // Reading sheets from OUTSIDE the campaign directory mixed two homes for one
  // fact and made the campaign the wrong scope for its own party; every
  // character now lives in `campaigns/<campaign>/characters/` and nowhere else.
  // An empty directory is a true empty party, not a cue to look elsewhere.
  async function loadCharacters(fs, campaign, dir) {
    const characters = []
    const warnings = []
    const files = await listMarkdown(fs, `${dir}/characters`)

    for (const file of files) {
      const stem = file.name.replace(/\.md$/i, '')
      const character = await readCharacter(fs, `${dir}/characters`, stem)

      if (character.needsMigration || !character.hasStateFile) {
        // Unmigrated: the sheet's own sections are the only source.
        const text = await readTextOrUndefined(fs, file.target ?? `${dir}/characters/${file.name}`)
        if (text === undefined) {
          warnings.push(`Could not read ${file.name}.`)
          continue
        }
        const parsed = parseCharacterSheet(text)
        for (const warning of parsed.warnings) warnings.push(`${file.name}: ${warning}`)
        characters.push({ file: file.name, ...parsed })
        continue
      }

      const projected = projectState(character)
      for (const warning of character.warnings) warnings.push(`${file.name}: ${warning}`)
      characters.push({ file: file.name, ...projected })
    }
    return { campaign, characters, warnings }
  }

  const get = {
    name: 'dnd_character_get',
    description: 'Read character sheet(s) from the active campaign as compact JSON (HP, AC, abilities, skills, spell slots per level, spells, XP, currency), or as a readable card with asMarkdown. Omit `character` to read the whole party. The same parser feeds the character panel.',
    parameters: {
      type: 'object',
      properties: {
        character: { type: 'string', description: 'Character name or sheet filename stem, e.g. "alice". Omit for the whole party.' },
        asMarkdown: { type: 'boolean', description: 'Render a readable card instead of raw JSON.' },
      },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'
      const session = sessionOf(ctx, exec)
      const located = await activeCampaignDir(fs, session)
      if (located?.error !== undefined) return located.error
      if (located === undefined) {
        return 'No active campaign. Load one with /dm:dnd load <campaign> first.'
      }
      const loaded = await loadCharacters(fs, located.campaign, located.dir)
      if (loaded.characters.length === 0) {
        return `No character sheets found for campaign ${located.campaign}. `
        + `Create one with dnd_character_create (structured fields, or template:true for the sheet format); `
        + `the parser accepts only the canonical format, so do not hand-write a card blindly. Files go under ${located.dir}/characters/.`
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

      // Active encounter effects travel with the read: dnd_effect stores its
      // state in the encounter file BY DESIGN (the sheet stays authoritative
      // for permanent numbers), but a read that hides Mage Armor makes the DM
      // plan against AC 12 while the rules say 15. Attach the live list so the
      // mismatch is visible where the numbers are read — without pretending
      // the numbers themselves have been updated.
      //
      // The stem comes from `file` ONLY: it is the sheet filename
      // (`quill.md`) and always matches the encounter filename's stem.
      // `name` is the DISPLAY name ("Quill Firefingers") and must never be
      // used to build a filesystem path.
      const activeBlock = async (c) => {
        const stem = String(c.file ?? '').toLowerCase().replace(/\.md$/, '')
        if (stem === '') return null
        // Encounter files live next to the sheets, under characters/ — the
        // same directory convention the effects family reads and writes.
        const read = await readEncounter(fs, `${located.dir}/characters`, stem)
        if (!read.exists) return null
        const effects = Array.isArray(read.encounter.sections?.[EFFECTS_SECTION])
          ? read.encounter.sections[EFFECTS_SECTION]
          : []
        const concentration = read.encounter.sections?.[CONCENTRATION_SECTION]
        const lines = effects.map((e) => {
          const dur = e.duration ?? {}
          const remaining = dur.remaining !== undefined
            ? `${dur.remaining} ${dur.unit ?? ''}`.trim() || 'indefinite'
            : (dur.unit ?? 'indefinite')
          return `- ${e.name}${dur.unit ? ` (${remaining} remaining)` : ''}${e.note ? ` — ${e.note}` : ''}`
        })
        if (concentration && typeof concentration === 'object' && concentration.spell) {
          lines.push(`- CONCENTRATING: ${concentration.spell}`)
        }
        return lines
      }

      if (args.asMarkdown) {
        const cards = []
        for (const c of selected) {
          cards.push(formatCharacter(c))
          const lines = await activeBlock(c)
          if (lines !== null && lines.length > 0) {
            cards.push(`**Active effects** (live state; the numbers above do NOT include these):\n${lines.join('\n')}`)
          }
        }
        const warn = loaded.warnings.length > 0 ? `\n\n⚠ ${loaded.warnings.join('\n⚠ ')}` : ''
        return `*Campaign: ${located.campaign}*\n\n${cards.join('\n\n---\n\n')}${warn}`
      }

      for (const c of selected) {
        const lines = await activeBlock(c)
        if (lines !== null && lines.length > 0) {
          c.activeEffects = lines
          c.activeEffectsNote = 'live state from the encounter file; the AC/HP numbers above do NOT include these'
        }
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
