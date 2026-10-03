/**
 * tools/effects.mjs 鈥?timed effects, spell concentration, and death saves.
 *
 *   dnd_effect        start / tick / end a timed effect; advance the clock
 *   dnd_concentration establish, break (which forces a save), or end focus
 *   dnd_death_save    advance the dying character's success/failure tally
 *
 * ## 1. Layering: why these are three NEW tools, not more `dnd_track` fields
 *
 * The task card asked for this decision explicitly, so here is the reasoning
 * rather than a quiet choice.
 *
 * `dnd_track` is a WIDE tool: nine change fields (hp, tempHp, spellSlots, xp,
 * conditions, removeConditions, resource, resourceDelta, plus `key`). Its whole
 * readability comes from one property 鈥?**every field is a "read one number,
 * change that number" instruction**, and the arguments carry no history. A DM
 * reading `{ hp: "-7" }` knows exactly what happens. That is what makes the tool
 * safe to call without re-reading anything first.
 *
 * Duration semantics break that property rather than extend it:
 *
 *   - A duration is not a number on the character. It is a number on an
 *     IDENTIFIED effect (`Bless`, `Hunter's Mark`), and a character can hold
 *     several at once. `dnd_track` has no way to say WHICH one a field means, so
 *     it would need a whole addressing scheme (effectName, effectAction,
 *     effectDuration) bolted alongside the nine existing scalars 鈥?and every one
 *     of those fields would be meaningless unless the others were present too.
 *   - The verbs are not independent scalars; they are a state machine
 *     (start -> tick* -> end/expire) whose transitions have consequences. Ending
 *     an effect can end concentration; breaking concentration forces a save.
 *     `dnd_track` applies its fields in a fixed order and reports a flat change
 *     list, and there is no place in that shape to say "ending THIS effect also
 *     dropped your concentration on THAT spell".
 *   - Tick is a CAMPAIGN-LEVEL operation, not a character-level one. Advancing a
 *     round advances every effect on every combatant. `dnd_track` is keyed to
 *     exactly one character, so a per-round tick would have to be called once per
 *     combatant and would be trivially forgettable 鈥?the exact failure mode
 *     (relying on the DM's memory) this card exists to remove.
 *
 * So the split is: `dnd_track` keeps changing numbers ON the sheet, and this
 * module owns things that have a LIFETIME. The one crossover is deliberate and
 * small: `dnd_death_save` writes the encounter-scoped tally and ALSO mirrors the
 * count onto the sheet's pre-existing `combat.deathSaves` field, because a panel
 * reading that field must not go stale. Its meaning is unchanged.
 *
 * ## 2. Why the arithmetic is a pure function
 *
 * The reason `roll.mjs`'s six tools are easy to reason about is that they are
 * STATELESS: no hidden clock, no ordering requirement, no ambient "now". This
 * module keeps that property where it matters. `tickEffects()` is a pure
 * function of `(effects, options)`:
 *
 *     tickEffects(effects, { rounds: 1 }) -> { remaining, expired, elapsed }
 *
 * It reads no clock, touches no disk, and mutates neither its input nor any
 * module-level state. Every rule worth testing (a 10-round Bless expiring on the
 * tenth tick, concentration ending when its effect expires, a minute effect
 * converting to rounds) is testable by calling one function with a literal, and
 * the tools below are thin wrappers that load, call, and save.
 *
 * ## 3. Minute/hour durations: an explicit tick, NOT wall-clock time
 *
 * `tracker.py` stores `started_at = time.time()` for minute and hour effects and
 * computes the remainder from the wall clock. **This module deliberately does
 * not.** The reasons, in order of how much they cost:
 *
 *   a. Wall-clock time is hidden state that no test can control and no DM can
 *      verify. "Hunter's Mark has 4 minutes left" would be a claim about the
 *      host's system clock, not about the game. A unit test for it either sleeps
 *      (slow, flaky) or fakes the clock (then it tests the fake).
 *   b. It silently changes meaning between calls. A long rest, a DM thinking out
 *      loud for ten real minutes, or a laptop that slept overnight all advance a
 *      Hunter's Mark the table never narrated as passing. The game's time and
 *      the wall's time are different quantities and this file only knows the
 *      first.
 *   c. It is not recoverable. Once the remainder is derived from `started_at`,
 *      the file no longer records what was bought; it records when the DM
 *      pressed a key.
 *
 * So a duration is stored as a UNIT plus a REMAINING COUNT and decremented by an
 * explicit tick, exactly like a round effect:
 *
 *     { name: "Hunter's Mark", duration: { unit: 'minutes', remaining: 10 } }
 *
 * A round tick decrements every effect by SIX SECONDS, whatever unit it is
 * expressed in. To move minute effects the caller passes `minutes` (or `hours`)
 * to the same tick 鈥?so the table's own narration ("you spend ten minutes
 * searching the room") is what advances the clock, and a long rest is one
 * `hours: 8`.
 *
 * **What this costs, stated plainly.** The DM must tell the tool that time
 * passed; it will never tick on its own. A DM who forgets will find a 10-minute
 * spell still running an hour later instead of silently expired 鈥?a visible
 * wrong answer rather than an invisible one. That is the trade this repo's
 * pure-function preference asks for, and it is the same trade `roll.mjs` makes:
 * the tool answers what it was asked and does not infer.
 *
 * ## 4. The unit conversion, and why it is a table
 *
 * Everything is counted in SECONDS internally, so the three units are
 * comparable and one tick can decrement a mixed set.
 *
 *      1 round  = 6 seconds   (SRD 5.2, "The Order of Combat")
 *      1 minute = 60 seconds
 *      1 hour   = 3600 seconds
 *
 * A `rounds` tick is ONE ROUND (6 seconds), not one unit of whatever the effect
 * uses. That is the rule the table plays by: the initiative order comes back
 * around, the Bless that was "5 rounds" is one round closer to done, and the
 * 10-minute Hunter's Mark has lost six seconds. The other reading 鈥?a round tick
 * consuming a whole minute 鈥?would make a 1-minute spell expire after one turn.
 *
 * ## 5. Concentration and the save it forces
 *
 * SRD 5.2, "Concentration":
 *
 *     "Whenever you take damage while you are concentrating on a spell, you
 *      must make a Constitution saving throw to maintain your concentration.
 *      The DC equals 10 or half the damage you take, whichever number is
 *      higher."
 *
 * `breakSaveDc(damage)` is that rule: `max(10, Math.floor(damage / 2))`.
 * `Math.floor`, not `Math.round`: at 21 damage half is 10.5 and the rule takes
 * the HIGHER of 10 and half, so the DC stays 10 until 22 damage. At 30 it is 15.
 *
 * Losing concentration is what the DM has to ANNOUNCE, so the save is not merely
 * recorded: `dnd_concentration action: "break"` returns the DC and a
 * ready-to-run `dnd_save` line. When the effect that expired was the
 * concentrating one, `dnd_effect action: "tick"` reports the same break in its
 * output, so an expiry cannot quietly leave a concentration flag pointing at a
 * spell that is over.
 *
 * ## 6. Death saves, and how far the model goes
 *
 * SRD 5.2, "Death Saving Throws": at 0 HP a character is dying; roll a d20 at
 * the start of each turn, 10 or higher succeeds. Three successes make the
 * character STABLE, three failures make them DEAD, and a natural 1 counts as
 * TWO failures, a natural 20 restores 1 hit point.
 *
 * Modelled: the tally, both verdicts, the natural 1 doubling, and the natural 20
 * revival. Not modelled, deliberately: AUTOMATIC reset when the character
 * regains hit points. Tracking that would mean this tool watching every HP
 * change the `dnd_track` family makes, across two modules and two files, and a
 * half-wired version would reset the tally at moments the rules do not. The
 * tally is reset by the explicit `action: "reset"` instead, and the tool's own
 * description says so, so the model acts on it rather than discovering it by
 * surprise.
 *
 * ## 7. Where the state lives
 *
 * In `<name>.encounter.json`, alongside T8's turn order 鈥?see encounter-io.mjs
 * for why that file exists, and `mergeEncounter` for the rule that lets two
 * families share it without destroying each other's sections. This module owns
 * `effects`, `concentration` and the encounter-scoped `deathSaves`; it never
 * writes `initiative` or `turnOrder`, and it never assumes those are either
 * present or absent.
 *
 * Writes thread the sandbox policy exactly like every other write tool:
 * `async execute(args, exec)` and `policyFor(exec)` as the 5th argument of
 * `fs.writeText` (through encounter-io.mjs). Omitting it is the defect recorded
 * in session-scope.mjs. Reads take no policy and never write.
 */

