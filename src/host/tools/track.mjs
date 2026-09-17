/**
 * tools/track.mjs — the write tools.
 *
 *   dnd_track     change HP, temp HP, spell slots, XP, conditions, resources
 *   dnd_spend     take coin out of the purse, refusing an unaffordable spend
 *   dnd_xp_add    award XP and report how far the next level is
 *
 * ## Why these are separate from the read tools
 *
 * Everything in the read families is pure. These four touch the disk, and one
 * of them can destroy a campaign's only copy of a character's numbers. Keeping
 * them in their own module means the write path can be read, tested and reasoned
 * about without the eleven read tools in the way.
 *
 * ## The layering rule
 *
 * Business judgement lives HERE, not in `writeCharacter`. That function's
 * validation is a backstop for a state that cannot exist; refusing a purchase is
 * a decision about the game, and a decision made at the write layer is invisible
 * to the DM — the tool would simply report success and the numbers would not
 * move. So `dnd_spend` computes affordability, and when the purse is short it
 * returns the shortfall and writes nothing at all. `writeCharacter` never sees a
 * negative purse because this layer never builds one.
 *
 * ## Idempotency, and what it can honestly mean
 *
 * The requirement is "a repeated request must not apply twice". It cannot be
 * satisfied by inspecting the request: buying two identical torches is two
 * legitimate purchases, and no amount of comparing text can tell that apart from
 * one purchase sent twice.
 *
 * So idempotency is keyed, and the key is the caller's: pass `key`, and a second
 * call with the same key is a no-op reported as `duplicate: true`. Without a
 * key, every call applies — which is the correct default, because a DM saying
 * "take 5 damage" twice means 10 damage.
 *
 * The record of applied keys is stored in the state file under `appliedKeys`,
 * so it survives a restart, and it is bounded (see MAX_APPLIED_KEYS) so a
 * long-running campaign cannot grow the file without limit.
 *
 * ## Why every write is a read-modify-write
 *
 * The tool reads the character, changes one field, and writes the whole state
 * back. It does not patch the file. That means a tool can never produce a state
 * that the schema would not have produced, and the canonical serializer keeps
 * the diff to the lines that actually changed.
 */

import { activeCampaignDir, readTextOrUndefined } from './shared.mjs'
import { readCalendar } from './clock.mjs'
import { readCharacter, writeCharacter, listCharacters, statePath } from './state-io.mjs'
import { formatCurrency, formatCurrencyShort, toCopper, formatFindings } from './state-rules.mjs'
import { normalizeState, MAX_APPLIED_KEYS } from './state-schema.mjs'

export const name = 'dnd-track'

// Re-exported so callers can reason about the cap without importing the schema.
export { MAX_APPLIED_KEYS }

/** Render a plain string result for the model. */
const renderText = (_args, value) => [{ type: 'text', text: String(value) }]

/**
 * Resolve the character a write tool should act on.
 *
 * @param fs - the host fs service.
 * @param requested - the caller's `character` argument, possibly undefined.
 * @returns `{ dir, campaign, name, character }` or `{ error }`.
 */
async function locateCharacter(fs, requested) {
  const located = await activeCampaignDir(fs)
  if (located === undefined) {
    return { error: 'No active campaign. Load one with /dm:dnd load <campaign> first.' }
  }
  const dir = `${located.dir}/characters`
  const listed = await listCharacters(fs, dir)

  if (listed.length === 0) {
    return { error: `No characters in campaign ${located.campaign}.` }
  }

  let name
  if (requested !== undefined && String(requested).trim() !== '') {
    const wanted = String(requested).toLowerCase().trim()
    const match = listed.find((c) => c.name.toLowerCase() === wanted)
      ?? listed.find((c) => c.name.toLowerCase().includes(wanted))
    if (match === undefined) {
      const available = listed.map((c) => c.name).join(', ')
      return { error: `Character "${requested}" not found in ${located.campaign}. Available: ${available}` }
    }
    name = match.name
  } else if (listed.length === 1) {
    // Unambiguous, so requiring the name would be ceremony.
    name = listed[0].name
  } else {
    const available = listed.map((c) => c.name).join(', ')
    return { error: `Which character? ${located.campaign} has ${listed.length}: ${available}` }
  }

  const character = await readCharacter(fs, dir, name)
  if (character.state === null) {
    return { error: `Could not read state for "${name}": ${character.warnings.join('; ')}` }
  }
  return { dir, campaign: located.campaign, name, character }
}

