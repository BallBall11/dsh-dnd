/**
 * tools/initiative.mjs — rolling initiative and ordering turns.
 *
 *   dnd_initiative   roll for several combatants at once, return the SORTED
 *                    turn order, and persist it so a later call can read it back
 *
 * ## The gap this closes
 *
 * Before this tool, no `dnd_*` tool could roll initiative. `dnd_attack` resolves
 * one attacker against one target, and sheet-parse.mjs only READS the
 * `**Initiative:**` field for display. A DM had to call `dnd_roll` once per NPC
 * and sort the results by hand — and the ordering could not be persisted, so the
 * very next tool call lost it.
 *
 * ## The dice come from roll.mjs, and from nowhere else
 *
 * `rollD20` is imported from ./roll.mjs and is the ONLY source of randomness
 * this module uses. It is not re-implemented, not wrapped, and there is no
 * `Math.random()` anywhere in this file. That matters for more than tidiness:
 * one dice implementation means one place to reason about advantage, natural
 * 20/1, and the physical-dice convention, and it means a future change to how
 * this bundle rolls will reach initiative automatically instead of leaving a
 * second, quietly divergent dice path behind.
 *
 * ## `roll_mode` — who is allowed to roll
 *
 * The campaign's `state.md` carries `roll_mode` under `## Live State Flags`
 * (or, in older campaigns, under `## Session Flags`), and the dnd-gm persona's
 * WHO ROLLS section states the same rule in prose. The two modes that matter:
 *
 *   players   NEVER roll for a PC. The player rolls their own d20 and the DM
 *             supplies the number. NPCs and monsters are still rolled here.
 *   auto/dm   the DM rolls everything, openly.
 *
 * `players` is the DEFAULT, and that default is deliberate. Guessing `auto`
 * would take the dice out of a player's hand, which is the one outcome the
 * convention exists to prevent; defaulting to the conservative mode means a
 * campaign that has never set the flag gets the behaviour the convention
 * specifies rather than an inferred one.
 *
 * ## What "never roll for a PC" means MECHANICALLY
 *
 * This is the part worth being precise about, because a weak reading of it
 * passes a weak test. In `players` mode, a PC with no supplied roll is NOT
 * rolled and is NOT given a placeholder number:
 *
 *   - `rollD20` is not called for that combatant at all, so no d20 value for
 *     that PC ever comes into existence
 *   - the combatant is reported with `pending: true` and `initiative: null`
 *   - it is kept OUT of the sorted turn order (it has no place to be sorted to)
 *   - the result names the PCs whose numbers are still owed, so the DM knows
 *     exactly what to ask for
 *
 * A later call supplies the number via `rolls` and the combatant joins the
 * order. The test for this asserts the ABSENCE of a value, not the presence of
 * a sentence — see test/initiative.test.mjs.
 *
 * ## Persistence: why `<stem>.encounter.json`
 *
 * The sorted order is written to the character's encounter file, through
 * encounter-io.mjs. The full reasoning for that location is in that module's
 * header; the short version is that turn order is TRANSIENT combat state with a
 * different lifetime from both the narrative (`.md`) and the numbered sheet
 * (`.state.json`), and that state.md is prose the table edits by hand.
 *
 * ## Which character owns the encounter?
 *
 * An encounter is a TABLE-level fact but the encounter file is keyed per
 * character. Rather than invent a campaign-level file — a second location, and
 * one the task explicitly did not choose — the order is stored on the character
 * named by `character`, defaulting to the campaign's only character when there
 * is exactly one. Every participant's name, roll and modifier lives in that ONE
 * file, so reading the order back is a single read.
 *
 * This is a real constraint and it is stated rather than hidden: with several
 * PCs in a campaign, `character` must be passed so the DM and the tool agree on
 * which file holds the fight. The error message names the candidates.
 */

import { activeCampaignDir, findSection, readTextOrUndefined } from './shared.mjs'
import { readCharacter, listCharacters } from './state-io.mjs'
import { rollD20 } from './roll.mjs'
import { sessionOf, writePolicyFor } from './session-scope.mjs'
import {
  INITIATIVE_SECTION,
  clearEncounterSection,
  mergeEncounter,
  readEncounter,
  sectionOf,
  writeEncounter,
} from './encounter-io.mjs'

