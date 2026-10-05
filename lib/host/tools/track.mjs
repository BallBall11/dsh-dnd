/**
 * tools/track.mjs — the write tools.
 *
 *   dnd_track             change HP, temp HP, spell slots, spell lists, XP, conditions, resources
 *   dnd_spend             take coin out of the purse, refusing an unaffordable spend
 *   dnd_character_update  edit a character's NARRATIVE sections (Features & Traits, ...)
 *
 * ## Why these are separate from the read tools
 *
 * Everything in the read families is pure. These touch the disk, and one
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
 *
 * ## Concurrency: one write at a time, per character
 *
 * A read-modify-write is not safe to interleave with itself. Two calls that both
 * read HP 8 and then both write 8-3 lose one of the two hits of damage, and each
 * of them reports success — the table sees two hits land and the sheet records
 * one. Keyed idempotency does not help: two identical calls with DIFFERENT keys
 * (or no keys at all) are two legitimate changes, and no key comparison can tell
 * them from one change sent twice.
 *
 * The fix is `withCharacterLock`, which serializes the whole sequence — locate,
 * read, mutate, write — per `campaign/character`. The scope matters and is the
 * part that is easy to get wrong: it is NOT enough to serialize `applyChange`.
 * `locateCharacter` reads the state file, and it runs BEFORE `applyChange`, so
 * two calls can each capture the same stale snapshot and then take turns writing
 * it back. Serializing only the second half would leave the lost update intact
 * while looking like a fix.
 *
 * The lock is a promise chain in module scope, not a filesystem lock: DSH's host
 * is one process, and a chain is enough to make the read-then-write pairs queue
 * instead of overlap. Module scope rather than per-`buildTools` because a
 * re-mount must not hand out a second, independent chain. Nothing here blocks on
 * anything except other writes to the SAME character, so a slow write to one
 * character never delays another.
 *
 * Reads are unaffected: the lock lives in the write path, so `readCharacter` and
 * every read tool still never write and never queue.
 */

import { activeCampaignDir, readTextOrUndefined } from './shared.mjs'
import { applyDamage } from './apply-damage.mjs'
import { readCalendar } from './clock.mjs'
import { readCharacter, writeCharacter, listCharacters, statePath, sheetPath } from './state-io.mjs'
import { splitSheet, STRUCTURED_SECTIONS } from './sheet-split.mjs'
import { formatCurrency, formatCurrencyShort, toCopper, formatFindings } from './state-rules.mjs'
import { normalizeState, MAX_APPLIED_KEYS } from './state-schema.mjs'
import { sessionOf, writePolicyFor } from './session-scope.mjs'
import { withWriteDiagnosis } from './write-errors.mjs'
import { writeProbeState, runWriteSelfCheck } from './write-probe.mjs'

/**
 * Prepend the startup probe's warning to a write tool's output, when the probe
 * found the write path refused (T6).
 *
 * The warning goes on the tool's OWN output rather than only the log, because
 * the whole failure mode is that a DM does not look at the log: they see a
 * tool that answered, and assume it saved. Returning undefined from the probe
 * state (unit tests, no mount) shows nothing, which is the honest default.
 *
 * @param text - the tool's normal output.
 * @returns the output, with the advisory prepended when there is one.
 */
function withProbeAdvisory(text) {
  const note = writeProbeState()?.note()
  return note === undefined ? text : note + '\n\n' + text
}

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
/**
 * Apply a narrative-section operation to the parsed sheet and write the
 * character back through `writeCharacter`.
 *
 * The narrative is rebuilt from the section map the way `splitSheet` itself
 * does it (skip the generated block and structured sections, join raw), so the
 * untouched sections stay byte-identical and the generated block is re-rendered
 * from the authoritative state. A no-op (the section already reads exactly what
 * was passed) writes NOTHING: stamping both clocks on a character nothing
 * happened to is the same defect `dnd_track` refuses.
 *
 * @returns the model-facing text.
 */
