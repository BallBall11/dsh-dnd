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
 * The serialization lives in the pipeline (`applyToCharacter`): it keys the lock
 * on the RESOLVED `campaign/character` stem and holds the whole sequence —
 * locate, read, mutate, write — inside it. The scope matters and is the part
 * that is easy to get wrong: it is NOT enough to serialize the write half.
 * `locateCharacter` reads the state file, and it runs BEFORE the write, so two
 * calls can each capture the same stale snapshot and then take turns writing
 * it back. Serializing only the second half would leave the lost update intact
 * while looking like a fix.
 *
 * The lock is a promise chain in the pipeline's module scope, not a filesystem
 * lock: DSH's host is one process, and a chain is enough to make the
 * read-then-write pairs queue instead of overlap. Module scope rather than
 * per-`buildTools` because a re-mount must not hand out a second, independent
 * chain. Nothing here blocks on anything except other writes to the SAME
 * character, so a slow write to one character never delays another.
 *
 * Reads are unaffected: the lock lives in the write path, so `readCharacter` and
 * every read tool still never write and never queue.
 *
 * ## The narrative path is a mutate, not its own writer
 *
 * `dnd_character_update` enters the SAME seam. Its execute builds an async
 * mutate that re-reads the sheet INSIDE the lock (`readTextOrUndefined` +
 * `splitSheet` — reads never queue), runs the structured-section gate and the
 * section edit, and returns `{ narrative, note }`: the prose the pipeline
 * should write and the text to report. The pipeline owns the calendar fetch,
 * the lock, the session-policy threading, the refusal diagnosis and the probe
 * advisory; a no-op edit is a refusal whose text says nothing was written, so
 * the clocks never move for a change that did not happen. The narrative path
 * carries no idempotency key — a repeated identical edit is refused by
 * content, not by key.
 */

import { readTextOrUndefined } from './shared.mjs'
import { applyToCharacter } from './write-pipeline.mjs'
import { applyDamage } from './apply-damage.mjs'
import { sheetPath } from './state-io.mjs'
import { splitSheet, STRUCTURED_SECTIONS } from './sheet-split.mjs'
import { formatCurrency, formatCurrencyShort, toCopper } from './state-rules.mjs'
import { MAX_APPLIED_KEYS } from './state-schema.mjs'
import { sessionOf, writePolicyFor } from './session-scope.mjs'
import { runWriteSelfCheck } from './write-probe.mjs'

export const name = 'dnd-track'

// Re-exported so callers can reason about the cap without importing the schema.
export { MAX_APPLIED_KEYS }

/** Render a plain string result for the model. */
const renderText = (_args, value) => [{ type: 'text', text: String(value) }]

/**
 * The structured-section gate plus the section edit, computed against the
 * parsed sheet. PURE: sheet text already split, plan out — no reads, no
 * writes, no clock.
 *
 * The gate comes FIRST: a structured section is a refusal WITH DIRECTIONS,
 * because the request is legitimate — the route is just not this tool.
 * Editing the .md copy of a structured section changes prose that nothing
 * reads: the state file decides every number, and the summary re-renders from
 * it. Both refusals below name the tool that does own the change.
 *
 * @param sheet - the `splitSheet` result for the character's .md.
 * @param request - `{ name, campaign, op, section, body, text, match, create }`,
 *   the validated tool arguments plus the located names for error wording.
 * @returns `{ refuse }` when nothing may be written (a structured-section hit,
 *   an unknown section, or a no-op edit — the text explains why), or
 *   `{ narrative, note }`: the rebuilt narrative the pipeline should write and
 *   the default result text to report.
 */
function planNarrativeEdit(sheet, { name, campaign, op, section: sectionName, body, text, match, create }) {
  const sections = sheet.sections
  const structured = (h) => STRUCTURED_SECTIONS.some((s) => String(h).toLowerCase().startsWith(s))
  const isGenerated = (h) => h === 'generated' || h === '/dsh-dnd:generated'
  const wanted = sectionName.toLowerCase()
  const idx = sections.findIndex((s) => s.heading !== null && !isGenerated(s.heading) && s.heading.toLowerCase() === wanted)

  if (idx === -1) {
    // The sheet was born through writeCharacter, so its structured sections
    // have MOVED to the state file and are no longer headings here. The gate
    // must therefore also recognise a structured NAME directly — "Combat
    // Stats" is still not this tool's business.
    const structuredHit = structured(sectionName)
      || sections.some((s) => s.heading !== null && !isGenerated(s.heading)
        && structured(s.heading)
        && (String(s.heading).toLowerCase().includes(wanted) || wanted.includes(String(s.heading).toLowerCase())))
    if (structuredHit) {
      return { refuse: 'REFUSED: "' + sectionName + '" is a STRUCTURED section — the state file is the authority, and editing the sheet copy changes text nothing reads. '
        + 'Numbers: dnd_track (hp, tempHp, spellSlots, spells, xp, conditions, resource) or dnd_spend. '
        + 'Building or rebuilding the card: dnd_character_create. Nothing was written.' }
    }
    const narrativeHeads = sections
      .filter((s) => s.heading !== null && !isGenerated(s.heading) && !structured(s.heading))
      .map((s) => s.heading)
    if (create && op === 'set-section') {
      sections.push({ heading: sectionName, level: 2, body: '', raw: '## ' + sectionName + '\n' })
      return applySectionOp(sections, sections.length - 1, { op, body, text, match, created: true })
    }
    return { refuse: 'No section "' + sectionName + '" in ' + name + '. Narrative sections: '
      + (narrativeHeads.join('; ') || 'none') + '. '
      + 'Pass create:true with op "set-section" to add a new one. Nothing was written.' }
  }
  if (structured(sections[idx].heading)) {
    return { refuse: 'REFUSED: "' + sections[idx].heading + '" is a STRUCTURED section — the state file is the authority, and editing the sheet copy changes text nothing reads. '
      + 'Numbers: dnd_track (hp, tempHp, spellSlots, spells, xp, conditions, resource) or dnd_spend. '
      + 'Building or rebuilding the card: dnd_character_create. Nothing was written.' }
  }
  return applySectionOp(sections, idx, { op, body, text, match, created: false })
}