import {
  EFFECTS_SECTION,
  readEncounter,
  mergeEncounter,
  sectionOf,
  writeEncounter,
} from './encounter-io.mjs'
import { activeCampaignDir } from './shared.mjs'
import { readCharacter, writeCharacter, listCharacters } from './state-io.mjs'
import { normalizeState } from './state-schema.mjs'
import { readCalendar } from './clock.mjs'
import { sessionOf, writePolicyFor } from './session-scope.mjs'
import { withWriteDiagnosis } from './write-errors.mjs'

export const name = 'dnd-effects'

/** The encounter sections this family owns. Named so a reader sees the split. */
export const CONCENTRATION_SECTION = 'concentration'
export const ENCOUNTER_DEATH_SAVES_SECTION = 'deathSaves'

/**
 * The keyed-idempotency ledger, in the encounter file this family already owns.
 *
 * ## Why a ledger is needed at all
 *
 * All three tools advertise a `key` parameter ("Repeating a call with the same
 * key changes nothing the second time"). That promise was in the SCHEMA and the
 * description but nothing consumed it, so a retried call applied a second time.
 * The damage depends on which tool retried:
 *
 *   - `dnd_death_save` is the dangerous one. A retried `failure` adds a SECOND
 *     failure to the tally, so a retry at 0/2 reports the character DEAD. The
 *     tool's own contract says a retry cannot do that, and a model that retries
 *     after a timeout would kill a character who is merely dying.
 *   - `dnd_concentration` re-wrote the record with a fresh `since` stamp, so a
 *     retry was observable as a state change even though nothing happened.
 *   - `dnd_effect` merely LOOKED idempotent for `start`: restarting an effect of
 *     the same name writes the same value, which is a coincidence of "same name
 *     replaces", not idempotency. `end` and a `tick` both re-ran.
 *
 * ## Why the ledger lives in the encounter file
 *
 * `dnd_track` keeps its ledger in `<name>.state.json` under `appliedKeys`, and
 * the calendar keeps one in `calendar.json`. Each ledger lives in the file its
 * own family writes, which is what makes the check-and-record atomic under that
 * file's lock. This family writes the encounter file (see encounter-io.mjs), so
 * the ledger goes there. Putting it on the sheet would mean a death-save retry
 * had to read and write a file this family otherwise only mirrors to, and the
 * duplicate check would sit outside the lock that serializes the tally.
 *
 * The section is deliberately NOT one of the three state sections: it is
 * bookkeeping about calls, not combat state, and a reader of `effects`,
 * `concentration` or `deathSaves` must never have to skip over it.
 */
export const APPLIED_KEYS_SECTION = 'appliedKeys'

/**
 * How many idempotency keys the encounter file remembers.
 *
 * Mirrors `MAX_APPLIED_KEYS` in state-schema.mjs so the two ledgers behave
 * identically. Newest last, oldest dropped: the cap is what stops this becoming
 * an append-only log of every call ever made.
 */
export const MAX_ENCOUNTER_KEYS = 32

/**
 * Read the caller's idempotency key, or null when none was given.
 *
 * A blank string counts as no key, matching `dnd_track`: an empty `key` must
 * not become a shared bucket that makes every later keyless call a duplicate.
 */
export function requestKey(args) {
  const raw = args === null || args === undefined ? undefined : args.key
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  return String(raw).trim()
}

/**
 * The ledger as a safe array of strings.
 * @param value - the stored section.
 */
export function asKeyList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((k) => typeof k === 'string' && k !== '')
}

/**
 * Append a key to the ledger, newest last, dropping the oldest past the cap.
 * PURE: returns a new array.
 * @param keys - the existing ledger.
 * @param key - the key just applied.
 */
export function withKeyRecorded(keys, key) {
  const next = [...asKeyList(keys).filter((k) => k !== key), key]
  return next.slice(Math.max(0, next.length - MAX_ENCOUNTER_KEYS))
}

/**
 * Seconds in each unit an effect's duration can be expressed in.
 *
 * Exported so a test pins the conversion rather than restating it. A round is
 * six seconds in 5e (SRD 5.2, "The Order of Combat").
 */
export const UNIT_SECONDS = {
  rounds: 6,
  seconds: 1,
  minutes: 60,
  hours: 3600,
}

/** Longest suffix first, so "10mins" is not read as "10m" + "ins". */
const UNIT_SUFFIXES = [
  { suffix: 'rounds', unit: 'rounds' },
  { suffix: 'round', unit: 'rounds' },
  { suffix: 'r', unit: 'rounds' },
  { suffix: 'minutes', unit: 'minutes' },
  { suffix: 'minute', unit: 'minutes' },
  { suffix: 'mins', unit: 'minutes' },
  { suffix: 'min', unit: 'minutes' },
  { suffix: 'm', unit: 'minutes' },
  { suffix: 'hours', unit: 'hours' },
  { suffix: 'hour', unit: 'hours' },
  { suffix: 'hrs', unit: 'hours' },
  { suffix: 'hr', unit: 'hours' },
  { suffix: 'h', unit: 'hours' },
  { suffix: 'seconds', unit: 'seconds' },
  { suffix: 'second', unit: 'seconds' },
  { suffix: 'secs', unit: 'seconds' },
  { suffix: 'sec', unit: 'seconds' },
  { suffix: 's', unit: 'seconds' },
]

/** The unit name for an effect that never expires on its own. */
export const INDEFINITE = 'indefinite'

// 鈹€鈹€鈹€ Pure rules 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
//
// Everything down to "the tools" is pure: no fs, no clock, no module-level
// mutable state, and no argument is mutated.

/**
 * Parse a duration string into `{ unit, remaining }`.
 *
 * Accepted forms, matching tracker.py's vocabulary and widening it slightly so a
 * DM does not have to remember which abbreviations exist:
 *
 *     "10r" "10 rounds"   -> { unit: 'rounds',  remaining: 10 }
 *     "60m" "10 minutes"  -> { unit: 'minutes', remaining: 60 }
 *     "8h"  "8 hours"     -> { unit: 'hours',   remaining: 8 }
 *     "indef" "permanent" -> { unit: 'indefinite', remaining: null }
 *
 * A bare number is NOT accepted. "10" could be ten rounds or ten minutes, and
 * guessing produces either a Bless that outlives the fight or a Hunter's Mark
 * that dies mid-round 鈥?a silent wrong answer, which is worse than a refusal.
 *
 * @param text - the caller's duration argument.
 * @returns `{ unit, remaining }`, or null when unreadable.
 */
export function parseDuration(text) {
  if (text === null || text === undefined) return null
  const raw = String(text).trim().toLowerCase().replace(/\s+/g, '')
  if (raw === '') return null
  if (['indef', 'indefinite', 'permanent', 'perm', 'inf'].includes(raw)) {
    return { unit: INDEFINITE, remaining: null }
  }
  for (const { suffix, unit } of UNIT_SUFFIXES) {
    if (!raw.endsWith(suffix)) continue
    const digits = raw.slice(0, raw.length - suffix.length)
    if (digits === '' || !/^[0-9]+$/.test(digits)) continue
    const remaining = parseInt(digits, 10)
    // A zero-length effect is not an effect. It would expire on the next tick
    // anyway, so refusing it here keeps "start" from reporting a success that is
    // really an immediate no-op.
    if (remaining <= 0) return null
    return { unit, remaining }
  }
  return null
}

