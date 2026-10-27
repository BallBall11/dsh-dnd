/**
 * tools/write-pipeline.mjs — the one seam every character write enters.
 *
 * A character write is not `writeCharacter` alone. Six invariants make it a
 * legal write, and this module owns all six so no tool has to remember them:
 *
 *   1. RESOLUTION     `locateCharacter` — exact match, then substring, then
 *                     the sole character; one resolver for every family.
 *   2. LOCKING        one write at a time per `campaign/character`, keyed on
 *                     the RESOLVED stem, with the whole read-modify-write
 *                     inside the lock (`withCharacterLock`).
 *   3. IDEMPOTENCY    a caller key makes a repeated call a reported no-op
 *                     (`applyChange`); no key means every call applies.
 *   4. BOTH CLOCKS    `writeOptions` fetches the campaign calendar, so every
 *                     write stamps `updated` AND `worldTime` — one path
 *                     computation, not one per tool.
 *   5. REFUSAL        sandbox denials are translated by `withWriteDiagnosis`
 *                     here, identically for every tool.
 *   6. SESSION SCOPE  the sandbox policy travels from the calling session
 *                     into each writeText's fifth argument (ADR-0006);
 *                     `undefined` degrades to refused, never widened.
 *
 * The pipeline is deep on purpose: a caller passes a request and a `mutate`
 * function and gets resolution, locking, idempotency, clocks and refusal
 * reporting behind the seam. Tools stay thin argument parsers; the rules
 * arithmetic lives in the pure modules (apply-damage, rest-rules, levelup)
 * and flows through `mutate`.
 *
 * One seam, one place to test: the concurrency scenario and the write-clocks
 * suite pin their invariants HERE, so a defect in any of the six surfaces at
 * one interface instead of hiding in a per-tool reimplementation. This module
 * carries no tool definitions of its own — the tools live in their families
 * (track, rest, levelup, roll, effects) and enter through `locateAndApply`.
 */

import { activeCampaignDir } from './shared.mjs'
import { readCalendar } from './clock.mjs'
import { readCharacter, writeCharacter, listCharacters } from './state-io.mjs'
import { formatFindings } from './state-rules.mjs'
import { normalizeState, MAX_APPLIED_KEYS } from './state-schema.mjs'
import { withWriteDiagnosis } from './write-errors.mjs'

/**
 * Resolve the character a write tool should act on.
 *
 * @param fs - the host fs service.
 * @param requested - the caller's `character` argument, possibly undefined.
 * @returns `{ dir, campaign, name, character }` or `{ error }`.
 */
