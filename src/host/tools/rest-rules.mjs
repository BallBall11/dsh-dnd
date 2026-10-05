/**
 * tools/rest-rules.mjs — the rules of a short rest and a long rest.
 *
 * Pure computation: state in, change list out, never a write. The tool
 * (rest.mjs) resolves the campaign and the character, then persists through
 * track.mjs's locateAndApply, so the rules here are testable with no
 * filesystem at all.
 *
 * ## Which ruleset says what
 *
 *   Short rest — identical in SRD 5.1 and 5.2.1: spend Hit Dice, regain
 *   the roll plus the Constitution modifier per die spent.
 *
 *   Long rest — the two rulesets diverge on healing:
 *     2014 (SRD 5.1): "Regain half its maximum hit points" — HALF, not all.
 *     2024 (SRD 5.2.1): "Regain all lost Hit Points" — full heal.
 *   Everything else is shared: spell slots fully restored, and spent Hit
 *   Dice recovered in an amount equal to half the character's total, the
 *   character finishing the rest with at least half its Hit Dice... in both
 *   rulesets the recovery is half the TOTAL, so `ceil(total / 2)` regained,
 *   capped at the total. The total is the character's level — a character
 *   has one Hit Die per level — and without a level on the sheet the
 *   recovery cannot be computed, which is reported rather than guessed.
 */

/**
 * The standard ability modifier: floor((score - 10) / 2).
 * @param score - an ability score, e.g. 14.
 */
export function abilityMod(score) {
  const n = typeof score === 'number' && Number.isFinite(score) ? score : 10
  return Math.floor((n - 10) / 2)
}

/**
 * Spend Hit Dice on a short rest and heal.
 *
 * @param state - the normalized state; NOT mutated — the caller receives the
 *   next pieces and owns the write.
 * @param count - how many Hit Dice to spend (>= 1).
 * @param rollDie - `(sides) => 1..sides`, injected so tests pin the rolls.
 * @returns `{ refuse }` when the rest cannot happen (HD spent out, no die on
 *   the sheet, an unreadable count), otherwise
 *   `{ combat, healed, rolls, changes }` where `combat` is the next combat
 *   block and `rolls` is the per-die detail the DM narrates.
 */
export function spendHitDice(state, count, rollDie) {
  const hitDice = state.combat?.hitDice ?? {}
  const die = typeof hitDice.die === 'string' ? hitDice.die.trim() : ''
  const remaining = typeof hitDice.remaining === 'number' && Number.isFinite(hitDice.remaining) ? hitDice.remaining : null
  if (die === '' || !/^d\d+$/i.test(die)) {
    return { refuse: 'the sheet has no usable Hit Die (combat.hitDice.die is missing or unreadable); a short rest cannot be computed' }
  }
  if (remaining === null) {
    return { refuse: 'the sheet does not record how many Hit Dice remain; spend them through dnd_track or fix the sheet first' }
  }
  const n = Number(count)
  if (!Number.isInteger(n) || n < 1) {
    return { refuse: `hitDice must be a count of dice to spend (>= 1), got "${count}"` }
  }
  if (n > remaining) {
    return { refuse: `REFUSED: only ${remaining} Hit Dice remain; spending ${n} exceeds them. Nothing was written.` }
  }

  const sides = parseInt(die.slice(1), 10)
  const mod = abilityMod(state.abilities?.CON)
  const rolls = []
  for (let i = 0; i < n; i += 1) rolls.push(rollDie(sides))
  const raw = rolls.reduce((acc, v) => acc + v, 0) + n * mod

  const hp = state.combat?.hp ?? {}
  const max = typeof hp.max === 'number' && Number.isFinite(hp.max) ? hp.max : null
  const current = typeof hp.current === 'number' && Number.isFinite(hp.current) ? hp.current : 0
  // Healing clamps at the maximum; a negative modifier can pull the total
  // below zero, which heals nothing — 0 is the honest floor, not an error.
  const healed = Math.max(0, max === null ? raw : Math.min(raw, max - current))
  const next = current + healed

  const changes = []
  for (let i = 0; i < n; i += 1) {
    changes.push(`Hit Die ${i + 1}/${n}: d${sides} rolled ${rolls[i]}${mod !== 0 ? ` ${mod > 0 ? '+' : ''}${mod} CON` : ''}`)
  }
  changes.push(`Healed ${healed} (raw ${raw}${max !== null && raw > max - current ? ', clamped at max' : ''}): HP ${current} -> ${next}`)
  changes.push(`Hit Dice remaining: ${remaining} -> ${remaining - n}`)

  return {
    combat: { ...state.combat, hp: { ...hp, current: next }, hitDice: { ...hitDice, remaining: remaining - n } },
    healed,
    rolls,
    changes,
  }
}