export const name = 'dnd-initiative'

/** Render a plain string result for the model. */
const renderText = (_args, value) => [{ type: 'text', text: String(value) }]

/** The modes that mean "the DM rolls everything". Anything else is `players`. */
const DM_ROLL_MODES = new Set(['auto', 'dm', 'dungeon-master', 'open', 'all'])

/**
 * Normalize a `roll_mode` value.
 *
 * @param raw - the flag as written in state.md, possibly undefined.
 * @returns `'players'` or `'dm'`. Unknown and absent both yield `'players'`
 *   (see the module header for why the conservative mode is the default).
 */
export function normalizeRollMode(raw) {
  if (raw === undefined || raw === null) return 'players'
  const value = String(raw).trim().toLowerCase().replace(/[_.\s]+/g, '-')
  if (value === '') return 'players'
  return DM_ROLL_MODES.has(value) ? 'dm' : 'players'
}

/**
 * Read `roll_mode` out of the campaign's state.md.
 *
 * Two shapes exist in the wild and both must be honoured, because getting this
 * wrong decides whether the tool is allowed to roll a player's dice:
 *
 *   ## Live State Flags          <- the documented shape
 *   - **roll_mode:** players
 *
 *   ## Session Flags             <- the older campaigns
 *   *(roll_mode: auto — DM rolls everything openly, set 2026-09-09)*
 *
 * So the flag is looked for in either section, in both the markdown list form
 * and the parenthesised prose form. Absence is NOT an error: a campaign that
 * has never set the flag gets `players`, reported as such so the DM can see
 * which mode was applied rather than having to infer it.
 *
 * @param fs - the host fs service.
 * @param campaignDir - the campaign directory.
 * @returns `{ mode, source, raw }` — `source` names where the value came from,
 *   or 'default'.
 */
export async function readRollMode(fs, campaignDir) {
  const text = await readTextOrUndefined(fs, `${campaignDir}/state.md`)
  if (text === undefined) return { mode: 'players', source: 'default', raw: null }

  for (const sectionName of ['Live State Flags', 'Session Flags']) {
    const section = findSection(text, sectionName)
    if (section === undefined) continue
    const body = section.body

    // Form 1: "- **roll_mode:** players" (also tolerates "roll_mode: players").
    const list = body.match(/\*\*roll_mode:?\*\*\s*:?\s*([^\n*]+)/i)
    if (list !== null) {
      const raw = list[1].trim()
      if (raw !== '') return { mode: normalizeRollMode(raw), source: section.heading, raw }
    }

    // Form 2: "*(roll_mode: auto — DM rolls everything openly …)*" — the flag is
    // followed by an em dash and prose, so the capture stops at the separator.
    const prose = body.match(/roll_mode\s*:\s*([A-Za-z_-]+)/i)
    if (prose !== null) {
      const raw = prose[1].trim()
      if (raw !== '') return { mode: normalizeRollMode(raw), source: section.heading, raw }
    }
  }
  return { mode: 'players', source: 'default', raw: null }
}

/**
 * Read a character's initiative MODIFIER from their state file.
 *
 * `combat.initiative` is a FINAL modifier, not an ability score — sheet-parse
 * reads "**Initiative:** +2" and sheet-split stores 2. Applying the modifier
 * formula to it would turn 2 into -4, which is the exact defect the client panel
 * already carries a comment about (client/panels/character.js:219). So it is
 * used as-is.
 *
 * @param fs - the host fs service.
 * @param dir - the character directory.
 * @param stem - the character's file stem.
 * @returns the modifier, or 0 when the character has none.
 */
