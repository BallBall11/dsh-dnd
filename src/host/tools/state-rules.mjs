/**
 * tools/state-rules.mjs — the parts of a character that have arithmetic.
 *
 * `state-schema` normalizes *types*: a spell-slot count is a number, an
 * equipment quantity is a number. It says nothing about whether those numbers
 * make sense. This module covers the other half — the rules a character's
 * values must satisfy, and the arithmetic between units.
 *
 * ## Money is one integer, never three
 *
 * A purse is stored as a single count of copper pieces: `currency: 785`.
 * Gold, silver and copper are *presentation*, produced when a value is shown
 * and parsed when one is entered.
 *
 * This is not a stylistic choice. Storing three fields invites updating one of
 * them, and `8 gp 0 sp 0 cp` minus `15 cp` then becomes `8 gp 0 sp -15 cp` —
 * arithmetically 785 cp, but a form no character ever holds, which happens to
 * be exactly what the previous build wrote to disk and rendered without
 * complaint. With one field there is no intermediate state to be caught in:
 * either you have 785 cp or you do not have 15 to spend.
 *
 * The three denominations exist at two edges and nowhere else:
 *
 *   parseCurrency("7 gp 8 sp 5 cp") -> 785     one-way, for input
 *   formatCurrency(785)             -> "7 gp 8 sp 5 cp"   for display
 *
 * ## Rules report; they never repair
 *
 * The tempting shortcut is to clamp whatever is wrong: a negative purse
 * becomes zero, HP above maximum becomes maximum. That is worse than the bug.
 * The DM would read a plausible number and never learn the character had been
 * in an impossible state. So `validateState` reports every violation and
 * changes nothing, and a spend that cannot be afforded is refused rather than
 * recorded as a debt.
 *
 * A rule is only enforced here when it is genuinely universal. Encumbrance,
 * attunement limits and multiclass slot tables are real rules with
 * table-specific handling, and guessing at them would produce confident wrong
 * answers — the failure mode this whole project keeps running into.
 */

/** Copper pieces in one of each unit. */
export const CP_PER = { cp: 1, sp: 10, gp: 100 }

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isInt = (v) => isNum(v) && Number.isInteger(v)

/**
 * Read a coin value into copper pieces.
 *
 * Accepts a number (already a total) or the three-field prose/legacy form.
 * This is the only place money enters the system, so a value that reaches
 * `currency` as a number is a total by construction.
 *
 * @param value - a number, or `{ gp, sp, cp }`, or a string like `"7 gp 8 sp"`.
 * @returns the total in copper pieces (possibly negative, which is reported).
 */
export function toCopper(value) {
  if (isNum(value)) return Math.trunc(value)
  if (typeof value === 'string') return toCopper(parseCurrency(value))
  if (value === null || typeof value !== 'object') return 0
  return (isNum(value.gp) ? value.gp : 0) * CP_PER.gp
    + (isNum(value.sp) ? value.sp : 0) * CP_PER.sp
    + (isNum(value.cp) ? value.cp : 0) * CP_PER.cp
}

/**
 * Break a copper total into denominations, for display only.
 *
 * The result is never stored. Every unit has the same sign as the total, so a
 * debt renders as `-1 gp -1 sp -1 cp` rather than a mixed-sign form that could
 * be mistaken for a real purse.
 *
 * @param totalCp - the total in copper pieces.
 * @returns `{ gp, sp, cp }` summing to the same total.
 */
export function fromCopper(totalCp) {
  const total = isNum(totalCp) ? Math.trunc(totalCp) : 0
  const sign = total < 0 ? -1 : 1
  const abs = Math.abs(total)
  // `sign * 0` is `-0` for a negative total, which formats as "-0 gp" and
  // compares unequal to 0. Normalizing it here keeps every unit an ordinary
  // integer.
  const part = (n) => {
    const v = sign * n
    return v === 0 ? 0 : v
  }
  return {
    gp: part(Math.floor(abs / CP_PER.gp)),
    sp: part(Math.floor((abs % CP_PER.gp) / CP_PER.sp)),
    cp: part(abs % CP_PER.sp),
  }
}

/**
 * Render a total as the campaign's prose form, e.g. `7 gp 8 sp 5 cp`.
 *
 * Accepts either a stored total or a `{ gp, sp, cp }` triple, so callers can
 * format whatever they happen to be holding.
 *
 * @param value - a copper total or a denomination triple.
 * @returns the human-readable form.
 */
export function formatCurrency(value) {
  const c = isNum(value) || typeof value === 'string' ? fromCopper(toCopper(value)) : (value ?? {})
  return `${c.gp ?? 0} gp ${c.sp ?? 0} sp ${c.cp ?? 0} cp`
}