/**
 * Apply a long rest.
 *
 * @param state - the normalized state; NOT mutated.
 * @param ruleset - "2014" or "2024" (the campaign's declaration decides).
 * @returns `{ combat, spellSlots, deathSaves, healed, changes }` — the
 *   caller picks the pieces it wants onto the state. `spellSlots` is the
 *   fully-rested map, `deathSaves` the zeroed tally.
 */
export function applyLongRest(state, ruleset) {
  const hp = state.combat?.hp ?? {}
  const max = typeof hp.max === 'number' && Number.isFinite(hp.max) ? hp.max : null
  const current = typeof hp.current === 'number' && Number.isFinite(hp.current) ? hp.current : 0

  // 2014: half the maximum. 2024: everything. Both capped at the maximum —
  // half of max on top of a more-than-half-full pool would overshoot it.
  // Without a maximum neither can be computed; the sheet is reported as-is.
  const healTo = max === null
    ? null
    : String(ruleset) === '2024' ? max : Math.min(max, current + Math.floor(max / 2))
  const healed = healTo === null ? 0 : Math.max(0, healTo - current)

  const hitDice = state.combat?.hitDice ?? {}
  const remaining = typeof hitDice.remaining === 'number' && Number.isFinite(hitDice.remaining) ? hitDice.remaining : null
  const level = typeof state.identity?.level === 'number' && Number.isFinite(state.identity.level) ? state.identity.level : null
  // The HD TOTAL is the character's level — one die per level. Falling back
  // to `remaining` would silently under-recover for a character that has
  // already spent dice, so a level-less sheet is reported, not guessed.
  const total = level
  let hdNext = remaining
  const changes = []
  if (remaining === null) {
    changes.push('Hit Dice: the sheet does not record a remaining count; left unchanged')
  } else if (total === null || !Number.isInteger(total) || total < 1) {
    changes.push(`Hit Dice: cannot compute the recovery without the character's level; ${remaining} remain unchanged`)
  } else {
    hdNext = Math.min(total, remaining + Math.ceil(total / 2))
    changes.push(`Hit Dice: ${remaining} -> ${hdNext} of ${total} (half the total recovered, rounded up)`)
  }

  const slots = {}
  for (const [lvl, entry] of Object.entries(state.spellSlots ?? {})) {
    slots[lvl] = { total: entry.total, used: 0 }
    if (typeof entry.used === 'number' && entry.used > 0) {
      changes.push(`Level ${lvl} spell slots: ${entry.total - entry.used}/${entry.total} -> ${entry.total}/${entry.total}`)
    }
  }

  const saves = state.combat?.deathSaves ?? {}
  const deathSaves = { successes: 0, failures: 0 }
  if ((saves.successes ?? 0) > 0 || (saves.failures ?? 0) > 0) {
    changes.push(`Death saves cleared (was ${saves.successes ?? 0} success / ${saves.failures ?? 0} failures)`)
  }

  if (healed > 0) {
    changes.push(`${String(ruleset) === '2024' ? '2024' : '2014'} long rest: HP ${current} -> ${current + healed} `
      + `(max ${max ?? '?'})`)
  } else if (max !== null) {
    changes.push(`HP already ${current}/${max}; no healing needed`)
  } else {
    changes.push('the sheet has no HP maximum; healing cannot be computed')
  }

  return {
    combat: { ...state.combat, hp: { ...hp, current: healTo === null ? current : healTo }, hitDice: { ...hitDice, remaining: hdNext }, deathSaves },
    spellSlots: slots,
    healed,
    changes,
  }
}
