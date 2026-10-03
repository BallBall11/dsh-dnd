/**
 * tools/character-create.mjs — dnd_character_create.
 *
 * ## Why this tool exists
 *
 * A fresh campaign has no characters, and `dnd_character_get` answers "No
 * character sheets found" — which tells the model nothing about what a sheet
 * must LOOK like. The first real session on a new workspace lost its opening
 * turns to exactly that: the GM hand-wrote a card in a format it had to guess,
 * the parser could not read it, and character creation stalled. The format
 * must not be guessed; it must be served.
 *
 * So this family owns creation end to end:
 *
 *   - `dnd_character_create` with structured arguments builds the state via
 *     `normalizeState`, derives every derivable number (ability modifiers,
 *     proficiency bonus, skill and save bonuses, spell DC/attack, initiative,
 *     copper totals) and writes BOTH files through `writeCharacter` — the same
 *     validated write path `dnd_track` uses, sandbox policy included. A sheet
 *     created here is parseable by construction, because it never passes
 *     through free-form markdown at all.
 *   - `dnd_character_create` with `template: true` returns the canonical sheet
 *     format, for the rare case the DM wants to hand-write narrative first.
 *
 * Class skeletons (hit die, saves, spellcasting ability) come from the 2024
 * dataset's `classes` array when the class is known there; anything the DM
 * passes explicitly wins.
 */

import { activeCampaignDir, readTextOrUndefined } from './shared.mjs'
import { sessionOf, writePolicyFor } from './session-scope.mjs'
import { statePath, sheetPath, writeCharacter } from './state-io.mjs'
import { normalizeState } from './state-schema.mjs'
import { loadDataset } from './lookup.mjs'

/** Render a plain string result for the model. */
const renderText = (_args, value) => [{ type: 'text', text: String(value) }]

/** The standard skill -> ability map (SRD; identical in the 2014 and 2024 rules). */
const SKILL_ABILITY = {
  Acrobatics: 'DEX', AnimalHandling: 'WIS', Arcana: 'INT', Athletics: 'STR',
  Deception: 'CHA', History: 'INT', Insight: 'WIS', Intimidation: 'CHA',
  Investigation: 'INT', Medicine: 'WIS', Nature: 'INT', Perception: 'WIS',
  Performance: 'CHA', Persuasion: 'CHA', Religion: 'INT', SleightOfHand: 'DEX',
  Stealth: 'DEX', Survival: 'WIS',
}

/** Skill display names accepted for the `skills` argument. */
const SKILL_ALIASES = {
  'animal handling': 'AnimalHandling', 'sleight of hand': 'SleightOfHand',
}

const mod = (score) => Math.floor((Number(score) - 10) / 2)
const signed = (n) => (n >= 0 ? '+' : '') + n

/** The proficiency bonus curve (identical in 2014 and 2024). */
const proficiencyBonus = (level) => Math.floor((Number(level ?? 1) - 1) / 4) + 2

/**
 * The canonical sheet, rendered as a template the parser accepts. Structured
 * `dnd_character_create` arguments are preferred; this exists so a hand-written
 * card is at least written against the real format instead of a guessed one.
 */
export function sheetTemplate() {
  return [
    'The structured form of dnd_character_create is preferred: pass name/race/class/level/abilities/hp/ac and the tool derives and writes a valid card. To hand-write one instead, this is the format the parser reads:',
    '',
    '```markdown',
    '---',
    "player: '—'",
    "campaign: '<campaign>'",
    'updated: 2026-10-03',
    "worldTime: ''",
    'tags: [pc]',
    '---',
    '',
    '# <Name>',
    '',
    '**Race:** <race> | **Class:** <class> | **Level:** 1 | **Background:** <background> | **Alignment:** <alignment>',
    '',
    '## Combat Stats',
    '',
    '**HP:** 10 / 10 | **Temp HP:** 0 | **AC:** 12 | **Initiative:** +1 | **Speed:** 30 ft | **Hit Dice:** 1d8 · 1',
    '**Currency:** 8 gp / 0 sp / 0 cp',
    '',
    '## Ability Scores',
    '',
    '| Score | STR | DEX | CON | INT | WIS | CHA |',
    '|-------|-----|-----|-----|-----|-----|-----|',
    '| Score | 10  | 12  | 14  | 16  | 10  | 8   |',
    '',
    '## Spell Slots',
    '',
    '| Level | Total | Used |',
    '|-------|-------|------|',
    '| 1     | 2     | 0    |',
    '',
    '## Known Spells',
    '',
    '**Cantrips:** Light, Mage Hand',
    '**Spellbook:** Detect Magic',
    '**Prepared:** Mage Armor',
    '**Spellcasting ability:** INT. **Spell save DC:** 13 | **Spell attack:** +5',
    '',
    '## Features & Traits',
    '',
    '- prose the parser preserves verbatim',
    '```',
  ].join('\n')
}