/**
 * Render a duration for a human.
 * @param duration - `{ unit, remaining }`.
 * @returns e.g. `"3 rounds"`, `"60 minutes"`, `"indefinite"`.
 */
export function formatDuration(duration) {
  if (duration === null || duration === undefined) return 'unknown'
  const n = duration.remaining
  if (duration.unit === INDEFINITE || n === null || n === undefined) return 'indefinite'
  // Singular for exactly one: "1 rounds" reads like a bug in the tool, and a DM
  // quoting it back to the table notices.
  const label = n === 1 ? String(duration.unit).replace(/s$/, '') : duration.unit
  return `${n} ${label}`
}

/**
 * The remaining life of an effect, in seconds.
 * @param effect - `{ duration: { unit, remaining } }`.
 * @returns seconds, or Infinity for an indefinite effect.
 */
export function remainingSeconds(effect) {
  const duration = effect === null || effect === undefined ? undefined : effect.duration
  if (duration === null || duration === undefined) return Infinity
  if (duration.unit === INDEFINITE) return Infinity
  const per = UNIT_SECONDS[duration.unit]
  if (per === undefined) return Infinity
  const n = Number(duration.remaining)
  if (!Number.isFinite(n)) return Infinity
  return n * per
}

/**
 * Convert a tick's elapsed time into seconds.
 *
 * @param options - `{ rounds, minutes, hours, seconds }`; all optional.
 * @returns elapsed seconds (0 when nothing usable was asked for).
 */
export function elapsedSeconds(options) {
  const opts = options === null || options === undefined ? {} : options
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  return num(opts.rounds) * UNIT_SECONDS.rounds
    + num(opts.minutes) * UNIT_SECONDS.minutes
    + num(opts.hours) * UNIT_SECONDS.hours
    + num(opts.seconds) * UNIT_SECONDS.seconds
}

/**
 * Re-express a number of seconds in the largest unit that divides it EXACTLY,
 * falling back to seconds.
 *
 * The effect keeps the unit the DM declared for as long as that unit is still
 * exact: a 10-minute spell that lost one round becomes 594 seconds, and 594 is
 * not a whole number of minutes, so it is stored in seconds rather than rounded
 * to "9 minutes". Rounding is what would make the spell expire at a moment the
 * arithmetic does not justify.
 *
 * @param seconds - remaining seconds.
 * @param preferred - the unit the DM declared.
 * @returns `{ unit, remaining }`.
 */
export function secondsToDuration(seconds, preferred) {
  if (!Number.isFinite(seconds)) return { unit: INDEFINITE, remaining: null }
  if (seconds <= 0) {
    if (preferred === undefined || preferred === INDEFINITE) return { unit: INDEFINITE, remaining: null }
    return { unit: preferred, remaining: 0 }
  }
  if (preferred !== undefined && preferred !== INDEFINITE) {
    const per = UNIT_SECONDS[preferred]
    if (per !== undefined && seconds % per === 0) return { unit: preferred, remaining: seconds / per }
  }
  return { unit: 'seconds', remaining: seconds }
}

/**
 * Advance every effect by an elapsed time. PURE.
 *
 * This is the whole tick rule, and it is a pure function of its arguments: the
 * same `(effects, options)` always yields the same result, nothing is read from
 * a clock, and neither the input array nor its members are mutated.
 *
 * An effect that reaches zero is moved OUT of `remaining` and into `expired`;
 * it is never left in the list at `remaining: 0`, because "0 rounds left" is a
 * state every other reader would have to special-case.
 *
 * An indefinite effect is never decremented and never expires. It can still be
 * ended explicitly, and it can still be lost to a failed concentration save.
 *
 * @param effects - an array of effect objects.
 * @param options - `{ rounds, minutes, hours, seconds }`.
 * @returns `{ remaining, expired, elapsed, advanced }` 鈥?new arrays; the input
 *   is untouched. `advanced` is false when the elapsed time was zero, which is
 *   how a caller tells "ticked and nothing changed" from "ticked, nothing died".
 */
export function tickEffects(effects, options) {
  const list = Array.isArray(effects) ? effects : []
  const elapsed = elapsedSeconds(options)
  if (elapsed <= 0) {
    return { remaining: list.slice(), expired: [], elapsed: 0, advanced: false }
  }

  const remaining = []
  const expired = []
  for (const effect of list) {
    const before = remainingSeconds(effect)
    if (!Number.isFinite(before)) {
      // Indefinite. Copied rather than shared, so a caller cannot mutate the
      // input by editing what it got back.
      remaining.push({ ...effect })
      continue
    }
    const after = before - elapsed
    if (after <= 0) {
      expired.push({ ...effect, duration: { ...(effect.duration === undefined ? {} : effect.duration), remaining: 0 } })
      continue
    }
    remaining.push({
      ...effect,
      duration: secondsToDuration(after, effect.duration === undefined ? undefined : effect.duration.unit),
    })
  }
  return { remaining, expired, elapsed, advanced: true }
}

/**
 * The DC of the Constitution save forced by taking damage while concentrating.
 *
 * SRD 5.2: the DC is 10 or half the damage taken, whichever is higher.
 * `Math.floor` on the half 鈥?at 21 damage half is 10.5, and 10 is still the
 * higher of the two, so the DC stays 10 until 22 damage.
 *
 * @param damage - damage taken; a negative or unreadable value counts as 0.
 * @returns the DC.
 */
export function breakSaveDc(damage) {
  const n = Number(damage)
  const taken = Number.isFinite(n) && n > 0 ? n : 0
  return Math.max(10, Math.floor(taken / 2))
}

/**
 * Build a normalized effect object.
 * @param effectName - the spell or source, e.g. "Bless".
 * @param duration - a `parseDuration` result.
 * @param options - `{ concentration, note }`.
 */
export function makeEffect(effectName, duration, options) {
  const opts = options === null || options === undefined ? {} : options
  const note = opts.note === undefined || String(opts.note).trim() === '' ? undefined : String(opts.note).trim()
  return {
    name: String(effectName).trim(),
    duration: { unit: duration.unit, remaining: duration.remaining },
    concentration: opts.concentration === true,
    ...(note === undefined ? {} : { note }),
  }
}

/**
 * Match an effect by name, case-insensitively.
 *
 * Case-insensitive on purpose: a DM who started "Bless" and then ends "bless"
 * means the same spell, and a case-sensitive miss would report "no such effect"
 * while one is plainly running.
 */
export function effectMatches(effect, wanted) {
  const have = effect === null || effect === undefined ? '' : effect.name
  return String(have === undefined || have === null ? '' : have).toLowerCase()
    === String(wanted).trim().toLowerCase()
}

/**
 * The effect a concentration flag points at, if it is still running.
 * @param effects - the effect list.
 * @param concentration - the concentration section value.
 */
export function concentrationEffect(effects, concentration) {
  if (concentration === null || concentration === undefined) return undefined
  const spell = concentration.spell
  if (spell === undefined || spell === null || String(spell).trim() === '') return undefined
  return (Array.isArray(effects) ? effects : []).find((e) => effectMatches(e, spell))
}

/** Clamp a stored tally into 0..3, treating anything unreadable as 0. */
function clampCount(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(3, Math.trunc(n))
}

/**
 * The standing verdict for a tally.
 *
 * DEAD wins a tie. Three failures and three successes cannot both be reached in
 * a real game (the sequence ends at whichever lands first), but if a hand-edited
 * file holds both, "dead" is the answer that fails loudly rather than the one
 * that quietly revives a character.
 */
export function verdictFor(successes, failures) {
  if (clampCount(failures) >= 3) return 'dead'
  if (clampCount(successes) >= 3) return 'stable'
  return 'dying'
}