async function readInitiativeMod(fs, dir, stem) {
  const character = await readCharacter(fs, dir, stem)
  const value = character?.state?.combat?.initiative
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Is this combatant entry a PC (whose dice may belong to a player)? */
function isPc(entry) {
  if (entry === null || typeof entry !== 'object') return false
  if (entry.player === true) return true
  const kind = String(entry.kind ?? entry.type ?? '').trim().toLowerCase()
  return kind === 'pc' || kind === 'player' || kind === 'character'
}

/** Parse a signed integer, tolerating a leading `+`. */
function parseInt10(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  const s = String(value ?? '').trim().replace(/^\+/, '')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/**
 * Normalize the caller's `combatants` argument into entries this module can use.
 *
 * Two spellings are accepted because a DM at the table will reach for either:
 *
 *   ["Alice", "Goblin", "Goblin"]                     — bare names
 *   [{ name: "Alice", kind: "pc", mod: 2 }, …]        — full entries
 *
 * A bare name is treated as an NPC, because an NPC is the case where the DM
 * rolls and the tool needs no help. A PC must be MARKED (kind: "pc" or
 * player: true), which is the safe direction: mistaking an NPC for a PC costs
 * one extra supplied number, while mistaking a PC for an NPC would roll a
 * player's dice for them.
 *
 * A duplicate name is NOT collapsed. "Goblin" twice means two goblins, and
 * merging them would silently drop a combatant from the fight.
 *
 * @param raw - the `combatants` argument.
 * @returns `{ entries }` or `{ error }`.
 */
export function parseCombatants(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'dnd_initiative needs a non-empty `combatants` array, e.g. ["Alice", "Goblin", "Goblin"]. Nothing was written.' }
  }
  const entries = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const name = item.trim()
      if (name === '') return { error: 'dnd_initiative: a combatant name is empty. Nothing was written.' }
      entries.push({ name, kind: 'npc', pc: false, mod: null })
      continue
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { error: `dnd_initiative: a combatant entry must be a name or an object, got ${JSON.stringify(item)}. Nothing was written.` }
    }
    const name = String(item.name ?? '').trim()
    if (name === '') return { error: 'dnd_initiative: every combatant entry needs a `name`. Nothing was written.' }
    const mod = item.mod === undefined || item.mod === null ? null : parseInt10(item.mod)
    if (item.mod !== undefined && item.mod !== null && mod === null) {
      return { error: `dnd_initiative: combatant "${name}" has an unreadable \`mod\` (${JSON.stringify(item.mod)}). Nothing was written.` }
    }
    const pc = isPc(item)
    entries.push({ name, kind: pc ? 'pc' : 'npc', pc, mod })
  }
  return { entries }
}

/**
 * Normalize the caller's supplied player rolls into a name -> value map.
 *
 * Accepted shapes, because the DM will type whichever is convenient:
 *
 *   { "Alice": 14, "Bob": 9 }             — a map by name
 *   [{ name: "Alice", value: 14 }]        — an array of entries
 *
 * @param raw - the `rolls` argument, or undefined.
 * @returns `{ rolls }` or `{ error }`.
 */
export function parseSuppliedRolls(raw) {
  if (raw === undefined || raw === null) return { rolls: new Map() }
  const rolls = new Map()
  const put = (name, value) => {
    const key = String(name ?? '').trim().toLowerCase()
    if (key === '') return null
    const n = parseInt10(value)
    if (n === null) return `${name}`
    rolls.set(key, n)
    return undefined
  }

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item === null || typeof item !== 'object') {
        return { error: `dnd_initiative: a supplied roll must look like { name, value }, got ${JSON.stringify(item)}. Nothing was written.` }
      }
      const bad = put(item.name, item.value ?? item.roll ?? item.total)
      if (bad !== undefined) {
        return { error: `dnd_initiative: supplied roll for "${bad}" is not a number. Nothing was written.` }
      }
    }
    return { rolls }
  }

  if (typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw)) {
      const bad = put(name, value)
      if (bad !== undefined) {
        return { error: `dnd_initiative: supplied roll for "${bad}" is not a number. Nothing was written.` }
      }
    }
    return { rolls }
  }

  return { error: 'dnd_initiative: `rolls` must be a name -> number map or an array of { name, value }. Nothing was written.' }
}