/**
 * Build the metadata options for a write, carrying the campaign's clocks.
 * @param fs - the host fs service.
 * @param located - the result of `locateCharacter`.
 */
async function writeOptions(fs, located) {
  const calendar = await readCalendar(fs, `${located.dir}/..`)
  return {
    calendar,
    player: located.character.metadata?.player ?? null,
    campaign: located.campaign,
    tags: located.character.metadata?.tags ?? ['pc'],
  }
}

/**
 * Apply a change to a character and write it, collecting the shared reporting.
 *
 * Every write tool goes through here so that refusal, warning and reporting
 * behave identically — the alternative is three tools that each handle a
 * refused write slightly differently, and a DM who has to learn which is which.
 *
 * @param fs - the host fs service.
 * @param located - the located character.
 * @param mutate - `(state) => undefined`; mutates the state in place, or
 *   returns an object `{ refuse: string }` to stop without writing.
 * @param options - `{ key }` for idempotency, plus an optional `now`.
 * @returns `{ ok, text }`.
 */
async function applyChange(fs, located, mutate, options = {}) {
  const state = normalizeState(located.character.state)
  const existingKeys = Array.isArray(state.appliedKeys) ? state.appliedKeys : []

  // Idempotency is checked before anything is computed, so a duplicate request
  // cannot half-apply and then discover it was a duplicate.
  const key = options.key === undefined || options.key === null || String(options.key).trim() === ''
    ? null
    : String(options.key).trim()
  if (key !== null && existingKeys.includes(key)) {
    return { ok: true, duplicate: true, text: `Already applied (key "${key}"); nothing changed. No second charge.` }
  }

  const refusal = mutate(state)
  if (refusal !== undefined && refusal !== null && typeof refusal.refuse === 'string') {
    return { ok: false, refused: true, text: refusal.refuse }
  }

  if (key !== null) {
    // Newest last, oldest dropped. The cap is what keeps this from becoming a
    // per-purchase append log.
    const next = [...existingKeys.filter((k) => k !== key), key]
    state.appliedKeys = next.slice(Math.max(0, next.length - MAX_APPLIED_KEYS))
  }

  const written = await writeCharacter(fs, located.dir, located.name, {
    state,
    narrative: located.character.narrative,
    ...(await writeOptions(fs, located)),
    now: options.now ?? new Date(),
  })

  if (written.refused === true) {
    // The backstop fired: the tool built a state that cannot exist. Report it
    // as a failure rather than as a successful change, because nothing moved.
    return {
      ok: false,
      refused: true,
      findings: written.findings,
      text: `Refused, nothing written — the change would produce an impossible state.\n${written.reason}`,
    }
  }

  const warns = (written.findings ?? []).filter((f) => f.level !== 'error')
  return {
    ok: true,
    refused: false,
    findings: written.findings,
    warnings: formatFindings(warns),
    written: written.written,
    text: options.describe !== undefined ? options.describe(state) : 'Written.',
  }
}

/**
 * Build the write tools.
 * @param ctx - host context; `fs` is optional.
 * @returns an array of tool definitions.
 */
