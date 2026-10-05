/**
 * tools/rest.mjs — dnd_rest, the short-rest / long-rest settlement tool.
 *
 * A rest is ONE event at the table: the party stops, and a bundle of rules
 * fire together — Hit Dice spent and rolled, spell slots restored, death
 * saves cleared, HP regained by the campaign's own ruleset. Before this tool
 * each of those was a separate dnd_track call whose correctness depended on
 * the caller re-deriving the rules every time. Settling them in one write
 * under one idempotency key means a rest that is interrupted by a retry
 * applies once.
 *
 * The layering matches track.mjs: the rules live in rest-rules.mjs (pure),
 * the persistence goes through locateAndApply (the same per-character lock,
 * idempotency keys, clocks and write diagnosis every write tool shares), and
 * the judgement — which characters rest, how many Hit Dice they spend — is
 * the caller's, passed in as arguments and reported back verbatim.
 *
 * ## What a rest deliberately does NOT do
 *
 * Timed effects live in the encounter store, not the character state, and a
 * long rest terminating them is a cross-store write this tool cannot make
 * atomically. Rather than half-apply, the report names the rule and leaves
 * the cleanup to dnd_effect. Conditions are likewise untouched: exhaustion
 * and friends outlast a night's sleep by a ruling only the DM makes, so the
 * report lists what is still there instead of deciding.
 */

import { activeCampaignDir, readCampaignRuleset } from './shared.mjs'
import { locateAndApply } from './track.mjs'
import { readAllCharacters } from './state-io.mjs'
import { parseDice, rollParsed } from './roll.mjs'
import { spendHitDice, applyLongRest } from './rest-rules.mjs'
import { sessionOf, writePolicyFor } from './session-scope.mjs'

export const name = 'dnd-rest'

/**
 * Roll one Hit Die with the module's own dice, keeping the face value.
 * @param sides - the die's SIDES (rest-rules's rollDie contract passes a
 *   number, e.g. 10 for a d10). The earlier version treated it as a die
 *   string and parsed "1" + 10 = "110", which parseDice rejects — every
 *   Hit Dice roll silently fell back to 0 and short rests healed CON only.
 * @returns the rolled face (1..sides). The die's shape was validated by
 *   rest-rules before this is ever called; an unusable spec here is a
 *   programming error, so it throws rather than healing for free.
 */
function rollOne(sides) {
  const expr = parseDice(`1d${sides}`)
  if (expr === null) throw new Error(`dnd_rest: unusable hit die sides "${sides}"`)
  return rollParsed(expr).total
}

/** Parse the hitDice argument: "2" or "2d8" both mean two dice. */
function requestedCount(raw) {
  const s = String(raw).trim().toLowerCase()
  if (s === '') return null
  const m = s.match(/^(\d+)(?:d\d+)?$/)
  if (m === null) return null
  const n = parseInt(m[1], 10)
  return Number.isInteger(n) && n >= 1 ? n : null
}

/**
 * Build the rest tools.
 * @param ctx - host context; `fs` is optional.
 * @returns an array of tool definitions.
 */