/**
 * Apply one death save result. PURE.
 *
 * SRD 5.2, "Death Saving Throws": three successes stabilise, three failures
 * kill, a natural 1 counts as TWO failures, and a natural 20 restores 1 hit
 * point. The nat 20 is modelled as an explicit `revived` verdict rather than
 * "one more success", because reporting a plain success to a player who just
 * rolled a 20 is a wrong answer 鈥?and leaving two failures on the sheet would
 * make the next reader act on a fight that is over.
 *
 * Both counts stop at 3. A fourth failure does not make anyone "more dead"; the
 * numbers are a tally towards a threshold, not a damage total.
 *
 * @param tally - `{ successes, failures }`.
 * @param outcome - `'success' | 'failure'`.
 * @param natural - the d20 result, when the caller has one (1 and 20 matter).
 * @returns `{ successes, failures, delta, verdict, regainsHp, notes }`.
 */
export function applyDeathSave(tally, outcome, natural) {
  const successes = clampCount(tally === null || tally === undefined ? 0 : tally.successes)
  const failures = clampCount(tally === null || tally === undefined ? 0 : tally.failures)
  const nat = Number(natural)
  const isNat1 = Number.isFinite(nat) && nat === 1
  const isNat20 = Number.isFinite(nat) && nat === 20
  const notes = []

  if (outcome !== 'success' && outcome !== 'failure') {
    return { successes, failures, delta: 0, verdict: verdictFor(successes, failures), regainsHp: false, notes }
  }

  if (outcome === 'success' && isNat20) {
    return {
      successes: 0,
      failures: 0,
      delta: 0,
      verdict: 'revived',
      regainsHp: true,
      notes: ['natural 20 鈥?the character regains 1 hit point and the tally is cleared'],
    }
  }

  let nextSuccesses = successes
  let nextFailures = failures

  if (outcome === 'success') {
    nextSuccesses = Math.min(3, successes + 1)
  } else {
    // A natural 1 is TWO failures. This is the rule most likely to be dropped,
    // so it is applied here in the pure function where a test can pin it.
    const delta = isNat1 ? 2 : 1
    nextFailures = Math.min(3, failures + delta)
    if (isNat1) {
      notes.push('natural 1 鈥?counts as TWO failures')
      // The cap can absorb one of the two. Saying so stops a DM reading "counts
      // as two" and concluding the tally is wrong when it shows 3.
      if (failures + delta > 3) notes.push('(capped at 3; ' + (3 - failures) + ' of the 2 were counted)')
    }
  }

  return {
    successes: nextSuccesses,
    failures: nextFailures,
    delta: outcome === 'success' ? nextSuccesses - successes : nextFailures - failures,
    verdict: verdictFor(nextSuccesses, nextFailures),
    regainsHp: false,
    notes,
  }
}

/** One sentence for a verdict, shared by the death-save tool and any reader. */
export function verdictSentence(characterName, verdict, tally) {
  const t = clampCount(tally === null || tally === undefined ? 0 : tally.successes)
    + ' success(es), ' + clampCount(tally === null || tally === undefined ? 0 : tally.failures) + ' failure(s)'
  if (verdict === 'dead') return characterName + ' is DEAD 鈥?three failed death saves. (' + t + ')'
  if (verdict === 'stable') return characterName + ' is STABLE 鈥?three successful death saves, unconscious but no longer dying. (' + t + ')'
  if (verdict === 'revived') return characterName + ' is back on their feet 鈥?natural 20 on the death save. (' + t + ')'
  return characterName + ' is dying. (' + t + ')'
}

// 鈹€鈹€鈹€ Shared plumbing 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/** Render a plain string result for the model. */
const renderText = (_args, value) => [{ type: 'text', text: String(value) }]

/**
 * The tail of each character's encounter write chain.
 *
 * The same reason track.mjs has one, and the same shape: a read-modify-write of
 * a shared file is not safe to interleave with itself. Two overlapping
 * `dnd_effect` calls that each read `{ effects: [] }` and each write their own
 * effect would lose one of them, and both would report success.
 *
 * It is a SEPARATE chain from track.mjs's `writeChains`, and that is deliberate
 * rather than an oversight: the two families write DIFFERENT files, so
 * serializing them against each other would make a hit-point change queue behind
 * an unrelated effect tick. The encounter file has exactly two writing
 * families 鈥?this one and T8's initiative tools 鈥?and BOTH take this chain.
 * Two chains would be two locks, and two locks provide no mutual exclusion at
 * all, which is the failure this function exists to prevent.
 *
 * @type {Map<string, Promise<unknown>>}
 */
const encounterChains = new Map()

/**
 * Run `work` with exclusive access to one character's encounter file.
 *
 * Exported so the initiative family shares this ONE chain rather than keeping a
 * second map.
 *
 * The whole read-modify-write must be inside `work`. Queuing only the write
 * would preserve the lost update, because the stale read happens first.
 *
 * @param key - lock key, `campaign/character` lowercased.
 * @param work - `() => Promise<T>`; the entire locate-read-mutate-write.
 * @template T
 */
export async function withEncounterLock(key, work) {
  const prior = encounterChains.get(key) ?? Promise.resolve()
  const run = prior.then(work, work)
  // The stored link must never reject, or one failed write would poison that
  // character's chain permanently.
  const link = run.then(() => undefined, () => undefined)
  encounterChains.set(key, link)
  try {
    return await run
  } finally {
    // Only clear the entry if nobody queued behind us; comparing identity is
    // what keeps a third caller from jumping the queue.
    if (encounterChains.get(key) === link) encounterChains.delete(key)
  }
}

/**
 * Locate a character for an encounter-scoped operation.
 *
 * Mirrors track.mjs's `locateCharacter` on purpose 鈥?the same substring match,
 * the same "omit the name when the campaign has one character" convenience, and
 * the same error wording 鈥?so a DM does not have to learn which tool addresses
 * characters differently.
 *
 * @param fs - the host fs service.
 * @param requested - the caller's `character` argument.
 * @returns `{ dir, campaign, name }` or `{ error }`.
 */
async function locateCharacter(fs, requested, session) {
  const located = await activeCampaignDir(fs, session)
  if (located === undefined) {
    return { error: 'No active campaign. Load one with /dm:dnd load <campaign> first.' }
  }
  const dir = located.dir + '/characters'
  const listed = await listCharacters(fs, dir)
  if (listed.length === 0) return { error: 'No characters in campaign ' + located.campaign + '.' }

  let name
  if (requested !== undefined && String(requested).trim() !== '') {
    const wanted = String(requested).toLowerCase().trim()
    const match = listed.find((c) => c.name.toLowerCase() === wanted)
      ?? listed.find((c) => c.name.toLowerCase().includes(wanted))
    if (match === undefined) {
      const available = listed.map((c) => c.name).join(', ')
      return { error: 'Character "' + requested + '" not found in ' + located.campaign + '. Available: ' + available }
    }
    name = match.name
  } else if (listed.length === 1) {
    name = listed[0].name
  } else {
    const available = listed.map((c) => c.name).join(', ')
    return { error: 'Which character? ' + located.campaign + ' has ' + listed.length + ': ' + available }
  }
  return { dir, campaign: located.campaign, name }
}

/** A section that should be an array of effects, made safe to iterate. */
function asEffectList(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((e) => e !== null && typeof e === 'object' && typeof e.name === 'string' && e.name.trim() !== '')
    .map((e) => ({
      ...e,
      duration: e.duration !== null && typeof e.duration === 'object'
        ? { unit: e.duration.unit, remaining: e.duration.remaining }
        : { unit: INDEFINITE, remaining: null },
      concentration: e.concentration === true,
    }))
}

/** A section that should be a concentration record, made safe to read. */
function asConcentration(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.spell !== 'string' || value.spell.trim() === '') return null
  return {
    spell: value.spell,
    ...(typeof value.since === 'string' ? { since: value.since } : {}),
  }
}