/**
 * Apply one section op to the sheet's sections and rebuild the narrative from
 * them. The narrative is rebuilt exactly as `splitSheet` assembles it
 * (everything that is neither the generated block nor a structured section,
 * joined raw), so the untouched sections stay byte-identical and the
 * generated block is re-rendered from the authoritative state.
 *
 * A no-op (the section already reads exactly what was passed) is a REFUSAL:
 * stamping both clocks on a character nothing happened to is the same defect
 * `dnd_track` refuses, and "nothing was written" is said in as many words.
 *
 * @returns `{ refuse }` for a no-op, or `{ narrative, note }` for an edit.
 */
function applySectionOp(sections, index, { op, body, text, match, created }) {
  const section = sections[index]
  let note = ''

  if (op === 'set-section') {
    const heading = '#'.repeat(section.level) + ' ' + section.heading
    const nextRaw = heading + '\n\n' + body.trim() + '\n'
    if (nextRaw === section.raw) {
      return { refuse: 'No change: "' + section.heading + '" already contains exactly that content. Nothing was written.' }
    }
    sections[index] = { ...section, raw: nextRaw, body: body.trim() }
    note = created
      ? 'Created section "' + section.heading + '" and wrote the content.'
      : 'Section "' + section.heading + '" replaced.'
  } else if (op === 'append') {
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    const nextRaw = section.raw.replace(/\n*$/, '\n') + lines.join('\n') + '\n'
    if (nextRaw === section.raw) {
      return { refuse: 'No change: the appended text is already present verbatim at the end. Nothing was written.' }
    }
    sections[index] = { ...section, raw: nextRaw, body: section.body.replace(/\n*$/, '\n') + lines.join('\n') }
    note = 'Appended ' + lines.length + ' line(s) to "' + section.heading + '".'
  } else if (op === 'remove') {
    const lines = section.raw.replace(/\n*$/, '').split('\n')
    const kept = lines.filter((l) => !l.includes(match))
    const dropped = lines.length - kept.length
    if (dropped === 0) {
      const sample = lines.slice(1, 6).join('\n')
      return { refuse: 'No line in "' + section.heading + '" contains "' + match + '". '
        + (sample !== '' ? 'Section starts:\n' + sample : 'The section is empty.') + ' Nothing was written.' }
    }
    sections[index] = { ...section, raw: kept.join('\n') + '\n', body: kept.slice(1).join('\n') }
    note = 'Removed ' + dropped + ' line(s) from "' + section.heading + '".'
  } else {
    // Unreachable through dnd_character_update.execute, which validates `op`
    // before anything is read. Backstop for a direct caller of this function:
    // silently proceeding would stamp both clocks on an unedited character.
    return { refuse: 'Nothing was written.' }
  }

  const isGenerated = (h) => h === 'generated' || h === '/dsh-dnd:generated'
  const structured = (h) => STRUCTURED_SECTIONS.some((x) => String(h).toLowerCase().startsWith(x))
  const narrative = sections
    .filter((s) => s.heading === null || (!isGenerated(s.heading) && !structured(s.heading)))
    .map((s) => s.raw)
    .join('\n')
    .trim()

  return {
    narrative,
    note: note + ' The generated summary was re-rendered from the state file; the numbers did not change.',
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
      const outcome = await applyToCharacter(fs, args.character, (located, state) => {
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
      // The startup probe's advisory is prepended by the pipeline itself, so
      // this tool and every other writer in the seam surface it identically.
      return outcome.result.text
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
      const outcome = await applyToCharacter(fs, args.character, (located, state) => {
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
      return outcome.result.text
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

      // The narrative edit enters the SAME seam as every other writer:
      // applyToCharacter resolves the character, takes the per-character lock
      // (so a narrative edit racing a slot expenditure composes, not clobbers)
      // and performs the write with the shared clocks, policy threading,
      // refusal diagnosis and probe advisory. This mutate only decides WHAT
      // to write.
      //
      // Inside the mutate the sheet is re-read — a read, which never queues —
      // so the gate and the section edit see the sheet as it stands INSIDE the
      // lock, and a concurrent track write's freshly re-rendered summary
      // cannot be clobbered by a stale snapshot taken outside it.
      const outcome = await applyToCharacter(fs, args.character, async (located) => {
        const sheetText = await readTextOrUndefined(fs, sheetPath(located.dir, located.name))
        if (sheetText === undefined) {
          return { refuse: 'No sheet file for "' + located.name + '" in ' + located.campaign + ' (characters/' + located.name + '.md). Build one with dnd_character_create.' }
        }
        return planNarrativeEdit(splitSheet(sheetText, { name: located.name }), {
          name: located.name,
          campaign: located.campaign,
          op, section: sectionName, body, text, match,
          create: args.create === true,
        })
      }, {
        // No idempotency key: the narrative path carries none, and a repeated
        // identical edit is refused as a no-op by content, not by key.
        sandboxPolicy: policyFor(exec),
        session: sessionOf(ctx, exec),
      })
      if (outcome.error !== undefined) return outcome.error
      let out = outcome.result.text
      // The pipeline reports write warnings separately; the narrative result
      // has always surfaced them on the text, so they ride here.
      for (const line of outcome.result.warnings ?? []) out += '\n' + line
      return out
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