export function buildTools(ctx) {
  const getFs = () => ctx.get('fs')
  const renderText = (_args, value) => [{ type: 'text', text: String(value) }]

  /**
   * The mutation locateAndApply runs inside the character's lock. Applies the
   * rest rules for `kind` and refuses (without writing) when the rules cannot
   * be satisfied. Collected change lines land in `captured`, which the
   * describe step renders — the same closure, so the report can never name
   * changes the write did not carry.
   */
  function makeMutate(kind, args, ruleset, captured) {
    // locateAndApply calls the mutation as `mutate(located, state)`.
    return (_located, state) => {
      if (kind === 'short') {
        let count = 1
        if (args.hitDice !== undefined && String(args.hitDice).trim() !== '') {
          const parsed = requestedCount(args.hitDice)
          if (parsed === null) {
            return { refuse: 'dnd_rest could not read hitDice "' + args.hitDice + '". Use a count like "2" (or "2d8"). Nothing was written.' }
          }
          count = parsed
        }
        const out = spendHitDice(state, count, rollOne)
        if (out.refuse !== undefined) return { refuse: `dnd_rest: ${out.refuse}. Nothing was written.` }
        state.combat = out.combat
        captured.push(...out.changes)
        return undefined
      }
      const out = applyLongRest(state, ruleset)
      state.combat = out.combat
      state.spellSlots = out.spellSlots
      captured.push(...out.changes)
      return undefined
    }
  }

  /**
   * The full report: the settle lines, then what the rest deliberately left
   * for the DM to rule on.
   */
  function describeRest(state, name, kind, ruleset, captured) {
    const conditions = Array.isArray(state.conditions) ? state.conditions : []
    const hp = state.combat?.hp ?? {}
    const head = kind === 'long'
      ? `${name} finishes a LONG rest (ruleset ${ruleset})`
      : `${name} takes a SHORT rest`
    const lines = [head, ...captured.map((c) => '  ' + c)]
    if (conditions.length > 0) {
      lines.push(`  Conditions still present (a rest does not remove them by default): ${conditions.join(', ')}`)
    }
    if (kind === 'long') {
      lines.push('  Timed effects are not cleared by this tool — terminate those that a night\'s rest ends with dnd_effect.')
    }
    lines.push(`  HP now ${hp.current ?? '?'}/${hp.max ?? '?'}.`)
    return lines.join('\n')
  }

  const rest = {
    name: 'dnd_rest',
    description: 'Settle a short rest or a long rest for one character or the whole party, and write it. '
      + 'Short rest: spends Hit Dice (rolled by the tool, per-die detail returned) and heals roll + CON per die. '
      + 'Long rest: 2014 campaigns heal half the maximum, 2024 campaigns heal fully; both restore all spell slots, recover half the total Hit Dice and clear death saves. '
      + 'Conditions are NOT removed — the report lists them for the DM to rule on. Timed effects are not cleared here; use dnd_effect. '
      + 'Pass `key` to make a retry safe.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: '"short" or "long". Required.', enum: ['short', 'long'] },
        character: { type: 'string', description: 'Character name or stem. Omit when party is true or the campaign has exactly one character.' },
        party: { type: 'boolean', description: 'Settle every PC in the campaign. Each is written under its own idempotency key (`key:NAME`).' },
        hitDice: { type: 'string', description: 'Short rest: how many Hit Dice to spend, e.g. "2" or "2d8". Default 1.' },
        key: { type: 'string', description: 'Idempotency key. A retry with the same key settles nobody twice.' },
      },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'

      const kind = String(args.kind ?? '').toLowerCase()
      if (kind !== 'short' && kind !== 'long') {
        return 'dnd_rest needs `kind`: "short" or "long". Nothing was written.'
      }

      const campaign = await activeCampaignDir(fs, sessionOf(ctx, exec))
      if (campaign === undefined) {
        return 'No active campaign. Load one with /dm:dnd load <campaign> first.'
      }
      const ruleset = await readCampaignRuleset(fs, campaign.dir)

      // Party mode settles the PCs by name, each through its own locked write
      // and its own idempotency key, so one failure never blocks the rest.
      if (args.party === true) {
        const { characters, warnings } = await readAllCharacters(fs, `${campaign.dir}/characters`)
        const pcs = characters.filter((c) => (c.metadata?.tags ?? []).some((t) => String(t).toLowerCase() === 'pc'))
        if (pcs.length === 0) {
          return `No PCs in campaign ${campaign.campaign} — a party rest has nobody to settle. (Enemies and NPCs are skipped by design.)`
        }
        const lines = [`${kind === 'long' ? 'Long' : 'Short'} rest for the party of ${campaign.campaign} (ruleset ${ruleset}):`]
        for (const w of warnings) lines.push(`  (warning) ${w}`)
        for (const pc of pcs) {
          const captured = []
          const outcome = await locateAndApply(fs, pc.name, makeMutate(kind, args, ruleset, captured), {
            key: args.key === undefined || args.key === null || String(args.key).trim() === '' ? null : `${String(args.key).trim()}:${pc.name}`,
            sandboxPolicy: writePolicyFor(ctx, exec),
            session: sessionOf(ctx, exec),
            describe: (state, located) => describeRest(state, located.name, kind, ruleset, captured),
          })
          if (outcome.error !== undefined) {
            lines.push(`${pc.name}: FAILED — ${outcome.error}`)
            continue
          }
          lines.push(outcome.result.duplicate === true
            ? `${pc.name}: already rested under this key; nothing changed`
            : outcome.result.text.split('\n').map((l, i) => (i === 0 ? `${pc.name}: ${l}` : `  ${l}`)).join('\n'))
        }
        return lines.join('\n')
      }

      const captured = []
      const outcome = await locateAndApply(fs, args.character, makeMutate(kind, args, ruleset, captured), {
        key: args.key,
        sandboxPolicy: writePolicyFor(ctx, exec),
        session: sessionOf(ctx, exec),
        describe: (state, located) => describeRest(state, located.name, kind, ruleset, captured),
      })
      if (outcome.error !== undefined) return outcome.error
      return outcome.result.text
    },
  }

  return [rest]
}