export async function locateCharacter(fs, requested, session) {
  const located = await activeCampaignDir(fs, session)
  if (located?.error !== undefined) return { error: located.error }
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
 * @param options - `{ key }` for idempotency, an optional `now`, and
 *   `sandboxPolicy` (the calling session's resolved policy; see state-io.mjs
 *   and session-scope.mjs for why the write path needs it and the read path
 *   must not have it).
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

  // The refusal is translated here rather than at each tool, so all three write
  // tools report a sandbox denial identically (T7). The original error survives
  // as `cause`.
  const written = await withWriteDiagnosis(async () => writeCharacter(fs, located.dir, located.name, {
    state,
    narrative: located.character.narrative,
    ...(await writeOptions(fs, located)),
    now: options.now ?? new Date(),
    sandboxPolicy: options.sandboxPolicy,
  }), { policy: options.sandboxPolicy, operation: 'character write', campaign: located.campaign })

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
 * The tail of each character's write chain.
 *
 * Keyed by `campaign/character`, lowercased so two spellings of one name cannot
 * take two different locks. An entry is removed once its chain drains, so this
 * map does not grow with the number of characters a campaign has ever seen.
 *
 * @type {Map<string, Promise<unknown>>}
 */
const writeChains = new Map()

/**
 * Run `work` with exclusive access to one character.
 *
 * The whole read-modify-write must be inside `work`. Queuing only the write
 * would preserve the lost update, because the stale read happens first.
 *
 * The returned promise always settles the way `work` settles. The chain entry
 * stores a version of the promise that cannot reject, because a rejected link
 * left in the map would make every later write to that character reject too —
 * one failed write would poison the character permanently.
 *
 * @param key - the lock key, e.g. `stage2-test/alice`.
 * @param work - `() => Promise<T>`; the entire locate-read-mutate-write.
 * @returns the result of `work`.
 * @template T
 */
export async function withCharacterLock(key, work) {
  const prior = writeChains.get(key) ?? Promise.resolve()

  // Queue behind the previous holder, whatever it did. `.catch` on the PRIOR
  // link (not on `work`) is what keeps one rejection from breaking the chain.
  const run = prior.then(work, work)

  // The chain link: settles only when `run` does, and never rejects.
  const link = run.then(() => undefined, () => undefined)
  writeChains.set(key, link)

  try {
    return await run
  } finally {
    // Drop the entry only if nobody queued behind us while we ran. Comparing
    // identity is what makes this safe: a later caller has already replaced the
    // map entry, and deleting it here would let a third caller jump the queue.
    if (writeChains.get(key) === link) writeChains.delete(key)
  }
}

/**
 * Locate a character and apply a change under that character's lock.
 *
 * Both halves are inside the lock, and that is the point: the read in
 * `locateCharacter` has to be serialized with the write in `applyChange`, or two
 * callers capture the same snapshot and the second write discards the first.
 *
 * ## Why the lock is keyed on the RESOLVED character, not the request
 *
 * `locateCharacter` accepts a substring, and omitting the name is allowed when
 * the campaign has exactly one character. So `"alice"`, `"ali"` and an omitted
 * name are three spellings of ONE character. Keying the lock on the caller's raw
 * argument gave those three three different chains, and concurrent calls that
 * spelled the character differently still lost an update — measured, with the
 * lock in place:
 *
 *     "alice" vs "ali"      -> hp 5   (two hits, should be 2)
 *     "alice" vs omitted    -> hp 5
 *     "ALICE" vs "alice"    -> hp 2   (lowercasing hid the bug for case only)
 *
 * So the character is resolved to a stem FIRST, and the lock is keyed on
 * `campaign/stem`. Resolution itself is safe to do outside the lock because it
 * reads only the campaign marker and the directory listing — never a
 * character's state — and a write rewrites a sheet's contents without ever
 * renaming it. The stem a name resolves to therefore cannot change underneath a
 * concurrent write, so two callers resolving the same character agree on the
 * key. The STATE read, which is the one that must be serialized, stays inside.
 *
 * @param fs - the host fs service.
 * @param requested - the caller's `character` argument.
 * @param mutate - `(located, state) => undefined | { refuse }`. Receives the
 *   located character so a refusal message can name the sheet stem (`alice`).
 * @param options - `{ key, describe, sandboxPolicy }`, as `applyChange`
 *   takes. `describe` is called with `(state, located)`.
 * @returns `{ result }` or `{ error }`.
 */
export async function locateAndApply(fs, requested, mutate, options = {}) {
  // Resolve the character to a stem OUTSIDE the lock, purely to build a stable
  // key. This is a directory-level read, not a state read.
  const located0 = await locateCharacter(fs, requested, options.session)
  const lockKey = located0.error !== undefined
    // Nothing resolved: fall back to the raw request so that a repeated failing
    // call still queues with itself rather than racing on the campaign marker.
    ? `unresolved/${String(requested ?? '')}`.toLowerCase()
    : `${located0.campaign}/${located0.name}`.toLowerCase()

  return withCharacterLock(lockKey, async () => {
    // Re-locate INSIDE the lock. Every caller's state read happens here, one at
    // a time, so each one sees the previous write's result.
    const located = await locateCharacter(fs, requested, options.session)
    if (located.error !== undefined) return { error: located.error }

    const describe = options.describe
    const result = await applyChange(fs, located, (state) => mutate(located, state), {
      ...options,
      describe: describe === undefined ? undefined : (state) => describe(state, located),
    })
    return { located, result }
  })
}