/**
 * Render a total compactly, omitting leading zero units: `9 sp 5 cp`.
 *
 * Used for amounts where the empty denominations are noise — a shortfall, a
 * price. A value under a silver piece should not read `0 gp 0 sp 7 cp`.
 *
 * @param value - a copper total.
 * @returns the compact form, or `0 cp` for zero.
 */
export function formatCurrencyShort(value) {
  const c = fromCopper(toCopper(value))
  const parts = []
  if (c.gp !== 0) parts.push(`${c.gp} gp`)
  if (c.sp !== 0) parts.push(`${c.sp} sp`)
  // Always show copper when it is the only unit, or when nothing else is left.
  if (c.cp !== 0 || parts.length === 0) parts.push(`${c.cp} cp`)
  return parts.join(' ')
}

/**
 * Parse a prose coin string into a copper total.
 *
 * Tolerant of order, spacing and missing units: `"15 cp"`, `"8gp"`,
 * `"1 gp 2 sp"` and `"3 gold"` all work. Unknown words are ignored rather than
 * treated as zero-value, so `"8 gp or best offer"` still yields 800.
 *
 * @param text - the string to parse.
 * @returns the total in copper pieces.
 */
export function parseCurrency(text) {
  const s = String(text ?? '').toLowerCase()
  let total = 0
  const re = /(-?\d+)\s*(pp|gp|ep|sp|cp|platinum|gold|electrum|silver|copper)?/g
  let m
  while ((m = re.exec(s)) !== null) {
    const amount = Number(m[1])
    if (!Number.isFinite(amount)) continue
    switch (m[2]) {
      case 'pp': case 'platinum': total += amount * 1000; break
      case 'gp': case 'gold': total += amount * CP_PER.gp; break
      case 'ep': case 'electrum': total += amount * 50; break
      case 'sp': case 'silver': total += amount * CP_PER.sp; break
      // A bare number, or an explicit cp/copper, is already copper.
      default: total += amount; break
    }
  }
  return total
}

/**
 * Add a coin delta to a total.
 *
 * @param total - the current total in copper pieces.
 * @param delta - a number, or a `{ gp, sp, cp }` / string amount to add.
 * @returns the new total in copper pieces.
 */
export function addCurrency(total, delta) {
  return toCopper(total) + toCopper(delta)
}

/**
 * Work out what a spend would leave.
 *
 * Pure arithmetic; nothing is refused here. `affordable` is what the caller
 * acts on — a spend that cannot be met is refused at the call site rather than
 * being recorded as a debt, so this returns the arithmetic for the caller to
 * report the shortfall from.
 *
 * @param total - the current total in copper pieces.
 * @param cost - a number, or a `{ gp, sp, cp }` / string amount to spend.
 * @returns `{ total, affordable, shortfall, shortfallText }`.
 */
export function spendCurrency(total, cost) {
  const have = toCopper(total)
  const need = toCopper(cost)
  const after = have - need
  return {
    total: after,
    affordable: after >= 0 && need >= 0,
    shortfall: after < 0 ? -after : 0,
    shortfallText: after < 0 ? formatCurrencyShort(-after) : null,
  }
}

/**
 * Check a state against the rules that are true at every table.
 *
 * Returns findings and modifies nothing. Each finding names the field, says
 * what is wrong, and — where the intent is unambiguous — what the value should
 * be, so the DM can act rather than investigate.
 *
 * @param state - a normalized state object.
 * @returns an array of `{ field, level, message }`; `level` is `error` for a
 *   state that cannot exist, `warn` for one that is merely suspicious.
 */