/**
 * Sort resolved combatants into turn order.
 *
 * Descending initiative. Ties break on the modifier, descending, which is the 5e
 * convention and the same tiebreak combat.py uses. A tie on BOTH is left in the
 * order the caller listed them: it is a genuine tie, and inventing a further
 * tiebreak would reorder two identical combatants on every call for no rule
 * reason.
 *
 * Pending combatants (no initiative) are NOT in this list — they have no value
 * to sort by, and placing them at the bottom would silently put a PC last in a
 * fight whose order is not yet decided.
 *
 * @param resolved - resolved combatant records.
 * @returns a new, sorted array.
 */
export function sortTurnOrder(resolved) {
  return resolved
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      // DESCENDING on both keys. The subtraction is written "b - a" and must stay
      // that way: the guards above compare b against a, so an "a - b" return
      // contradicts its own guard and silently produces an ASCENDING order —
      // exactly the bug this comparator shipped with. It was invisible in the
      // persisted JSON because the same wrong sort fed both the render and the
      // file, so the two agreed with each other while both disagreed with 5e
      // and with combat.py (sorted(..., reverse=True)).
      if (b.entry.initiative !== a.entry.initiative) return b.entry.initiative - a.entry.initiative
      if (b.entry.mod !== a.entry.mod) return b.entry.mod - a.entry.mod
      return a.index - b.index
    })
    .map((wrapped) => wrapped.entry)
}

/**
 * Resolve every combatant's initiative.
 *
 * ## This function is where `players` mode is enforced
 *
 * The rule is one line, and it is deliberately the ONLY branch in this module
 * that decides whether a die is rolled:
 *
 *   a PC in `players` mode with no SUPPLIED roll is not rolled at all
 *
 * Note the shape of the condition. It is not "roll everything, then discard the
 * PC's value" — that would still consume a d20 and, more importantly, would
 * make the value exist somewhere it could leak into the output. `rollD20` is
 * simply never called for that combatant, so no PC d20 exists to be discarded.
 *
 * A supplied roll always wins, in BOTH modes: the DM typing a number is the
 * player's roll arriving, and re-rolling it would replace the player's die with
 * the tool's.
 *
 * @param entries - normalized combatant entries from `parseCombatants`.
 * @param supplied - the name -> value map from `parseSuppliedRolls`.
 * @param mode - `'players'` or `'dm'`.
 * @param modOf - `(entry) => Promise<number>`; resolves a character's modifier.
 * @returns `{ resolved, pending, rollsSupplied, rollsMade }`.
 */
export async function resolveInitiative(entries, supplied, mode, modOf) {
  const resolved = []
  const pending = []
  let rollsMade = 0
  let rollsSupplied = 0

  for (const entry of entries) {
    // A caller-declared modifier wins over the sheet: an improvised NPC has no
    // character file, and a DM who states "+3" should not be overruled by a
    // lookup that finds nothing.
    const mod = entry.mod !== null ? entry.mod : await modOf(entry)

    const given = supplied.get(entry.name.toLowerCase())
    if (given !== undefined) {
      rollsSupplied += 1
      resolved.push({ ...entry, mod, natural: given, initiative: given + mod, source: 'supplied', pending: false })
      continue
    }

    if (mode === 'players' && entry.pc) {
      // NOT ROLLED. No d20 value for this PC exists after this line — see the
      // module header. The entry is recorded as pending so the caller can be
      // told exactly whose number is owed.
      pending.push({ ...entry, mod, pending: true })
      continue
    }

    const roll = rollD20(mod, false, false)
    rollsMade += 1
    resolved.push({ ...entry, mod, natural: roll.natural, initiative: roll.total, source: 'rolled', pending: false })
  }

  return { resolved, pending, rollsMade, rollsSupplied }
}

/**
 * Render the turn order for the model.
 *
 * @param options - `{ ordered, pending, mode, modeSource, modeRaw, character,
 *   round, written, warnings }`.
 * @returns the tool's text result.
 */