/** A section that should be a death-save tally, made safe to read. */
function asTally(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { successes: 0, failures: 0, verdict: 'dying' }
  }
  const successes = clampCount(value.successes)
  const failures = clampCount(value.failures)
  return { successes, failures, verdict: verdictFor(successes, failures) }
}

/**
 * Load the encounter sections this family reads, plus the character's sheet.
 *
 * Both are read inside the lock, so the snapshot a mutation is computed from
 * cannot be one another caller has already replaced.
 *
 * @param fs - the host fs service.
 * @param located - a `locateCharacter` result.
 */
async function loadSections(fs, located) {
  const read = await readEncounter(fs, located.dir, located.name)
  const sheet = await readCharacter(fs, located.dir, located.name)
  return {
    encounter: read.encounter,
    exists: read.exists,
    malformed: read.malformed,
    warnings: read.warnings,
    effects: asEffectList(sectionOf(read.encounter, EFFECTS_SECTION)),
    concentration: asConcentration(sectionOf(read.encounter, CONCENTRATION_SECTION)),
    deathSaves: asTally(sectionOf(read.encounter, ENCOUNTER_DEATH_SAVES_SECTION)),
    // Read inside the same lock as everything else, so the duplicate check and
    // the record that follows it cannot interleave with a concurrent call.
    appliedKeys: asKeyList(sectionOf(read.encounter, APPLIED_KEYS_SECTION)),
    sheet,
  }
}

/**
 * Persist the encounter sections this family owns, leaving every other section
 * exactly as it was found.
 *
 * The rule lives in `mergeEncounter` (encounter-io.mjs): the whole file is read,
 * only this family's keys are replaced, and the result written back. T8's
 * `initiative`/`turnOrder` therefore survive a tick, and a section a future
 * family adds survives too. This module deliberately does NOT use
 * `clearEncounterSection` 鈥?at the time of writing that helper hard-codes the
 * initiative section, and calling it here would overwrite the other family's
 * live turn order.
 *
 * @param fs - the host fs service.
 * @param located - a `locateCharacter` result.
 * @param loaded - a `loadSections` result.
 * @param sections - `{ effects, concentration, deathSaves }`; each optional.
 * @param sandboxPolicy - the calling session's resolved policy, or undefined.
 */
async function saveSections(fs, located, loaded, sections, sandboxPolicy) {
  let encounter = loaded.encounter
  if (sections.effects !== undefined) {
    encounter = mergeEncounter(encounter, EFFECTS_SECTION, sections.effects)
  }
  if (sections.concentration !== undefined) {
    // A concentration section is a record or null. Writing null rather than
    // deleting the key keeps the file's shape stable, so a reader never has to
    // distinguish "never concentrated" from "stopped concentrating".
    encounter = mergeEncounter(encounter, CONCENTRATION_SECTION, sections.concentration)
  }
  if (sections.deathSaves !== undefined) {
    encounter = mergeEncounter(encounter, ENCOUNTER_DEATH_SAVES_SECTION, sections.deathSaves)
  }
  if (sections.appliedKeys !== undefined) {
    encounter = mergeEncounter(encounter, APPLIED_KEYS_SECTION, sections.appliedKeys)
  }
  const written = await writeEncounter(fs, located.dir, located.name, encounter, sandboxPolicy)
  return written.path
}

/**
 * Mirror a death-save tally onto the character's own sheet.
 *
 * `combat.deathSaves` is a PRE-EXISTING field of the state schema
 * (NESTED_ORDER.combat) and its meaning is not changed here: it stays the
 * character-level value. The encounter file carries the encounter-level view so
 * a fight can be reset without editing the numbered sheet. Keeping the two in
 * step is what stops the panel rendering a stale count.
 *
 * A failure to write the sheet does not fail the tool. The encounter file is the
 * authority for the tally, and the caller reports the mirror's failure rather
 * than pretending the whole operation was lost.
 *
 * @returns `{ mirrored: boolean, reason?: string }`.
 */
async function mirrorTallyToSheet(fs, located, loaded, tally, sandboxPolicy, now) {
  const sheet = loaded.sheet
  if (sheet === null || sheet === undefined || sheet.state === null || sheet.state === undefined) {
    return { mirrored: false, reason: 'the character has no readable state file' }
  }
  const state = normalizeState(sheet.state)
  const before = state.combat?.deathSaves ?? {}
  if (before.successes === tally.successes && before.failures === tally.failures) {
    return { mirrored: true, reason: 'already in step' }
  }
  state.combat = { ...state.combat, deathSaves: { successes: tally.successes, failures: tally.failures } }
  const calendar = await readCalendar(fs, located.dir + '/..')
  const written = await withWriteDiagnosis(() => writeCharacter(fs, located.dir, located.name, {
    state,
    narrative: sheet.narrative,
    calendar,
    player: sheet.metadata?.player ?? null,
    campaign: located.campaign,
    tags: sheet.metadata?.tags ?? ['pc'],
    now,
    sandboxPolicy,
  }), { policy: sandboxPolicy, operation: 'character write', campaign: located.campaign })
  if (written.refused === true) return { mirrored: false, reason: written.reason }
  return { mirrored: true }
}

// --- The tools ---------------------------------------------------------------

/**
 * Build this family's tools.
 * @param ctx - host context; the fs service is optional and read lazily.
 * @returns an array of tool definitions.
 */