export function validateState(state) {
  const findings = []
  const add = (field, level, message) => findings.push({ field, level, message })
  if (state === null || typeof state !== 'object') {
    add('state', 'error', 'no state to validate')
    return findings
  }

  // --- hit points ---------------------------------------------------------
  const hp = state.combat?.hp ?? {}
  if (isNum(hp.current) && isNum(hp.max)) {
    if (hp.max <= 0) add('combat.hp.max', 'error', `maximum HP is ${hp.max}; it must be positive`)
    if (hp.current > hp.max) {
      add('combat.hp.current', 'error', `HP ${hp.current} exceeds the maximum ${hp.max}`)
    }
    if (hp.current < 0) {
      add('combat.hp.current', 'error', `HP ${hp.current} is negative; 0 is the floor (a dead character is at 0 and rolling death saves)`)
    }
    // 0 is a legitimate state — unconscious and dying — not an error.
    if (hp.current === 0) add('combat.hp.current', 'warn', 'HP is 0: the character is unconscious and making death saves')
  } else if (hp.current !== undefined || hp.max !== undefined) {
    add('combat.hp', 'warn', 'HP is incomplete; both current and max are needed')
  }

  const tempHp = state.combat?.tempHp
  if (isNum(tempHp) && tempHp < 0) add('combat.tempHp', 'error', `temporary HP is ${tempHp}; it cannot be negative`)

  // --- spell slots --------------------------------------------------------
  for (const [level, slot] of Object.entries(state.spellSlots ?? {})) {
    if (!/^\d+$/.test(level)) {
      add(`spellSlots.${level}`, 'warn', `"${level}" is not a numeric spell level`)
      continue
    }
    const lvl = Number(level)
    if (lvl < 1 || lvl > 9) add(`spellSlots.${level}`, 'warn', `spell level ${lvl} is outside the 1-9 range`)
    if (!isNum(slot?.total) || !isNum(slot?.used)) {
      add(`spellSlots.${level}`, 'warn', 'slot entry needs numeric total and used')
      continue
    }
    if (slot.used > slot.total) {
      add(`spellSlots.${level}.used`, 'error',
        `${slot.used} of ${slot.total} level-${lvl} slots expended; more than the character has`)
    }
    if (slot.used < 0) add(`spellSlots.${level}.used`, 'error', `expended count is ${slot.used}; it cannot be negative`)
    if (slot.total < 0) add(`spellSlots.${level}.total`, 'error', `slot total is ${slot.total}; it cannot be negative`)
  }

  // --- currency -----------------------------------------------------------
  // Money is one integer. There is no mixed-sign state to detect, because
  // there are no denominations in storage to disagree — a purse is either a
  // total or it is nothing. A negative total means a spend was applied that
  // could not be afforded, which is refused at the call site, so reaching here
  // means the file was edited by hand or written by an older build.
  const purse = state.currency
  if (purse !== undefined && purse !== null) {
    if (!isNum(purse)) {
      add('currency', 'warn',
        `currency is ${JSON.stringify(purse)}; it must be a single copper total, e.g. 785`)
    } else {
      if (!Number.isInteger(purse)) {
        add('currency', 'warn', `currency is ${purse}; coin is counted in whole copper pieces`)
      }
      if (purse < 0) {
        add('currency', 'error',
          `the purse totals ${formatCurrency(purse)}; a character cannot hold negative coin. `
          + 'A spend that cannot be afforded is refused rather than recorded as a debt')
      }
    }
  }

  // --- abilities ----------------------------------------------------------
  for (const [key, score] of Object.entries(state.abilities ?? {})) {
    if (score === null || score === undefined) continue
    if (!isNum(score)) { add(`abilities.${key}`, 'warn', 'ability score is not a number'); continue }
    // 1-30 is the range every officially published character falls in. A score
    // outside it is almost always a typo rather than an exotic rule.
    if (score < 1 || score > 30) add(`abilities.${key}`, 'warn', `ability score ${score} is outside the plausible 1-30 range`)
  }

  const level = state.identity?.level
  if (isNum(level) && (level < 1 || level > 20)) {
    add('identity.level', 'warn', `character level ${level} is outside the 1-20 range`)
  }

  // --- equipment ----------------------------------------------------------
  for (const [bucket, items] of Object.entries(state.equipment ?? {})) {
    if (items === null || typeof items !== 'object') continue
    for (const [item, qty] of Object.entries(items)) {
      if (!isNum(qty)) { add(`equipment.${bucket}.${item}`, 'warn', 'quantity is not a number'); continue }
      if (qty < 0) add(`equipment.${bucket}.${item}`, 'error', `quantity ${qty} is negative`)
      if (!Number.isInteger(qty)) add(`equipment.${bucket}.${item}`, 'warn', `quantity ${qty} is fractional`)
    }
  }

  // --- attacks ------------------------------------------------------------
  for (const [i, attack] of (state.attacks ?? []).entries()) {
    if (attack.name === '' || attack.name === null) add(`attacks.${i}`, 'warn', 'attack has no name')
    if (attack.bonus !== null && attack.bonus !== undefined && !isNum(attack.bonus)) {
      add(`attacks.${i}.bonus`, 'warn', 'attack bonus is not a number')
    }
  }

  return findings
}

/** True when any finding is an error (a state that cannot exist). */
export function hasErrors(findings) {
  return findings.some((f) => f.level === 'error')
}

/** Format findings as human-readable lines. */
export function formatFindings(findings) {
  return findings.map((f) => `${f.level === 'error' ? 'ERROR' : 'warn'} ${f.field}: ${f.message}`)
}