export function buildTools(ctx) {
  // Lazy, for the same reason as every other family: a mount that loses the
  // startup race must not capture undefined forever.
  const getFs = () => ctx.get('fs')

  const track = {
    name: 'dnd_track',
    description:
      'Change a character\'s tracked numbers and write them to disk: hit points (delta or absolute), '
      + 'temporary HP, spell slots expended or restored, XP, conditions, or a named expendable resource. '
      + 'Reads the character, applies one change, and writes both files with fresh clocks. '
      + 'Pass `key` to make a retry safe: the same key applied twice is a no-op. '
      + 'Use `dnd_character_get` to read values back.',
    parameters: {
      type: 'object',
      properties: {
        character: { type: 'string', description: 'Character name or stem. Omit when the campaign has exactly one.' },
        key: { type: 'string', description: 'Idempotency key. Repeating a call with the same key changes nothing the second time.' },
        hp: { type: 'string', description: 'Hit-point change: "-7" for damage, "+5" for healing, "=12" to set outright.' },
        tempHp: { type: 'string', description: 'Temporary HP: "+8" to set, "0" to clear. Temporary HP does not stack; the higher value wins.' },
        spellSlots: { type: 'string', description: 'Slot change by level, e.g. "1:-1,2:-1" to expend, "1:+2" to restore. Negative expends.' },
        xp: { type: 'string', description: 'XP change: "+250" to award, "-100" to remove, "=900" to set.' },
        conditions: { type: 'string', description: 'Comma-separated conditions to add, or "none" to clear them all.' },
        removeConditions: { type: 'string', description: 'Comma-separated conditions to remove, e.g. "poisoned,prone".' },
        resource: { type: 'string', description: 'Name of a consumable to adjust, e.g. "Rations", "Arrows".' },
        resourceDelta: { type: 'string', description: 'Change for `resource`, e.g. "-1". Requires `resource`.' },
        reason: { type: 'string', description: 'Short note recorded in the returned summary, e.g. "goblin arrow".' },
      },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'

      const located = await locateCharacter(fs, args.character)
      if (located.error !== undefined) return located.error

      const changes = []
      const result = await applyChange(fs, located, (state) => {
        const refused = applyTrackChanges(state, args, changes)
        return refused
      }, {
        key: args.key,
        describe: (state) => describeTrack(located.name, changes, state, args.reason),
      })

      return result.text
    },
  }

  const spend = {
    name: 'dnd_spend',
    description:
      'Spend coin from a character\'s purse and write the result. '
      + 'Accepts "15 cp", "8 gp", "1 gp 5 sp" or a bare copper total. '
      + 'Affordability is judged on the TOTAL, never on a single denomination, so 800 cp can pay a 15 cp cost with no copper pieces. '
      + 'A spend that cannot be afforded is REFUSED: nothing is written and no debt is recorded. '
      + 'Pass `key` to make a retry safe.',
    parameters: {
      type: 'object',
      properties: {
        character: { type: 'string', description: 'Character name or stem. Omit when the campaign has exactly one.' },
        amount: { type: 'string', description: 'The cost, e.g. "15 cp", "8 gp", "2 gp 5 sp". Required.' },
        key: { type: 'string', description: 'Idempotency key. A second call with the same key does not charge again.' },
        reason: { type: 'string', description: 'What the coin was spent on, e.g. "10 arrows".' },
      },
      required: ['amount'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'

      // Argument validation at the tool layer, not in the schema library: an
      // absent amount reached an earlier build as the literal cost of
      // `undefined`, which parsed to 0 and "succeeded".
      if (args.amount === undefined || args.amount === null || String(args.amount).trim() === '') {
        return 'dnd_spend needs an `amount`, e.g. "15 cp" or "2 gp 5 sp". Nothing was written.'
      }
      const cost = toCopper(args.amount)
      if (!Number.isFinite(cost) || cost <= 0) {
        return `dnd_spend could not read "${args.amount}" as a positive cost. Nothing was written.`
      }

      const located = await locateCharacter(fs, args.character)
      if (located.error !== undefined) return located.error

      let report = null
      const result = await applyChange(fs, located, (state) => {
        const before = toCopper(state.currency)
        const after = before - cost
        if (after < 0) {
          // Refused at the tool layer. The message names the shortfall so the
          // DM can decide, rather than being told only that it failed.
          const short = -after
          return {
            refuse: `REFUSED: ${located.name} has ${formatCurrency(before)}, which does not cover `
              + `${formatCurrencyShort(cost)}. Short by ${formatCurrencyShort(short)}. `
              + 'Nothing was written and no debt was recorded.',
          }
        }
        state.currency = after
        report = { before, after, cost }
        return undefined
      }, {
        key: args.key,
        describe: (state) => {
          const what = args.reason !== undefined ? ` (${args.reason})` : ''
          return `Spent ${formatCurrencyShort(report.cost)}${what}. `
            + `Purse: ${formatCurrencyShort(report.before)} -> ${formatCurrencyShort(report.after)} `
            + `(${formatCurrency(state.currency)}).`
        },
      })

      return result.text
    },
  }

  const xpAdd = {
    name: 'dnd_xp_add',
    description:
      'Award or remove experience and write it to the character. '
      + 'Reports the new total and how much remains until the next level. '
      + 'It does NOT level the character up: advancement changes HP, slots, proficiencies and features, which is a rules decision the DM makes explicitly. '
      + 'Pass `key` to make a retry safe.',
    parameters: {
      type: 'object',
      properties: {
        character: { type: 'string', description: 'Character name or stem. Omit when the campaign has exactly one.' },
        amount: { type: 'string', description: 'XP to award, e.g. "250" or "+250". A negative value removes. Required.' },
        key: { type: 'string', description: 'Idempotency key. A second call with the same key does not award twice.' },
        reason: { type: 'string', description: 'What earned it, e.g. "goblin ambush".' },
      },
      required: ['amount'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'

      if (args.amount === undefined || args.amount === null || String(args.amount).trim() === '') {
        return 'dnd_xp_add needs an `amount`, e.g. "250". Nothing was written.'
      }
      const amount = parseSigned(args.amount)
      if (amount === null) {
        return `dnd_xp_add could not read "${args.amount}" as a number. Nothing was written.`
      }

      const located = await locateCharacter(fs, args.character)
      if (located.error !== undefined) return located.error

      let report = null
      const result = await applyChange(fs, located, (state) => {
        const before = numOr(state.identity.xp, 0)
        const after = before + amount
        if (after < 0) {
          return {
            refuse: `REFUSED: ${located.name} has ${before} XP; removing ${Math.abs(amount)} would leave a negative total. `
              + 'Nothing was written.',
          }
        }
        state.identity = { ...state.identity, xp: after }
        report = { before, after, amount, next: numOrNull(state.identity.xpNext) }
        return undefined
      }, {
        key: args.key,
        describe: (state) => {
          const what = args.reason !== undefined ? ` (${args.reason})` : ''
          const delta = report.amount >= 0 ? `+${report.amount}` : String(report.amount)
          let text = `${delta} XP${what}. ${located.name}: ${report.before} -> ${report.after}.`
          if (report.next !== null) {
            const remaining = report.next - report.after
            text += remaining > 0
              ? ` ${remaining} XP until level ${numOr(state.identity.level, 1) + 1} (at ${report.next}).`
              : ` Ready to advance to level ${numOr(state.identity.level, 1) + 1} at ${report.next} XP — level up is a separate, explicit step.`
          }
          return text
        },
      })

      return result.text
    },
  }

  return [track, spend, xpAdd]
}

/**
 * Apply the `dnd_track` arguments to a state in place.
 *
 * @param state - the normalized state; mutated.
 * @param args - the tool arguments.
 * @param changes - an array the caller supplies to collect human-readable changes.
 * @returns a refusal object, or undefined when the change should proceed.
 */
export function applyTrackChanges(state, args, changes) {
  const touched = []

  if (args.hp !== undefined && String(args.hp).trim() !== '') {
    const op = parseOp(String(args.hp))
    if (op === null) return { refuse: `dnd_track could not read hp "${args.hp}". Use "-7", "+5" or "=12". Nothing was written.` }
    const max = numOrNull(state.combat?.hp?.max)
    const current = numOr(state.combat?.hp?.current, 0)
    const next = op.mode === 'set' ? op.value : current + op.value
    if (next < 0) {
      // Damage that takes a character below 0 is not an error at the table —
      // 0 is the floor and the death saves start. Reporting the clamp keeps the
      // DM informed rather than silently rewriting what they asked for.
      changes.push(`HP ${current} -> 0 (clamped from ${next}; 0 is the floor, and the character is dying)`)
      state.combat = { ...state.combat, hp: { ...(state.combat?.hp ?? {}), current: 0 } }
      touched.push('hp')
    } else if (max !== null && next > max) {
      changes.push(`HP ${current} -> ${max} (clamped from ${next}; the maximum is ${max})`)
      state.combat = { ...state.combat, hp: { ...(state.combat?.hp ?? {}), current: max } }
      touched.push('hp')
    } else {
      changes.push(`HP ${current} -> ${next}`)
      state.combat = { ...state.combat, hp: { ...(state.combat?.hp ?? {}), current: next } }
      touched.push('hp')
    }
  }

  if (args.tempHp !== undefined && String(args.tempHp).trim() !== '') {
    const op = parseOp(String(args.tempHp))
    if (op === null) return { refuse: `dnd_track could not read tempHp "${args.tempHp}". Nothing was written.` }
    const before = numOr(state.combat?.tempHp, 0)
    // Temporary HP does not stack: the rules say a new source replaces the old
    // one if it is higher. Applying it as a sum would quietly make the
    // character tougher than the rules allow.
    let next
    if (op.mode === 'set') next = Math.max(0, op.value)
    else if (op.value <= 0) next = Math.max(0, before + op.value)
    else next = Math.max(before, op.value)
    if (next !== before) changes.push(`Temp HP ${before} -> ${next}${op.value > 0 && next === before ? ' (unchanged: the existing value is higher, and temp HP does not stack)' : ''}`)
    else if (op.value > 0) changes.push(`Temp HP stays ${before} (the new ${op.value} is lower; temp HP does not stack)`)
    state.combat = { ...state.combat, tempHp: next }
    touched.push('tempHp')
  }

  if (args.spellSlots !== undefined && String(args.spellSlots).trim() !== '') {
    const parsed = parseSlotOps(String(args.spellSlots))
    if (parsed === null) {
      return { refuse: `dnd_track could not read spellSlots "${args.spellSlots}". Use "1:-1,2:-1" to expend or "1:+2" to restore. Nothing was written.` }
    }
    const slots = { ...(state.spellSlots ?? {}) }
    for (const [level, delta] of Object.entries(parsed)) {
      const entry = slots[level]
      if (entry === undefined || entry === null) {
        return { refuse: `dnd_track: ${state.name ?? 'the character'} has no level-${level} spell slots. Nothing was written.` }
      }
      const total = numOr(entry.total, 0)
      const used = numOr(entry.used, 0)
      // The argument reads from the character's point of view: "-1" expends a
      // slot, "+2" restores two. `used` counts what has been EXPENDED, so the
      // sign flips here. Getting this backwards is silent — the slot count
      // simply moves the wrong way and still looks plausible.
      const expended = used - delta
      if (expended < 0) {
        changes.push(`Level ${level} slots: already fully restored (${total - used}/${total}); no change`)
        continue
      }
      if (expended > total) {
        const over = expended - total
        return {
          refuse: `REFUSED: level-${level} slots are ${total - used}/${total} available; expending ${over} more exceeds the total of ${total}. `
            + 'Nothing was written.',
        }
      }
      slots[level] = { total, used: expended }
      changes.push(`Level ${level} slots: ${total - used}/${total} -> ${total - expended}/${total}`)
    }
    state.spellSlots = slots
    touched.push('spellSlots')
  }

  if (args.xp !== undefined && String(args.xp).trim() !== '') {
    const op = parseOp(String(args.xp))
    if (op === null) return { refuse: `dnd_track could not read xp "${args.xp}". Nothing was written.` }
    const before = numOr(state.identity?.xp, 0)
    const next = op.mode === 'set' ? op.value : before + op.value
    if (next < 0) return { refuse: `REFUSED: XP would become ${next}. Nothing was written.` }
    changes.push(`XP ${before} -> ${next}`)
    state.identity = { ...state.identity, xp: next }
    touched.push('xp')
  }

  if (args.conditions !== undefined && String(args.conditions).trim() !== '') {
    const raw = String(args.conditions).trim()
    if (raw.toLowerCase() === 'none' || raw.toLowerCase() === 'clear') {
      const before = Array.isArray(state.conditions) ? state.conditions : []
      changes.push(before.length > 0 ? `Conditions cleared (was ${before.join(', ')})` : 'Conditions already clear')
      state.conditions = []
    } else {
      const before = Array.isArray(state.conditions) ? state.conditions : []
      const added = splitList(raw).filter((c) => !before.includes(c))
      state.conditions = [...before, ...added]
      changes.push(added.length > 0 ? `Conditions added: ${added.join(', ')}` : 'Conditions unchanged (already present)')
    }
    touched.push('conditions')
  }

  if (args.removeConditions !== undefined && String(args.removeConditions).trim() !== '') {
    const before = Array.isArray(state.conditions) ? state.conditions : []
    const drop = new Set(splitList(String(args.removeConditions)))
    const after = before.filter((c) => !drop.has(c))
    state.conditions = after
    const removed = before.filter((c) => drop.has(c))
    changes.push(removed.length > 0 ? `Conditions removed: ${removed.join(', ')}` : 'No matching conditions to remove')
    touched.push('conditions')
  }

  if (args.resource !== undefined && String(args.resource).trim() !== '') {
    if (args.resourceDelta === undefined || String(args.resourceDelta).trim() === '') {
      return { refuse: 'dnd_track: `resource` needs a `resourceDelta`, e.g. resource "Rations" with resourceDelta "-1". Nothing was written.' }
    }
    const delta = parseSigned(args.resourceDelta)
    if (delta === null) {
      return { refuse: `dnd_track could not read resourceDelta "${args.resourceDelta}". Nothing was written.` }
    }
    const itemName = String(args.resource).trim()
    // Gear is the consumer's bucket; ammunition and rations both land here.
    const gear = { ...(state.equipment?.gear ?? {}) }
    const before = numOr(gear[itemName], 0)
    const after = before + delta
    if (after < 0) {
      return {
        refuse: `REFUSED: ${state.name ?? 'the character'} has ${before} x ${itemName}; `
          + `using ${Math.abs(delta)} would go below zero. Nothing was written.`,
      }
    }
    gear[itemName] = after
    changes.push(`${itemName}: ${before} -> ${after}`)
    state.equipment = { ...state.equipment, gear }
    touched.push('resource')
  }

  if (touched.length === 0) {
    changes.push('Nothing to change: pass at least one of hp, tempHp, spellSlots, xp, conditions, resource.')
  }
  return undefined
}

/** Format the dnd_track result. */
function describeTrack(name, changes, state, reason) {
  const what = reason !== undefined && String(reason).trim() !== '' ? ` (${reason})` : ''
  const hp = state.combat?.hp ?? {}
  const tail = hp.current !== null && hp.current !== undefined
    ? ` HP now ${hp.current}/${hp.max ?? '?'}.`
    : ''
  return `${name}${what}\n` + changes.map((c) => '  ' + c).join('\n') + tail
}

/** Parse a signed number, tolerating a leading `+`. */
function parseSigned(value) {
  const s = String(value).trim().replace(/^\+/, '')
  const n = Number(s)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/**
 * Parse `"-7"`, `"+5"` or `"=12"`.
 * @returns `{ mode: 'add'|'set', value }`, or null when unreadable.
 */
function parseOp(text) {
  const s = String(text).trim()
  if (s.startsWith('=')) {
    const n = parseSigned(s.slice(1))
    return n === null ? null : { mode: 'set', value: n }
  }
  const n = parseSigned(s)
  return n === null ? null : { mode: 'add', value: n }
}

/**
 * Parse `"1:-1,2:+1"` into `{ '1': -1, '2': 1 }`.
 * @returns the map, or null when unreadable.
 */
function parseSlotOps(text) {
  const out = {}
  for (const part of String(text).split(',')) {
    const piece = part.trim()
    if (piece === '') continue
    const m = piece.match(/^(\d+)\s*:\s*([+-]?\d+)$/)
    if (m === null) return null
    out[m[1]] = Number(m[2])
  }
  return Object.keys(out).length === 0 ? null : out
}

/** Split a comma-separated list into trimmed, non-empty items. */
function splitList(text) {
  return String(text)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

const numOr = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