async function applyCharacterNarrative(fs, dir, name, character, sheet, { op, body, text, match, created, index, sandboxPolicy }) {
  const sections = sheet.sections
  let note = ''
  let changed = false

  if (op === 'set-section') {
    const s = sections[index]
    const heading = '#'.repeat(s.level) + ' ' + s.heading
    const nextRaw = heading + '\n\n' + body.trim() + '\n'
    if (nextRaw === s.raw) {
      return 'No change: "' + s.heading + '" already contains exactly that content. Nothing was written.'
    }
    sections[index] = { ...s, raw: nextRaw, body: body.trim() }
    note = created
      ? 'Created section "' + s.heading + '" and wrote the content.'
      : 'Section "' + s.heading + '" replaced.'
    changed = true
  } else if (op === 'append') {
    const s = sections[index]
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    const nextRaw = s.raw.replace(/\n*$/, '\n') + lines.join('\n') + '\n'
    if (nextRaw === s.raw) {
      return 'No change: the appended text is already present verbatim at the end. Nothing was written.'
    }
    sections[index] = { ...s, raw: nextRaw, body: s.body.replace(/\n*$/, '\n') + lines.join('\n') }
    note = 'Appended ' + lines.length + ' line(s) to "' + s.heading + '".'
    changed = true
  } else if (op === 'remove') {
    const s = sections[index]
    const lines = s.raw.replace(/\n*$/, '').split('\n')
    const kept = lines.filter((l) => !l.includes(match))
    const dropped = lines.length - kept.length
    if (dropped === 0) {
      const sample = lines.slice(1, 6).join('\n')
      return 'No line in "' + s.heading + '" contains "' + match + '". '
        + (sample !== '' ? 'Section starts:\n' + sample : 'The section is empty.') + ' Nothing was written.'
    }
    sections[index] = { ...s, raw: kept.join('\n') + '\n', body: kept.slice(1).join('\n') }
    note = 'Removed ' + dropped + ' line(s) from "' + s.heading + '".'
    changed = true
  }

  if (!changed) return 'Nothing was written.'

  // Rebuild the narrative exactly as splitSheet assembles it: everything that
  // is neither the generated block nor a structured section, byte-for-byte.
  const isGenerated = (h) => h === 'generated' || h === '/dsh-dnd:generated'
  const structured = (h) => STRUCTURED_SECTIONS.some((x) => String(h).toLowerCase().startsWith(x))
  const narrative = sections
    .filter((s) => s.heading === null || (!isGenerated(s.heading) && !structured(s.heading)))
    .map((s) => s.raw)
    .join('\n')
    .trim()

  const calendar = await readCalendar(fs, dir)
  const result = await writeCharacter(fs, dir, name, {
    state: character.state,
    narrative,
    calendar,
    sandboxPolicy,
  })
  if (result.refused) {
    return 'dnd_character_update refused — ' + result.reason + ' Nothing was written.'
  }
  for (const line of result.warnings ?? []) note += '\n' + line
  return note + ' The generated summary was re-rendered from the state file; the numbers did not change.'
}

