/**
 * tools/apply-damage.mjs — the rules of landing damage on a character.
 *
 * Pure computation: no fs, no writes. The write tools (dnd_attack's `target`
 * mode, and dnd_track's `hp` path) call these functions and then persist the
 * result through the validated write path, so the rules here are testable
 * without a campaign on disk.
 *
 * ## Why temp HP is absorbed here and not by the caller
 *
 * Damage does not touch hit points until temporary HP is gone — that ordering
 * is the rules' job, not each caller's. It used to be nobody's job: dnd_track
 * subtracted from `hp.current` directly and temp HP sat there unspent, which
 * made a character with temp HP strictly tougher than the rules allow. The
 * absorption lives in ONE function so every damage path shares one behaviour.
 *
 * ## Resistance and vulnerability
 *
 * Halving and doubling are the caller's declaration (`resistance` /
 * `vulnerability` naming a damage TYPE, e.g. "fire"), not something this
 * module looks up — the schema has no per-character resistance fields, so the
 * agent passes what it knows. Both applied is the rules' ambiguity, so it is
 * refused rather than guessed: halve then double is not the same number as
 * double then halve, and a silent pick would be a rules ruling nobody made.
 */

/**
 * Apply damage of one type to a character's combat block.
 *
 * @param combat - the character's `combat` object; NOT mutated — the caller
 *   receives the next value and owns the write.
 * @param amount - raw damage before type modifiers (>= 0).
 * @param options - `{ type, resistance, vulnerability }`; the type names are
 *   compared case-insensitively ("fire" matches "Fire").
 * @returns `{ combat, absorbed, applied, dead, note }` where `combat` is the
 *   next combat block, `absorbed` is what temp HP took, `applied` is what
 *   reached hp.current, `dead` is true when the character lands on exactly
 *   0 HP from a positive pool (the caller decides enemy-dead vs PC-dying), and
 *   `note` is a human-readable line describing each step. Returns
 *   `{ error }` instead when the arguments contradict (both resistance and
 *   vulnerability of the same type).
 */
export function applyDamage(combat, amount, options = {}) {
  const hp = combat?.hp ?? {}
  const max = typeof hp.max === 'number' && Number.isFinite(hp.max) ? hp.max : null
  const current = typeof hp.current === 'number' && Number.isFinite(hp.current) ? hp.current : 0
  const tempBefore = typeof combat?.tempHp === 'number' && Number.isFinite(combat.tempHp) ? combat.tempHp : 0

  if (!Number.isFinite(amount) || amount < 0) {
    return { error: `damage amount must be a number >= 0, got ${amount}` }
  }

  const type = normalizeType(options.type)
  const resist = normalizeType(options.resistance)
  const vuln = normalizeType(options.vulnerability)
  if (resist !== null && resist === vuln) {
    return { error: `damage type "${resist}" cannot be both resisted and vulnerable; decide the ruling first` }
  }

  // Type modifiers apply to the RAW amount, before temp HP absorbs anything —
  // halving first keeps the pool temp HP must burn through honest.
  let pool = amount
  const notes = []
  if (resist !== null && resist === type) {
    pool = Math.floor(pool / 2)
    notes.push(`resistance to ${type}: ${amount} halved to ${pool}`)
  }
  if (vuln !== null && vuln === type) {
    pool = pool * 2
    notes.push(`vulnerability to ${type}: doubled to ${pool}`)
  }

  // Temp HP absorbs first, one pool, no spill-back.
  const absorbed = Math.min(tempBefore, pool)
  const tempAfter = tempBefore - absorbed
  pool -= absorbed
  if (absorbed > 0) notes.push(`temp HP absorbed ${absorbed} (${tempBefore} -> ${tempAfter})`)

  // The remainder hits the real pool, clamped to the floor. Overflow past 0 is
  // reported, not silently dropped: the massive-damage rule needs it.
  const next = Math.max(0, current - pool)
  const applied = current - next
  if (pool > 0) notes.push(`HP ${current} -> ${next}${pool > current ? ` (overflow ${pool - current})` : ''}`)
  else if (applied === 0) notes.push('no damage reached hit points')

  const dead = applied > 0 && next === 0 && current > 0
  return {
    combat: { ...combat, tempHp: tempAfter, hp: { ...hp, current: next } },
    absorbed,
    applied,
    overflow: Math.max(0, pool - current),
    dead,
    note: notes.join('; '),
  }
}

/**
 * Whether a character's tags mark it as an enemy — the caller's signal to
 * treat 0 HP as defeated (dead condition) rather than dying (death saves).
 * @param tags - the character's frontmatter tags (the kind is always first).
 */
export function isEnemyTag(tags) {
  return (Array.isArray(tags) ? tags : []).some((t) => String(t).toLowerCase() === 'enemy')
}

/** Lowercase a damage-type name, or null when absent/blank. */
function normalizeType(value) {
  const s = String(value ?? '').trim().toLowerCase()
  return s === '' ? null : s
}