export function buildTools(ctx) {
  // Lazy, for the same reason as every other family: a mount that loses the
  // startup race must not capture undefined forever.
  const getFs = () => ctx.get('fs')

  /**
   * The sandbox policy each write is judged against, resolved from the calling
   * session. See session-scope.mjs for the full causal chain; omitting this is
   * what made every campaign write refusable while reads stayed healthy.
   */
  const policyFor = (exec) => writePolicyFor(ctx, exec)

  /**
   * Locate, read, mutate and save one character's encounter, under that
   * character's lock.
   *
   * The lock key is the RESOLVED stem, not the caller's argument, for the reason
   * recorded at length in track.mjs: "alice", "ali" and an omitted name are three
   * spellings of ONE character, and keying on the raw argument gave them three
   * independent chains that still lost updates.
   */
  async function withLockedCharacter(fs, requested, work, policy, exec) {
    // Resolution for the lock key happens OUTSIDE the lock: it reads only the
    // campaign marker and the directory listing, never a character's state.
    const located0 = await locateCharacter(fs, requested, sessionOf(ctx, exec))
    const raw = requested === undefined || requested === null ? '' : String(requested)
    const lockKey = located0.error !== undefined
      ? ('unresolved/' + raw).toLowerCase()
      : (located0.campaign + '/' + located0.name).toLowerCase()

    return withEncounterLock(lockKey, async () => {
      // Re-locate INSIDE the lock: every caller's read happens here, one at a
      // time, so each one sees the previous write's result.
      const located = await locateCharacter(fs, requested, sessionOf(ctx, exec))
      if (located.error !== undefined) return located.error
      const loaded = await loadSections(fs, located)
      return work(located, loaded, policy)
    })
  }

  /**
   * The idempotency check, run INSIDE the lock and BEFORE any mutation.
   *
   * Two properties matter and both are load-bearing:
   *
   *   - Before the mutation, not after. A duplicate discovered after the tally
   *     moved would have to be undone, and "undo a death save" is a repair no
   *     reader could verify.
   *   - Inside the lock. The ledger is read by `loadSections` under this
   *     character's chain, so two concurrent calls with the same key serialize:
   *     the second sees the first's record and stops. Checking outside would
     *     let both read an empty ledger and both apply.
   *
   * @param loaded - a `loadSections` result.
   * @param key - the caller's key, or null.
   * @param label - what to name in the duplicate message.
   * @returns a reply string when this call is a duplicate, else undefined.
   */
  const duplicateReply = (loaded, key, label) => {
    if (key === null || !loaded.appliedKeys.includes(key)) return undefined
    return 'Already applied (key "' + key + '"); nothing changed. No second ' + label + '.'
  }

  /** A one-line roster of what is running, appended to most replies. */
  const effectSummary = (effects, concentration) => {
    const list = Array.isArray(effects) ? effects : []
    if (list.length === 0) return '  No effects are running.'
    const parts = list.map((e) => e.name + ' (' + formatDuration(e.duration) + ')')
    const conc = concentration === null || concentration === undefined ? '' : '  concentrating: ' + concentration.spell
    return '  Running: ' + parts.join(', ') + '.' + conc
  }

  const effect = {
    name: 'dnd_effect',
    description:
      'Start, advance or end a TIMED EFFECT on a character (Bless 10 rounds, Hunter Mark 10 minutes, Mage Armor 8 hours, indefinite). '
      + 'Durations are "10r" rounds / "60m" minutes / "8h" hours / "indef"; a bare number is refused, because ten rounds and ten minutes are different spells. '
      + 'action "tick" advances the clock by the elapsed time you name and reports what expired; omit the character argument on a tick to advance the whole party at once. '
      + 'Effects live in the character encounter file, NOT on the character sheet. '
      + 'Use dnd_concentration for spell focus and dnd_death_save for death saves.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'What to do: "start" (default), "tick" (advance time), "end" (remove now), "list".',
          enum: ['start', 'tick', 'end', 'list'],
        },
        name: { type: 'string', description: 'Effect name, e.g. "Bless". Required for start and end.' },
        duration: { type: 'string', description: 'How long it lasts: "10r" rounds, "60m" minutes, "8h" hours, "indef". Required for start.' },
        character: { type: 'string', description: 'Character name or stem. Omit when the campaign has exactly one. Omit ENTIRELY on a tick to advance every character.' },
        concentration: { type: 'boolean', description: 'On start: this effect needs concentration (sets the concentration flag too).' },
        rounds: { type: 'integer', description: 'On tick: rounds elapsed. One round is 6 seconds, so this advances minute/hour effects too.' },
        minutes: { type: 'integer', description: 'On tick: minutes elapsed, e.g. 10 for a ten-minute search.' },
        hours: { type: 'integer', description: 'On tick: hours elapsed, e.g. 8 for a long rest.' },
        note: { type: 'string', description: 'On start: a short reminder stored with the effect, e.g. +1d4 to attack rolls.' },
        key: { type: 'string', description: 'Idempotency key. Repeating a call with the same key changes nothing the second time.' },
      },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'

      const rawAction = args.action === undefined || args.action === null ? '' : String(args.action).trim().toLowerCase()
      const action = rawAction === '' ? 'start' : rawAction
      if (!['start', 'tick', 'end', 'list'].includes(action)) {
        return 'dnd_effect: unknown action "' + args.action + '" - use start / tick / end / list. Nothing was written.'
      }

      // --- tick: the one action that is not about a single named effect ---
      if (action === 'tick') {
        // A tick with no elapsed time would write the file and change nothing,
        // stamping an encounter file onto a character who is not in a fight.
        if (elapsedSeconds(args) <= 0) {
          return 'dnd_effect tick needs an elapsed time: rounds, minutes or hours (e.g. rounds 1, or minutes 10). Nothing was written.'
        }
        return tickAction(fs, args, policyFor(exec), exec)
      }

      if (action === 'start' || action === 'end') {
        if (args.name === undefined || args.name === null || String(args.name).trim() === '') {
          return 'dnd_effect ' + action + ' needs a name argument, e.g. name "Bless". Nothing was written.'
        }
      }
      if (action === 'start' && (args.duration === undefined || args.duration === null || String(args.duration).trim() === '')) {
        return 'dnd_effect start needs a duration: "10r" rounds, "60m" minutes, "8h" hours, or "indef". Nothing was written.'
      }

      const policy = policyFor(exec)
      const key = requestKey(args)
      return withLockedCharacter(fs, args.character, async (located, loaded) => {
        if (action === 'list') {
          // A read, so it neither checks nor records a key.
          const head = located.name + ': ' + (loaded.effects.length === 0 ? 'no effects running.' : 'effects running.')
          return head + '\n' + effectSummary(loaded.effects, loaded.concentration)
        }

        const duplicate = duplicateReply(loaded, key, action === 'start' ? 'start' : 'end')
        if (duplicate !== undefined) return duplicate

        if (action === 'start') {
          const duration = parseDuration(args.duration)
          if (duration === null) {
            return 'dnd_effect could not read duration "' + args.duration
              + '". Use "10r" (rounds), "60m" (minutes), "8h" (hours) or "indef". Nothing was written.'
          }
          const wanted = String(args.name).trim()
          const existing = loaded.effects.find((e) => effectMatches(e, wanted))
          const fresh = makeEffect(wanted, duration, { concentration: args.concentration === true, note: args.note })
          // Same name REPLACES rather than stacks: two Blesses on one character
          // is a rules error, and stacking them would double the bonus in the
          // panel while both timers ran down separately.
          const effects = [...loaded.effects.filter((e) => !effectMatches(e, wanted)), fresh]

          const dropped = args.concentration === true && loaded.concentration !== null
            && !effectMatches({ name: loaded.concentration.spell }, wanted)
          const concentration = args.concentration === true
            ? { spell: fresh.name, since: new Date().toISOString() }
            : loaded.concentration

          await saveSections(fs, located, loaded, {
            effects,
            concentration,
            ...(key === null ? {} : { appliedKeys: withKeyRecorded(loaded.appliedKeys, key) }),
          }, policy)

          const lines = []
          const tag = fresh.concentration ? ' [concentration]' : ''
          lines.push(existing === undefined
            ? located.name + ': ' + fresh.name + ' - ' + formatDuration(fresh.duration) + tag
            : located.name + ': ' + fresh.name + ' RESTARTED - ' + formatDuration(fresh.duration) + ' (replaced the earlier one)')
          if (fresh.note !== undefined) lines.push('  note: ' + fresh.note)
          if (dropped) {
            lines.push('  concentration on "' + loaded.concentration.spell + '" ended - one spell at a time.')
          }
          lines.push(effectSummary(effects, concentration))
          return lines.join('\n')
        }

        // --- end ---
        const wanted = String(args.name).trim()
        const gone = loaded.effects.find((e) => effectMatches(e, wanted))
        if (gone === undefined) {
          const active = loaded.effects.map((e) => e.name).join(', ')
          return located.name + ' has no active effect "' + wanted + '". '
            + (active === '' ? 'No effects are running.' : 'Running: ' + active + '.')
        }
        const effects = loaded.effects.filter((e) => !effectMatches(e, wanted))
        // Ending the concentrating effect ends the concentration with it, and
        // both halves go in ONE save so a reader can never observe the effect
        // gone while the flag still points at it.
        const dropConc = gone.concentration && loaded.concentration !== null
          && effectMatches({ name: loaded.concentration.spell }, gone.name)
        const concentration = dropConc ? null : loaded.concentration
        await saveSections(fs, located, loaded, {
          effects,
          concentration,
          ...(key === null ? {} : { appliedKeys: withKeyRecorded(loaded.appliedKeys, key) }),
        }, policy)

        const lines = [located.name + ': ' + gone.name + ' ends' + (gone.concentration ? ' (concentration ends with it)' : '') + '.']
        lines.push(effectSummary(effects, concentration))
        return lines.join('\n')
      }, policy, exec)
    },
  }

  /**
   * The tick action.
   *
   * With a character argument it advances that character. WITHOUT one it
   * advances every character that has effects running - deliberately, because
   * "a round passed" is a statement about the table, not about one combatant,
   * and requiring one call per character is precisely the bookkeeping this tool
   * exists to remove.
   */
  async function tickAction(fs, args, policy, exec) {
    const key = requestKey(args)
    const named = args.character !== undefined && args.character !== null && String(args.character).trim() !== ''
    if (named) {
      return withLockedCharacter(fs, args.character, async (located, loaded) => {
        const duplicate = duplicateReply(loaded, key, 'tick')
        if (duplicate !== undefined) return duplicate
        const result = tickEffects(loaded.effects, args)
        const breakNow = concentrationBroken(result, loaded.concentration)
        await saveSections(fs, located, loaded, {
          effects: result.remaining,
          ...(breakNow === null ? {} : { concentration: null }),
          ...(key === null ? {} : { appliedKeys: withKeyRecorded(loaded.appliedKeys, key) }),
        }, policy)
        return renderTick(located.name, result, breakNow)
      }, policy, exec)
    }

    // Whole-party tick. Only characters that already have an encounter file with
    // effects take part: creating one here would mean a party tick materializes
    // an encounter for every character in the campaign, including ones who never
    // rolled anything.
    const found = await activeCampaignDir(fs, sessionOf(ctx, exec))
    if (found === undefined) {
      return 'No active campaign. Load one with /dm:dnd load <campaign> first.'
    }
    const dir = found.dir + '/characters'
    const listed = await listCharacters(fs, dir)
    if (listed.length === 0) return 'No characters in campaign ' + found.campaign + '.'

    const blocks = []
    for (const entry of listed) {
      const located0 = { dir, campaign: found.campaign, name: entry.name }
      const lockKey = (found.campaign + '/' + entry.name).toLowerCase()
      const block = await withEncounterLock(lockKey, async () => {
        const loaded = await loadSections(fs, located0)
        if (loaded.effects.length === 0) return null
        // A party tick applies to EVERY character independently, so the key is
        // checked and recorded per character. A character who already took this
        // key is skipped rather than reported: the party-wide call is a retry of
        // some characters and a first application to others, and re-ticking only
        // the ones that had not moved is exactly the intent of a retry.
        if (duplicateReply(loaded, key, 'tick') !== undefined) return null
        const result = tickEffects(loaded.effects, args)
        const breakNow = concentrationBroken(result, loaded.concentration)
        await saveSections(fs, located0, loaded, {
          effects: result.remaining,
          ...(breakNow === null ? {} : { concentration: null }),
          ...(key === null ? {} : { appliedKeys: withKeyRecorded(loaded.appliedKeys, key) }),
        }, policy)
        return renderTick(entry.name, result, breakNow)
      })
      if (block !== null) blocks.push(block)
    }
    if (blocks.length === 0) {
      return 'Advanced ' + describeElapsed(elapsedSeconds(args)) + ': no effects are running in ' + found.campaign + '.'
    }
    return blocks.join('\n')
  }

  /**
   * Whether this tick broke concentration.
   *
   * Concentration survives a tick UNLESS the effect it points at just expired.
   * That is the whole interaction: an effect ending is a fact about the fight,
   * and if it was the concentrating spell then focus is gone.
   *
   * @returns the expired effect that carried the concentration, or null.
   */
  function concentrationBroken(result, concentration) {
    if (concentration === null || concentration === undefined) return null
    const hit = result.expired.find((e) => effectMatches(e, concentration.spell))
    return hit === undefined ? null : hit
  }

  /** Format one character's tick result, announcing any break. */
  function renderTick(characterName, result, broke) {
    const lines = []
    const elapsed = describeElapsed(result.elapsed)
    for (const e of result.expired) {
      lines.push(characterName + ': ' + e.name + ' EXPIRED (after ' + elapsed + ')')
    }
    if (result.remaining.length > 0) {
      const parts = result.remaining.map((e) => e.name + ' (' + formatDuration(e.duration) + ')')
      lines.push(characterName + ' - ' + parts.join(', '))
    }
    if (broke !== null) {
      // The rules call for a save only when concentration is broken BY DAMAGE.
      // An expiry is not damage, so no DC is invented here - the line says what
      // happened and leaves the DM to decide whether anything else applies.
      lines.push('  ! concentration on ' + broke.name + ' ended - the spell is over.')
    } else if (result.expired.length === 0 && result.remaining.length === 0) {
      lines.push(characterName + ': nothing is running.')
    }
    return lines.join('\n')
  }

  const concentrationTool = {
    name: 'dnd_concentration',
    description:
      'Track spell CONCENTRATION for a character. '
      + 'action "start" establishes focus on a named spell; "break" ends it AND computes the Constitution save that 5e forces when a concentrating character takes damage (DC = max(10, half the damage) - SRD 5.2, "Concentration"); "end" ends it deliberately. '
      + 'Pass damage with "break" to get the DC and a ready-to-run dnd_save line; without damage the break is still recorded but no DC is invented. '
      + 'Concentration lives in the character encounter file. One spell at a time: establishing a new one drops the old.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'What to do: "start" (default), "break" (lost - forces a save when damage is given), "end" (deliberate), "status".',
          enum: ['start', 'break', 'end', 'status'],
        },
        spell: { type: 'string', description: 'The spell being concentrated on. Required for start.' },
        character: { type: 'string', description: 'Character name or stem. Omit when the campaign has exactly one.' },
        damage: { type: 'integer', description: 'On break: damage just taken, used for the CON save DC (max(10, half)).' },
        saveMod: { type: 'integer', description: 'On break: the character CON save modifier, so the reply can print a complete dnd_save call.' },
        key: { type: 'string', description: 'Idempotency key. Repeating a call with the same key changes nothing the second time.' },
      },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'

      const rawAction = args.action === undefined || args.action === null ? '' : String(args.action).trim().toLowerCase()
      const action = rawAction === '' ? 'start' : rawAction
      if (!['start', 'break', 'end', 'status'].includes(action)) {
        return 'dnd_concentration: unknown action "' + args.action + '" - use start / break / end / status. Nothing was written.'
      }
      if (action === 'start' && (args.spell === undefined || args.spell === null || String(args.spell).trim() === '')) {
        return 'dnd_concentration start needs a spell argument, e.g. spell "Bless". Nothing was written.'
      }

      const policy = policyFor(exec)
      const key = requestKey(args)
      return withLockedCharacter(fs, args.character, async (located, loaded) => {
        if (action === 'status') {
          // A read: no key check and nothing recorded.
          if (loaded.concentration === null) {
            return located.name + ' is not concentrating on anything.'
          }
          const running = concentrationEffect(loaded.effects, loaded.concentration)
          const left = running === undefined ? ' (no matching effect is running)' : ' (' + formatDuration(running.duration) + ' left)'
          return located.name + ' is concentrating on ' + loaded.concentration.spell + left + '.'
        }

        if (action === 'start') {
          // Checked here as well as on the break/end path below: the two are
          // separate branches, and a check placed only on the second would leave
          // a retried `start` rewriting the record with a fresh `since` stamp.
          const startDuplicate = duplicateReply(loaded, key, 'start')
          if (startDuplicate !== undefined) return startDuplicate

          const spell = String(args.spell).trim()
          const existing = loaded.effects.find((e) => effectMatches(e, spell))
          // Establishing concentration is enough on its own: the effect record
          // and the concentration flag are written together in ONE save, so a
          // reader can never see focus on a spell with no timer behind it.
          const marked = existing === undefined ? null : { ...existing, concentration: true }
          const effects = marked === null
            ? loaded.effects
            : [...loaded.effects.filter((e) => !effectMatches(e, spell)), marked]
          const prior = loaded.concentration !== null && !effectMatches({ name: loaded.concentration.spell }, spell)
          const concentration = { spell, since: new Date().toISOString() }
          await saveSections(fs, located, loaded, {
            effects,
            concentration,
            ...(key === null ? {} : { appliedKeys: withKeyRecorded(loaded.appliedKeys, key) }),
          }, policy)
          const lines = [located.name + ': concentrating on ' + spell + '.']
          if (prior) lines.push('  "' + loaded.concentration.spell + '" ended - one spell at a time.')
          if (existing === undefined) {
            lines.push('  (no timed effect matched, so there is no countdown; use dnd_effect start to add one.)')
          }
          return lines.join('\n')
        }

        // --- break / end ---
        const duplicate = duplicateReply(loaded, key, action === 'break' ? 'break' : 'end')
        if (duplicate !== undefined) return duplicate

        const was = loaded.concentration
        const damage = args.damage === undefined || args.damage === null ? null : Number(args.damage)
        const hasDamage = damage !== null && Number.isFinite(damage)

        // A break that names no spell breaks whatever is running. A break that
        // names one only breaks if that is the spell being concentrated on, so
        // a stale call cannot silently end focus on something else.
        if (action === 'break' && args.spell !== undefined && args.spell !== null && String(args.spell).trim() !== '') {
          if (was === null || !effectMatches({ name: was.spell }, String(args.spell).trim())) {
            const on = was === null ? 'nothing' : was.spell
            return located.name + ' is not concentrating on "' + args.spell + '" (currently: ' + on + '). Nothing was written.'
          }
        }

        if (was === null) {
          return located.name + ' was not concentrating, so nothing broke.'
        }

        // Breaking concentration also drops the concentration tag from the
        // effect, but the effect itself KEEPS running where the spell says so:
        // a Bless whose concentration broke still has its rounds on the clock.
        // Removing the timer too would quietly delete a fact the DM can use.
        const effects = loaded.effects.map((e) => (effectMatches(e, was.spell) ? { ...e, concentration: false } : e))
        await saveSections(fs, located, loaded, {
          effects,
          concentration: null,
          ...(key === null ? {} : { appliedKeys: withKeyRecorded(loaded.appliedKeys, key) }),
        }, policy)

        const verb = action === 'end' ? 'Concentration on ' : 'CONCENTRATION BROKEN on '
        const lines = [located.name + ': ' + verb + was.spell + (action === 'end' ? ' ended.' : '.')]
        if (action === 'break') {
          if (hasDamage) {
            const dc = breakSaveDc(damage)
            lines.push('  Damage taken: ' + Math.trunc(damage) + '. CON save DC ' + dc + ' = max(10, half the damage taken).')
            const mod = args.saveMod === undefined || args.saveMod === null ? null : Number(args.saveMod)
            if (mod !== null && Number.isFinite(mod)) {
              lines.push('  Roll it: dnd_save mod ' + Math.trunc(mod) + ', dc ' + dc + ', label "CON save (concentration)".')
              lines.push('  A FAILURE means the spell is finished. A SUCCESS means it held - but this record has already ended, so re-establish it with dnd_concentration start.')
            } else {
              lines.push('  Pass saveMod to get a ready-to-run dnd_save line.')
            }
          } else {
            lines.push('  No damage was given, so no CON save DC was computed - tell the DM to call dnd_save if the rules call for one.')
          }
        }
        return lines.join('\n')
      }, policy, exec)
    },
  }

  const deathSaveTool = {
    name: 'dnd_death_save',
    description:
      'Advance a dying character DEATH SAVING THROW tally and report the verdict. '
      + 'Three successes = STABLE, three failures = DEAD (SRD 5.2). A natural 1 counts as TWO failures; a natural 20 restores 1 hit point and clears the tally - pass natural when you rolled and it applies automatically. '
      + 'Writes the encounter tally in the character encounter file AND mirrors it onto the sheet combat.deathSaves field so the panel stays current. '
      + 'It does NOT auto-reset when hit points are restored - call action "reset" when the character is back up.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'What to do: "success", "failure", "reset" (back on your feet), or "status".',
          enum: ['success', 'failure', 'reset', 'status'],
        },
        character: { type: 'string', description: 'Character name or stem. Omit when the campaign has exactly one.' },
        natural: { type: 'integer', description: 'The d20 you rolled, when known: 1 counts as two failures, 20 restores 1 HP and clears the tally.' },
        key: { type: 'string', description: 'Idempotency key. Repeating a call with the same key changes nothing the second time.' },
      },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'

      const rawAction = args.action === undefined || args.action === null ? '' : String(args.action).trim().toLowerCase()
      const action = rawAction === '' ? 'status' : rawAction
      if (!['success', 'failure', 'reset', 'status'].includes(action)) {
        return 'dnd_death_save: unknown action "' + args.action + '" - use success / failure / reset / status. Nothing was written.'
      }

      const policy = policyFor(exec)
      const key = requestKey(args)
      const now = new Date()
      return withLockedCharacter(fs, args.character, async (located, loaded) => {
        const before = loaded.deathSaves
        if (action === 'status') {
          // A read: no key check and nothing recorded.
          return verdictSentence(located.name, verdictFor(before.successes, before.failures), before)
        }

        // THE dangerous duplicate. A retried `failure` that applied twice would
        // take a dying character to three failures and report DEAD, so this
        // check is deliberately the first thing the write path does.
        const duplicate = duplicateReply(loaded, key, action === 'reset' ? 'reset' : 'death save')
        if (duplicate !== undefined) return duplicate

        if (action === 'reset') {
          const tally = { successes: 0, failures: 0 }
          await saveSections(fs, located, loaded, {
            deathSaves: tally,
            ...(key === null ? {} : { appliedKeys: withKeyRecorded(loaded.appliedKeys, key) }),
          }, policy)
          const mirrored = await mirrorTallyToSheet(fs, located, loaded, tally, policy, now)
          const tail = mirrored.mirrored ? '' : ' (the sheet mirror did not update: ' + mirrored.reason + ')'
          return located.name + ': death saves reset - back on their feet.' + tail
        }

        const result = applyDeathSave(before, action, args.natural)
        const tally = { successes: result.successes, failures: result.failures }
        await saveSections(fs, located, loaded, {
          deathSaves: tally,
          ...(key === null ? {} : { appliedKeys: withKeyRecorded(loaded.appliedKeys, key) }),
        }, policy)
        const mirrored = await mirrorTallyToSheet(fs, located, loaded, tally, policy, now)

        const rolled = args.natural === undefined || args.natural === null ? '' : ' = ' + args.natural
        const moved = before.successes + '/' + before.failures + ' -> ' + result.successes + '/' + result.failures
        const lines = ['d20' + rolled + ': ' + action.toUpperCase() + ' - ' + moved]
        for (const note of result.notes) lines.push('  ' + note)
        lines.push('  ' + verdictSentence(located.name, result.verdict, tally))
        if (result.verdict === 'dead') {
          lines.push('  Three failed death saves: the character is DEAD. This is the rules verdict, not a suggestion - tell the table plainly.')
        }
        if (result.verdict === 'stable') {
          lines.push('  Three successful death saves: STABLE and unconscious at 0 HP. The tally stays until a reset or a healing effect wakes them.')
        }
        if (result.regainsHp) {
          lines.push('  Apply 1 hit point with dnd_track hp +1.')
        }
        if (!mirrored.mirrored) lines.push('  (sheet mirror not updated: ' + mirrored.reason + ')')
        return lines.join('\n')
      }, policy, exec)
    },
  }

  return [effect, concentrationTool, deathSaveTool]
}

/**
 * Describe an elapsed span for a human, in the largest whole unit.
 * Used by the tick report so eight hours does not render as 480 minutes.
 */
function describeElapsed(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'no time'
  if (seconds % UNIT_SECONDS.hours === 0) {
    const n = seconds / UNIT_SECONDS.hours
    return n + (n === 1 ? ' hour' : ' hours')
  }
  if (seconds % UNIT_SECONDS.minutes === 0) {
    const n = seconds / UNIT_SECONDS.minutes
    return n + (n === 1 ? ' minute' : ' minutes')
  }
  const n = Math.round(seconds / UNIT_SECONDS.rounds)
  return n + (n === 1 ? ' round' : ' rounds')
}