export function renderTurnOrder(options) {
  const { ordered, pending, mode, modeSource, modeRaw, character, round, written, warnings } = options
  const lines = []

  const modeText = modeSource === 'default'
    ? 'players (default — state.md sets no roll_mode, so PCs are NEVER rolled for)'
    : `${mode} (from "${modeSource}"'${modeRaw}')`
  lines.push(`**Initiative — Round ${round}** (${character}.encounter.json)`)
  lines.push(`roll_mode: ${modeText}`)
  lines.push('')

  if (ordered.length > 0) {
    lines.push('Turn order:')
    for (const [index, entry] of ordered.entries()) {
      const marker = index === 0 ? '► ' : '  '
      const natural = entry.source === 'supplied'
        ? `player rolled ${entry.natural}`
        : `d20(${entry.natural})`
      const mod = entry.mod >= 0 ? `+${entry.mod}` : String(entry.mod)
      const kind = entry.pc ? 'PC' : 'NPC'
      lines.push(`${marker}${index + 1}. ${entry.name} (${kind}) — ${natural} ${mod} = **${entry.initiative}**`)
    }
  } else {
    lines.push('Turn order: (empty — no combatant has an initiative value yet)')
  }

  if (pending.length > 0) {
    lines.push('')
    lines.push(`WAITING ON THE PLAYERS — not rolled for, and not placed in the order (${pending.length}):`)
    for (const entry of pending) {
      const mod = entry.mod >= 0 ? `+${entry.mod}` : String(entry.mod)
      lines.push(`  · ${entry.name} — needs the player's d20; modifier ${mod}. Pass it as rolls: { "${entry.name}": <d20> }.`)
    }
    lines.push('Ask the player for the number; do NOT roll it for them.')
  }

  if (written === false) {
    lines.push('')
    lines.push('NOTE: the order was NOT written — no character file could be resolved to hold it.')
  }

  for (const warning of warnings ?? []) lines.push(`NOTE: ${warning}`)

  return lines.join('\n')
}

/**
 * Build this module's tools.
 * @param ctx - host context; `fs` is optional.
 * @returns an array of tool definitions.
 */