async function locateCharacter(fs, requested, session) {
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
async function withCharacterLock(key, work) {
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

/**
 * Build the write tools.
 * @param ctx - host context; `fs` is optional.
 * @returns an array of tool definitions.
 */
export function buildTools(ctx) {
  // Lazy, for the same reason as every other family: a mount that loses the
  // startup race must not capture undefined forever.
  const getFs = () => ctx.get('fs')

  /**
   * The sandbox policy each write is judged against, resolved from the session
   * that issued the call.
   *
   * This is the whole fix for "writes are refused while reads work": the tool's
   * `execute(args, exec)` receives the session on `exec.agent`, and passing
   * that session to `sandboxPolicy.resolve({ session })` is what puts the
   * SESSION's cwd in charge of the decision instead of the harness
   * process's cwd. See session-scope.mjs for the full causal chain and for why
   * a resolved-without-session policy does not work.
   *
   * Resolved per call, not cached at mount: a session's cwd is immutable but a
   * tool may be invoked with no agent at all (unit tests do exactly that), and
   * such a call must be re-evaluated rather than inherit a previous caller's
   * scope.
   *
   * @param exec - the `ToolRunContext`, or undefined.
   * @returns the policy, or undefined to keep the platform's fail-closed
   *   process-cwd fallback.
   */
  const policyFor = (exec) => writePolicyFor(ctx, exec)

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
        spells: { type: 'string', description: 'Spell-list change, e.g. "spellbook:+Fireball,prepared:-Mage Armor". Lists: cantrips, spellbook, prepared. "+" learns, "-" drops. This is how a character learns a new spell — editing the Known Spells section of the .md changes a copy nothing reads.' },
        xp: { type: 'string', description: 'XP change: "+250" to award, "-100" to remove, "=900" to set.' },
        currency: { type: 'string', description: 'Purse change: "+103 gp" credits loot or wages, "-5 gp" debits (refused if the purse would go negative), "=50 gp" sets. Same copper accounting as dnd_spend — this is how dnd_loot winnings enter the ledger.' },
        conditions: { type: 'string', description: 'Comma-separated conditions to add, or "none" to clear them all.' },
        removeConditions: { type: 'string', description: 'Comma-separated conditions to remove, e.g. "poisoned,prone".' },
        resource: { type: 'string', description: 'Name of a consumable to adjust, e.g. "Rations", "Arrows".' },
        resourceDelta: { type: 'string', description: 'Change for `resource`, e.g. "-1". Requires `resource`.' },
        reason: { type: 'string', description: 'Short note recorded in the returned summary, e.g. "goblin arrow".' },
      },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      // Checked before anything is located or read. Every field is optional
      // (a call may change only HP), so there is no `required` entry to rely
      // on — and an earlier version fell through to the write path, stamping
      // both clocks on a character it had not changed. A call that names no
      // change must not touch the disk.
      const CHANGE_FIELDS = ['hp', 'tempHp', 'spellSlots', 'spells', 'xp', 'currency', 'conditions', 'removeConditions', 'resource']
      const named = CHANGE_FIELDS.filter((f) => args[f] !== undefined && String(args[f]).trim() !== '')
      if (named.length === 0) {
        return 'dnd_track needs at least one of: hp, tempHp, spellSlots, spells, xp, currency, conditions, removeConditions, resource. '
          + 'Nothing was written.'
      }
      if (named.includes('resource') && (args.resourceDelta === undefined || String(args.resourceDelta).trim() === '')) {
        return 'dnd_track: `resource` needs a `resourceDelta`, e.g. resource "Rations" with resourceDelta "-1". '
          + 'Nothing was written.'
      }

      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'

      const changes = []
      // T6: the first real write triggers the self-check, using this call's own
      // session policy. It is detached so it can never delay or fail the write.
      const outcome = await locateAndApply(fs, args.character, (located, state) => {
        const refused = applyTrackChanges(state, args, changes)
        return refused
      }, {
        key: args.key,
        // Each write carries the calling session's policy. Omitting it is what
        // made every write refusable while reads stayed healthy.
        sandboxPolicy: policyFor(exec),
        session: sessionOf(ctx, exec),
        describe: (state, located) => describeTrack(located.name, changes, state, args.reason),
      })
      // Fired AFTER the write, so a refused write reports its own error first
      // and the advisory follows on the next call rather than masking it.
      void runWriteSelfCheck(ctx, { fs, policy: policyFor(exec), session: sessionOf(ctx, exec) }).catch(() => {})

      if (outcome.error !== undefined) return outcome.error
      return withProbeAdvisory(outcome.result.text)
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
    async execute(args, exec) {
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

      let report = null
      const outcome = await locateAndApply(fs, args.character, (located, state) => {
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
        sandboxPolicy: policyFor(exec),
        session: sessionOf(ctx, exec),
        describe: (state) => {
          const what = args.reason !== undefined ? ` (${args.reason})` : ''
          return `Spent ${formatCurrencyShort(report.cost)}${what}. `
            + `Purse: ${formatCurrencyShort(report.before)} -> ${formatCurrencyShort(report.after)} `
            + `(${formatCurrency(state.currency)}).`
        },
      })

      if (outcome.error !== undefined) return outcome.error
      return withProbeAdvisory(outcome.result.text)
    },
  }


  const characterUpdate = {
    name: 'dnd_character_update',
    description:
      "Edit a character's NARRATIVE prose: Features & Traits, Backstory & Notes, Character Pillar, "
      + 'Campaign History, or any other non-structured section of the sheet. The text you pass is '
      + 'carried VERBATIM — this is where freeform character writing goes. It REFUSES structured '
      + 'sections (Ability Scores, Combat Stats, Spell Slots, Known Spells, ...) because the state '
      + 'file is the authority there: numbers change through dnd_track (hp, spellSlots, spells, xp, '
      + 'conditions, resource), a card is built or rebuilt through dnd_character_create. It also '
      + 'refuses the generated summary block, which is re-rendered from the state on every write.',
    parameters: {
      type: 'object',
      properties: {
        character: { type: 'string', description: 'Character name or stem. Omit when the campaign has exactly one.' },
        op: { type: 'string', description: '"set-section" (replace the section body), "append" (add lines at the section end), or "remove" (drop lines matching `match`).' },
        section: { type: 'string', description: 'The heading, e.g. "Features & Traits". Case-insensitive exact match.' },
        body: { type: 'string', description: 'For op "set-section": the new section content, verbatim. Paragraphs and bullets are free.' },
        text: { type: 'string', description: 'For op "append": lines to add at the end of the section, verbatim.' },
        match: { type: 'string', description: 'For op "remove": every line containing this substring is removed.' },
        create: { type: 'boolean', description: 'With op "set-section": create the section when it does not exist. Default: refuse and list the existing headings.' },
      },
      required: ['op', 'section'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      // Argument validation BEFORE location, so a malformed call is diagnosed
      // as such rather than answered with a campaign error.
      const op = args.op === undefined || args.op === null ? '' : String(args.op).trim()
      const OPS = ['set-section', 'append', 'remove']
      if (!OPS.includes(op)) {
        return 'dnd_character_update needs `op`: one of ' + OPS.map((o) => '"' + o + '"').join(', ') + '. Nothing was written.'
      }
      const sectionName = args.section === undefined || args.section === null ? '' : String(args.section).trim()
      if (sectionName === '') {
        return 'dnd_character_update needs a `section` — the heading to edit, e.g. "Features & Traits". Nothing was written.'
      }
      const body = args.body === undefined || args.body === null ? '' : String(args.body)
      if (op === 'set-section' && body.trim() === '') {
        return 'dnd_character_update: op "set-section" needs `body` — the new section content. Nothing was written.'
      }
      const text = args.text === undefined || args.text === null ? '' : String(args.text)
      if (op === 'append' && text.trim() === '') {
        return 'dnd_character_update: op "append" needs `text` — the lines to add. Nothing was written.'
      }
      const match = args.match === undefined || args.match === null ? '' : String(args.match).trim()
      if (op === 'remove' && match === '') {
        return 'dnd_character_update: op "remove" needs `match` — the substring whose lines are removed. Nothing was written.'
      }

      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'
      const session = sessionOf(ctx, exec)
      // The narrative write goes through the SAME policy threading as every
      // other writer: without the session's resolved policy as writeText's 5th
      // argument, the sandbox judges the path against the process cwd and
      // refuses the session workspace (the defect that made 0.4.1's
      // dnd_character_update 100% unusable).
      const sandboxPolicy = writePolicyFor(ctx, exec)

      const outcome = await locateCharacter(fs, args.character, session)
      if (outcome.error !== undefined) return outcome.error
      const dir = outcome.dir
      const campaign = outcome.campaign
      const name = outcome.name
      const character = outcome.character

      // One writer at a time per character, same chain dnd_track uses: a
      // narrative edit racing a slot expenditure must compose, not clobber.
      return withCharacterLock(campaign + '/' + name, async () => {
        const sheetText = await readTextOrUndefined(fs, sheetPath(dir, name))
        if (sheetText === undefined) {
          return 'No sheet file for "' + name + '" in ' + campaign + ' (characters/' + name + '.md). Build one with dnd_character_create.'
        }
        const sheet = splitSheet(sheetText, { name })

        const structured = (h) => STRUCTURED_SECTIONS.some((s) => String(h).toLowerCase().startsWith(s))
        const isGenerated = (h) => h === 'generated' || h === '/dsh-dnd:generated'
        const wanted = sectionName.toLowerCase()
        const idx = sheet.sections.findIndex((s) => s.heading !== null && !isGenerated(s.heading) && s.heading.toLowerCase() === wanted)

        // The gate. A structured hit is a refusal WITH DIRECTIONS, because the
        // request is legitimate — the route is just not this tool. Editing the
        // .md copy of a structured section changes prose that nothing reads:
        // the state file decides every number, and the summary re-renders from
        // it. Both refusals below name the tool that does own the change.
        if (idx === -1) {
          // The sheet was born through writeCharacter, so its structured
          // sections have MOVED to the state file and are no longer headings
          // here. The gate must therefore also recognise a structured NAME
          // directly — "Combat Stats" is still not this tool's business.
          const structuredHit = structured(sectionName)
            || sheet.sections.some((s) => s.heading !== null && !isGenerated(s.heading)
              && structured(s.heading)
              && (String(s.heading).toLowerCase().includes(wanted) || wanted.includes(String(s.heading).toLowerCase())))
          if (structuredHit) {
            return 'REFUSED: "' + sectionName + '" is a STRUCTURED section — the state file is the authority, and editing the sheet copy changes text nothing reads. '
              + 'Numbers: dnd_track (hp, tempHp, spellSlots, spells, xp, conditions, resource) or dnd_spend. '
              + 'Building or rebuilding the card: dnd_character_create. Nothing was written.'
          }
          const narrativeHeads = sheet.sections
            .filter((s) => s.heading !== null && !isGenerated(s.heading) && !structured(s.heading))
            .map((s) => s.heading)
          if (args.create === true && op === 'set-section') {
            sheet.sections.push({ heading: sectionName, level: 2, body: '', raw: '## ' + sectionName + '\n' })
            return await applyCharacterNarrative(fs, dir, name, character, sheet, {
              op, body, text, match, created: true, index: sheet.sections.length - 1, sandboxPolicy,
            })
          }
          return 'No section "' + sectionName + '" in ' + name + '. Narrative sections: ' + (narrativeHeads.join('; ') || 'none') + '. '
            + 'Pass create:true with op "set-section" to add a new one. Nothing was written.'
        }
        if (structured(sheet.sections[idx].heading)) {
          return 'REFUSED: "' + sheet.sections[idx].heading + '" is a STRUCTURED section — the state file is the authority, and editing the sheet copy changes text nothing reads. '
            + 'Numbers: dnd_track (hp, tempHp, spellSlots, spells, xp, conditions, resource) or dnd_spend. '
            + 'Building or rebuilding the card: dnd_character_create. Nothing was written.'
        }

        return await applyCharacterNarrative(fs, dir, name, character, sheet, {
          op, body, text, match, created: false, index: idx, sandboxPolicy,
        })
      })
    },
  }

  return [track, spend, characterUpdate]
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
    if (op.mode === 'add' && op.value < 0) {
      // Damage goes through the shared landing rules: temporary HP absorbs
      // first, the remainder reaches hp.current. Before this funneled through
      // applyDamage, temp HP sat unspent while the real pool drained — a
      // character silently tougher than the rules allow.
      const landed = applyDamage(state.combat, -op.value)
      if (landed.error !== undefined) return { refuse: `dnd_track: ${landed.error}. Nothing was written.` }
      state.combat = landed.combat
      const overflow = landed.overflow
      const instantDeath = max !== null && overflow >= max
      changes.push(`Damage ${-op.value} landed${landed.absorbed > 0 ? ` (temp HP absorbed ${landed.absorbed})` : ''}: `
        + `HP ${current} -> ${landed.combat.hp.current}. `
        + `0 is the floor${landed.combat.hp.current === 0 ? ', and the character is dying' : ''}. `
        + `Overflow damage: ${overflow}`
        + (max !== null
          ? instantDeath ? ` >= HP max ${max} — INSTANT DEATH by the massive-damage rule`
            : ` < HP max ${max}, no massive-damage death`
          : ''))
      touched.push('hp')
    } else if (next < 0) {
      return { refuse: `dnd_track: setting HP to ${next} would go below the floor of 0. Nothing was written.` }
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
    // Level progress rides along: the threshold is the stored `xpNext`, so a
    // sheet without one simply gets no progress line rather than an invented
    // default. Leveling UP stays a separate, explicit decision.
    const xpNext = numOrNull(state.identity?.xpNext)
    if (xpNext !== null && xpNext !== undefined) {
      const remaining = xpNext - next
      changes.push(remaining > 0
        ? `${remaining} XP until level ${numOr(state.identity?.level, 1) + 1} (at ${xpNext})`
        : `Ready to advance to level ${numOr(state.identity?.level, 1) + 1} at ${xpNext} XP — level up is a separate, explicit step.`)
    }
    state.identity = { ...state.identity, xp: next }
    touched.push('xp')
  }

  if (args.spells !== undefined && String(args.spells).trim() !== '') {
    // Learning and forgetting spells is a STRUCTURED change: the three lists
    // live in the authoritative state file, and the sheet's generated block
    // re-renders from it. This is why there is no hand-written route — editing
    // the Known Spells section of the .md would change a copy nothing reads.
    for (const part of splitList(String(args.spells))) {
      const m = part.match(/^(cantrips|spellbook|prepared)\s*:\s*([+-])\s*(.+)$/i)
      if (m === null) {
        return {
          refuse: `dnd_track could not read spells entry "${part}". `
            + 'Use "spellbook:+Fireball" to learn, "prepared:-Mage Armor" to drop; '
            + 'lists are cantrips, spellbook, prepared. Nothing was written.',
        }
      }
      const listName = m[1].toLowerCase()
      const learning = m[2] === '+'
      const spell = m[3].trim()
      const spells = { ...(state.spells ?? {}) }
      const current = Array.isArray(spells[listName]) ? [...spells[listName]] : []
      const hit = current.findIndex((s) => String(s).toLowerCase() === spell.toLowerCase())
      if (learning && hit !== -1) {
        return { refuse: `REFUSED: ${state.name ?? 'the character'} already knows ${spell} (${listName}). Nothing was written.` }
      }
      if (!learning && hit === -1) {
        return { refuse: `REFUSED: ${state.name ?? 'the character'} does not know ${spell} (${listName}). Nothing was written.` }
      }
      if (learning) current.push(spell)
      else current.splice(hit, 1)
      // Other lists — including extra ones the sheet grew later — are kept.
      spells[listName] = current
      state.spells = spells
      changes.push(learning ? `Spell learned: ${spell} (${listName})` : `Spell dropped: ${spell} (${listName})`)
      touched.push('spells')
    }
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

  if (args.currency !== undefined && String(args.currency).trim() !== '') {
    // Credit or debit the purse: the write half of dnd_spend, so loot,
    // wages and rewards have a route INTO the ledger. Same total-copper
    // accounting; a debit below zero is refused rather than recorded as debt.
    const raw = String(args.currency).trim()
    const m = raw.match(/^([+-]|=)\s*(.+)$/)
    if (m === null) {
      return { refuse: `dnd_track could not read currency "${raw}". Use "+103 gp" to credit, "-5 gp" to debit, "=50 gp" to set. Nothing was written.` }
    }
    const amount = toCopper(m[2])
    if (!Number.isFinite(amount) || amount < 0) {
      return { refuse: `dnd_track could not read currency amount "${m[2]}" as a copper total. Nothing was written.` }
    }
    const before = numOr(state.currency, 0)
    let after
    if (m[1] === '=') after = amount
    else if (m[1] === '+') after = before + amount
    else {
      after = before - amount
      if (after < 0) {
        return { refuse: `REFUSED: ${state.name ?? 'the character'} has ${formatCurrency(before)}, which does not cover ${formatCurrencyShort(amount)}. Short by ${formatCurrencyShort(before - amount)}. Nothing was written.` }
      }
    }
    changes.push(`Purse ${formatCurrency(before)} -> ${formatCurrency(after)}`)
    state.currency = after
    touched.push('currency')
  }

  if (args.resource !== undefined && String(args.resource).trim() !== '') {
    // The `resourceDelta` presence check lives in dnd_track.execute, which
    // refuses before anything is read. This is the backstop for a direct
    // caller of this function.
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
    // Unreachable through dnd_track.execute, which refuses an empty call
    // before reading anything. Kept as the backstop for a direct caller of
    // this function: silently returning "no changes" and letting the write
    // proceed would stamp both clocks on a character nothing happened to.
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