/**
 * Read the class skeleton out of the 2024 dataset, when the dataset is
 * reachable and the class is listed. A miss is not an error — the DM's
 * explicit arguments always win.
 * @param fs - the host fs service.
 * @param ignored - unused; kept for signature stability.
 * @param klass - the class name, e.g. "Fighter".
 */
async function classSkeleton(fs, klass) {
  if (fs === undefined || klass === undefined || klass === null) return {}
  try {
    const loaded = await loadDataset(fs, '2024')
    const data = loaded?.data
    const rows = data !== null && typeof data === 'object' ? data.classes : undefined
    if (!Array.isArray(rows)) return {}
    const wanted = String(klass).trim().toLowerCase()
    const row = rows.find((r) => String(r?.name ?? '').toLowerCase() === wanted)
    return row !== undefined ? { ...row } : {}
  } catch {
    return {}
  }
}

/**
 * Build this module's tools.
 * @param ctx - the host context.
 * @returns an array of tool definitions.
 */
export function buildTools(ctx) {
  const getFs = () => ctx.get('fs')

  const create = {
    name: 'dnd_character_create',
    description: 'Create a character in the active campaign. Pass structured fields (name, race, class, level, abilities, hp, ac, ...) and the tool derives ability modifiers, proficiency bonus, skill/save bonuses, spell DC and initiative, writes the sheet AND its state file through the validated write path, and returns what was written. Call with template:true to see the hand-written sheet format instead.',
    parameters: {
      type: 'object',
      properties: {
        template: { type: 'boolean', description: 'Return the canonical sheet format and stop. Everything else is ignored.' },
        name: { type: 'string', description: 'Character name, e.g. "Alice". Required unless template is true.' },
        race: { type: 'string', description: 'Species/race, e.g. "Elf (high)".' },
        klass: { type: 'string', description: 'Class, e.g. "Wizard". When the 2024 dataset knows it, hit die / saves / spellcasting ability default from there.' },
        level: { type: 'integer', description: 'Level 1-20 (default 1).' },
        background: { type: 'string', description: 'Background, e.g. "Sage".' },
        alignment: { type: 'string', description: 'Alignment, e.g. "Neutral Good".' },
        player: { type: 'string', description: 'Player name for the frontmatter; omit for an NPC.' },
        abilities: { type: 'object', description: 'STR/DEX/CON/INT/WIS/CHA scores. Missing scores default to 10.', properties: {} },
        hp: { type: 'integer', description: 'Maximum HP. Current starts at max; pass currentHp to override.' },
        currentHp: { type: 'integer', description: 'Starting current HP (default: max).' },
        ac: { type: 'integer', description: 'Armor Class.' },
        speed: { type: 'integer', description: 'Speed in feet (default 30).' },
        initiative: { type: 'integer', description: 'Initiative modifier. Default: DEX modifier.' },
        hitDie: { type: 'string', description: 'Hit die, e.g. "d6". Defaults from the class skeleton, else "d8".' },
        proficientSaves: { type: 'array', description: 'Ability codes with proficient saves, e.g. ["INT","WIS"]. Defaults from the class skeleton, else none. Save bonuses are derived.', items: { type: 'string' } },
        skills: { type: 'array', description: 'Skill names the character is proficient in, e.g. ["Arcana","Perception"]. Bonuses are derived; full name list is in the tool reply.', items: { type: 'string' } },
        spellAbility: { type: 'string', description: 'Spellcasting ability INT/WIS/CHA. Enables saveDC/attackBonus derivation; defaults from the class skeleton.' },
        spells: { type: 'object', description: '{ cantrips: [], spellbook: [], prepared: [] } — name lists.', properties: {} },
        spellSlots: { type: 'object', description: 'Map of level to total slots, e.g. {"1": 2}. Used starts at 0.', properties: {} },
        equipment: { type: 'object', description: '{ weapons: {}, armour: {}, gear: {} } — item name to quantity.', properties: {} },
        currencyGp: { type: 'number', description: 'Starting purse in gold pieces (converted internally; silver/copper derive exactly).' },
        narrative: { type: 'string', description: 'Backstory/personality prose. Written verbatim into the sheet; may use markdown headings other than the parsed ones.' },
        overwrite: { type: 'boolean', description: 'Replace an existing character of the same name. Default: refuse.' },
      },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      if (args.template === true) return sheetTemplate()

      const name = args.name === undefined || args.name === null ? '' : String(args.name).trim()
      if (name === '') {
        return 'dnd_character_create needs a `name` (or `template: true` to see the sheet format). Nothing was written.'
      }

      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'
      const session = sessionOf(ctx, exec)
      const located = await activeCampaignDir(fs, session)
      if (located === undefined) {
        return 'No active campaign. Load one with /dm:dnd load <campaign> first, then create characters.'
      }

      const stem = name.toLowerCase().replace(/\s+/g, '-')
      const existing = await readTextOrUndefined(fs, sheetPath(located.dir + '/characters', stem))
      if (existing !== undefined && args.overwrite !== true) {
        return `A character named ${name} already exists in ${located.campaign} (characters/${stem}.md). Pass overwrite:true to replace it. Nothing was written.`
      }

      const level = Number(args.level) > 0 ? Math.min(20, Math.floor(Number(args.level))) : 1
      const prof = proficiencyBonus(level)
      const skeleton = await classSkeleton(fs, args.klass)

      const scoreOf = (k) => {
        const v = Number(args.abilities?.[k])
        return Number.isFinite(v) ? Math.min(30, Math.max(1, Math.round(v))) : 10
      }
      const abilities = Object.fromEntries(['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'].map((k) => [k, scoreOf(k)]))

      const dexMod = mod(abilities.DEX)
      const saveMods = Object.fromEntries(['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'].map((k) => [k, mod(abilities[k])]))
      const proficientSaves = (Array.isArray(args.proficientSaves) ? args.proficientSaves
        : Array.isArray(skeleton.saves) ? skeleton.saves : [])
        .map((s) => String(s).toUpperCase()).filter((s) => s in saveMods)
      const saves = Object.fromEntries(['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']
        .map((k) => [k, saveMods[k] + (proficientSaves.includes(k) ? prof : 0)]))

      // Skill names arrive in display form ("Animal Handling") and are stored
      // in state under their CamelCase key with the derived bonus.
      const skills = {}
      for (const raw of Array.isArray(args.skills) ? args.skills : []) {
        const key = SKILL_ALIASES[String(raw).trim().toLowerCase()] ?? String(raw).replace(/\s+/g, '')
        const ability = SKILL_ABILITY[key]
        if (ability === undefined) continue
        skills[key] = { ability, bonus: mod(abilities[ability]) + prof, proficient: true }
      }

      const spellAbility = (['INT', 'WIS', 'CHA'].includes(String(args.spellAbility).toUpperCase())
        ? String(args.spellAbility).toUpperCase()
        : (typeof skeleton.spellcastingAbility === 'string' ? skeleton.spellcastingAbility : null))
      const spellcasting = spellAbility === null
        ? { ability: null, saveDC: null, attackBonus: null }
        : { ability: spellAbility, saveDC: 8 + prof + mod(abilities[spellAbility]), attackBonus: prof + mod(abilities[spellAbility]) }

      const spellSlots = {}
      for (const [lvl, total] of Object.entries(args.spellSlots ?? {})) {
        const n = Number(total)
        if (Number.isFinite(n) && n >= 0) spellSlots[String(parseInt(lvl, 10))] = { total: Math.floor(n), used: 0 }
      }

      const hpMax = Number(args.hp) > 0 ? Math.floor(Number(args.hp)) : null
      const hpCurrent = Number.isFinite(Number(args.currentHp)) ? Math.floor(Number(args.currentHp)) : hpMax
      const state = normalizeState({
        name,
        identity: {
          race: args.race ?? null,
          class: args.klass ?? null,
          level,
          background: args.background ?? null,
          alignment: args.alignment ?? null,
          xp: 0,
          xpNext: null,
        },
        abilities,
        combat: {
          hp: hpMax === null ? {} : { current: hpCurrent, max: hpMax },
          tempHp: 0,
          ac: Number.isFinite(Number(args.ac)) ? Math.floor(Number(args.ac)) : null,
          initiative: Number.isFinite(Number(args.initiative)) ? Math.floor(Number(args.initiative)) : dexMod,
          speed: Number.isFinite(Number(args.speed)) ? Math.floor(Number(args.speed)) : 30,
          hitDice: {
            die: typeof args.hitDie === 'string' && args.hitDie !== '' ? args.hitDie
              : (typeof skeleton.hitDie === 'string' && skeleton.hitDie !== '' ? skeleton.hitDie : 'd8'),
            remaining: level,
          },
          deathSaves: { successes: 0, failures: 0 },
        },
        saves,
        proficientSaves,
        skills,
        spellcasting,
        spellSlots,
        spells: {
          cantrips: (Array.isArray(args.spells?.cantrips) ? args.spells.cantrips : []).map(String),
          spellbook: (Array.isArray(args.spells?.spellbook) ? args.spells.spellbook : []).map(String),
          prepared: (Array.isArray(args.spells?.prepared) ? args.spells.prepared : []).map(String),
        },
        equipment: {
          weapons: args.equipment?.weapons ?? {},
          armour: args.equipment?.armour ?? {},
          gear: args.equipment?.gear ?? {},
        },
        currency: Number.isFinite(Number(args.currencyGp)) ? Math.round(Number(args.currencyGp) * 100) : 0,
      })

      const written = await writeCharacter(fs, located.dir + '/characters', stem, {
        state,
        narrative: args.narrative === undefined || args.narrative === null ? '' : String(args.narrative),
        player: args.player ?? null,
        campaign: located.campaign,
        tags: ['pc'],
        sandboxPolicy: writePolicyFor(ctx, exec),
      })
      if (written.refused) return 'dnd_character_create refused: ' + written.reason
      if (written.written === null) return 'dnd_character_create failed: ' + written.warnings.join('; ')

      const lines = [
        `Created ${name} (Lv${level}${args.klass ? ' ' + args.klass : ''}) in ${located.campaign}.`,
        `Proficiency bonus ${signed(prof)} · saves ` + ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']
          .map((k) => `${k} ${signed(saves[k])}`).join(' ')
          + (proficientSaves.length > 0 ? ` (proficient: ${proficientSaves.join(', ')})` : ''),
        skills.length === 0 || Object.keys(skills).length === 0
          ? 'Skills: none marked proficient.'
          : 'Skills: ' + Object.entries(skills).map(([k, v]) => `${k} ${signed(v.bonus)}`).join(', '),
        spellAbility !== null
          ? `Spellcasting ${spellAbility}: DC ${spellcasting.saveDC}, attack ${signed(spellcasting.attackBonus)}.`
          : 'No spellcasting ability given — pass spellAbility to derive DC/attack.',
        'Files: ' + written.written.state + ' and ' + written.written.sheet,
      ]
      if (written.warnings.length > 0) lines.push('Warnings: ' + written.warnings.join(' '))
      return lines.join('\n')
    },
  }

  return [create]
}