export function buildTools(ctx) {
  // Lazy, for the same reason as every other family: a mount that loses the
  // startup race must not capture undefined forever.
  const getFs = () => ctx.get('fs')

  /**
   * The sandbox policy each write is judged against, resolved from the session
   * that issued the call. Resolved per call, not cached at mount: a tool may be
   * invoked with no agent at all (unit tests do exactly that), and such a call
   * must be re-evaluated rather than inherit a previous caller's scope.
   *
   * @param exec - the `ToolRunContext`, or undefined.
   */
  const policyFor = (exec) => writePolicyFor(ctx, exec)

  /**
   * Locate the campaign and the character whose encounter file holds the fight.
   *
   * @param fs - the resolved fs service.
   * @param requested - the caller's `character` argument, possibly undefined.
   * @returns `{ dir, campaign, stem, modOf }` or `{ error }`.
   */
  async function locateEncounter(fs, requested, session) {
    const located = await activeCampaignDir(fs, session)
    if (located?.error !== undefined) return { error: located.error }
    if (located === undefined) {
      return { error: 'No active campaign. Load one with /dm:dnd load <campaign> first.' }
    }
    const dir = located.dir + '/characters'
    const listed = await listCharacters(fs, dir)
    if (listed.length === 0) {
      return { error: 'No characters in campaign ' + located.campaign + ', so there is nowhere to keep the turn order.' }
    }

    let stem
    if (requested !== undefined && String(requested).trim() !== '') {
      const wanted = String(requested).toLowerCase().trim()
      const match = listed.find((c) => c.name.toLowerCase() === wanted)
        ?? listed.find((c) => c.name.toLowerCase().includes(wanted))
      if (match === undefined) {
        const available = listed.map((c) => c.name).join(', ')
        return { error: 'Character "' + requested + '" not found in ' + located.campaign + '. Available: ' + available }
      }
      stem = match.name
    } else if (listed.length === 1) {
      stem = listed[0].name
    } else {
      // The order is stored per character, so with several characters the tool
      // must not guess: guessing would write the fight onto the wrong sheet and
      // the next read would look for it somewhere else.
      const available = listed.map((c) => c.name).join(', ')
      return { error: "Which character's encounter file should hold the turn order? " + located.campaign + ' has ' + listed.length + ': ' + available + '. Pass `character`.' }
    }

    return { dir, campaign: located.campaign, stem, modOf: (entry) => readInitiativeMod(fs, dir, entry.name) }
  }

  const initiative = {
    name: 'dnd_initiative',
    description:
      'Roll initiative for several combatants at once and return the SORTED turn order, then persist it so a later call can read it back. '
      + "Rolls d20 + each combatant's initiative modifier through the same dice path as dnd_roll. "
      + "Honours the campaign's roll_mode: in `players` mode a PC is NEVER rolled for - supply the player's number via `rolls` and it joins the order, otherwise it is reported as pending. "
      + 'NPCs and monsters are always rolled. '
      + 'With no `combatants`, reads back the order already stored for this encounter.',
    parameters: {
      type: 'object',
      properties: {
        combatants: {
          type: 'array',
          description: 'Who is in the fight. Either names (["Alice", "Goblin"]) or objects ({ name, kind: "pc"|"npc", mod }). A bare name is an NPC. Omit to READ BACK the stored order.',
        },
        rolls: {
          type: 'object',
          description: 'Player-rolled d20 values, by combatant name: { "Alice": 14 }. Required for a PC in `players` mode, since the tool will not roll for them.',
        },
        character: {
          type: 'string',
          description: "Which character's encounter file holds the turn order. Required when the campaign has more than one character.",
        },
        mode: {
          type: 'string',
          description: "Override the campaign's roll_mode: \"players\" (never roll for a PC) or \"dm\"/\"auto\" (roll everything).",
          enum: ['players', 'dm', 'auto'],
        },
        round: { type: 'integer', description: 'Round number to record. Defaults to 1.' },
        key: { type: 'string', description: 'Idempotency key. Repeating a call with the same key re-reads rather than re-rolling.' },
      },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'

      const located = await locateEncounter(fs, args.character, sessionOf(ctx, exec))
      if (located.error !== undefined) return located.error
      const dir = located.dir
      const stem = located.stem
      const modOf = located.modOf

      // --- READ-BACK path ------------------------------------------------
      // No combatants means "tell me the order again". This is the whole point
      // of persisting: the previous call's ordering must survive into this one.
      if (args.combatants === undefined || args.combatants === null
        || (Array.isArray(args.combatants) && args.combatants.length === 0)) {
        const read = await readEncounter(fs, dir, stem)
        const section = sectionOf(read.encounter, INITIATIVE_SECTION)
        if (section === undefined || section === null) {
          return 'No initiative order is stored for ' + stem + ' yet. Roll one with dnd_initiative, e.g. combatants ["Alice", "Goblin"].'
        }
        if (section.ended === true) {
          return 'The encounter on ' + stem + ' was ended. Roll a new one with dnd_initiative.'
        }
        return renderTurnOrder({
          ordered: Array.isArray(section.order) ? section.order : [],
          pending: Array.isArray(section.pending) ? section.pending : [],
          mode: section.mode ?? 'players',
          modeSource: section.modeSource ?? 'default',
          modeRaw: section.modeRaw ?? null,
          character: stem,
          round: section.round ?? 1,
          written: true,
          warnings: read.warnings,
        })
      }

      const parsed = parseCombatants(args.combatants)
      if (parsed.error !== undefined) return parsed.error
      const supplied = parseSuppliedRolls(args.rolls)
      if (supplied.error !== undefined) return supplied.error

      // The mode: an explicit argument wins, otherwise the campaign's flag.
      const explicitMode = args.mode !== undefined && String(args.mode).trim() !== ''
      const campaignRollMode = explicitMode ? null : await readRollMode(fs, dir + '/..')
      const mode = explicitMode ? normalizeRollMode(args.mode) : campaignRollMode.mode
      const modeSource = explicitMode ? 'argument' : campaignRollMode.source
      const modeRaw = explicitMode ? String(args.mode) : campaignRollMode.raw

      const round = parseInt10(args.round) ?? 1

      const existing = await readEncounter(fs, dir, stem)
      const priorSection = sectionOf(existing.encounter, INITIATIVE_SECTION)

      // --- REROLL GUARD ---------------------------------------------------
      // Without a guard, a second call with the same combatants silently
      // re-rolls every die and the table's initiative changes under them. An
      // explicit key makes the retry safe; without a key the caller asked for a
      // fresh roll, which is legitimate (a new fight).
      const key = args.key === undefined || args.key === null || String(args.key).trim() === ''
        ? null
        : String(args.key).trim()
      if (key !== null && priorSection !== undefined && priorSection !== null && priorSection.key === key) {
        return renderTurnOrder({
          ordered: Array.isArray(priorSection.order) ? priorSection.order : [],
          pending: Array.isArray(priorSection.pending) ? priorSection.pending : [],
          mode: priorSection.mode ?? mode,
          modeSource: priorSection.modeSource ?? modeSource,
          modeRaw: priorSection.modeRaw ?? modeRaw,
          character: stem,
          round: priorSection.round ?? round,
          written: true,
          warnings: [...existing.warnings, 'Already rolled with this key; the existing order was re-read, not re-rolled.'],
        })
      }

      const outcome = await resolveInitiative(parsed.entries, supplied.rolls, mode, modOf)
      const ordered = sortTurnOrder(outcome.resolved)

      const section = {
        key,
        round,
        mode,
        modeSource,
        modeRaw,
        rolledAt: new Date().toISOString(),
        rollsMade: outcome.rollsMade,
        rollsSupplied: outcome.rollsSupplied,
        order: ordered,
        pending: outcome.pending,
      }

      let written = true
      const warnings = [...existing.warnings]
      try {
        await writeEncounter(
          fs, dir, stem,
          mergeEncounter(existing.encounter, INITIATIVE_SECTION, section),
          policyFor(exec),
        )
      } catch (error) {
        // A refused write must not lose the rolls: the order is still returned
        // so the DM can run the fight, with the failure stated rather than
        // hidden behind a success message.
        written = false
        warnings.push('the turn order could not be written (' + (error && error.message ? error.message : error) + '); it is shown below but will not survive the next call')
      }

      return renderTurnOrder({
        ordered, pending: outcome.pending, mode, modeSource, modeRaw,
        character: stem, round, written, warnings,
      })
    },
  }

  const end = {
    name: 'dnd_initiative_end',
    description:
      'End the encounter stored for a character: clears the initiative/turn-order section of the encounter file and leaves any other encounter state (live effects, concentration) untouched. '
      + 'The file itself is kept: the fs service exposes no delete, and the timed-effects family may still hold state in it. '
      + 'Reports whether there was an order to end.',
    parameters: {
      type: 'object',
      properties: {
        character: { type: 'string', description: 'Character name or stem. Omit when the campaign has exactly one.' },
      },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'

      const located = await locateEncounter(fs, args.character, sessionOf(ctx, exec))
      if (located.error !== undefined) return located.error
      const dir = located.dir
      const stem = located.stem

      const existing = await readEncounter(fs, dir, stem)
      if (!existing.exists) {
        return 'No encounter file for ' + stem + '; there was nothing to end.'
      }

      // The section name is passed EXPLICITLY. This helper is shared with the
      // timed-effects family, and a hard-coded default is how one family would
      // clear the other's section. See encounter-io.mjs.
      const cleared = await clearEncounterSection(
        fs, dir, stem, existing.encounter, INITIATIVE_SECTION,
        { ended: true, endedAt: new Date().toISOString() },
        policyFor(exec),
      )

      return cleared.hadSection
        ? 'Encounter ended for ' + stem + ': the initiative order was cleared. Other encounter state was left untouched.'
        : 'No initiative order was stored for ' + stem + '; the encounter file was left unchanged.'
    },
  }

  return [initiative, end]
}
