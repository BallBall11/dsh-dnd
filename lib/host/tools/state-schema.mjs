/**
 * state-schema — the structured half of a character sheet.
 *
 * ## Why this module exists
 *
 * A character sheet mixes two kinds of content that must not share a
 * representation:
 *
 *   structured — six abilities, HP, AC, skills, spell slots, spells,
 *                equipment, currency. Finite, unambiguous, machine-owned.
 *   narrative  — the player's own sentence, backstory, and the Features &
 *                Traits entries. Prose. Reformatting destroys it.
 *
 * The structured half lives in `characters/<name>.state.json` and is the
 * plugin's authority. The narrative half stays in `characters/<name>.md` and
 * is never machine-parsed into fields. Each field has exactly one home, so the
 * two files cannot drift apart — the failure that produced this design was
 * `state.md` and `alice.md` disagreeing about a spell slot with no rule for
 * which won.
 *
 * ## Determinism is a requirement, not a nicety
 *
 * The whole point of splitting the state out was a readable history, so the
 * serializer must produce byte-identical output for identical input. Two
 * measured JavaScript behaviours make that non-obvious and are handled here:
 *
 *   1. Integer-like keys are hoisted and sorted by the engine:
 *        {Zombie:1, "10":x, "2":y, Alpha:2, "1":z}  ->  1, 2, 10, Zombie, Alpha
 *      Spell-slot levels are the keys "1", "2", ... and hit this rule exactly,
 *      so they are sorted explicitly rather than relying on insertion order.
 *      Item and skill names are not integer-like and keep insertion order,
 *      which is meaningful (the DM's own ordering) and therefore preserved.
 *
 *   2. Duplicate keys are silently resolved in favour of the last:
 *        JSON.parse('{"Robe":1,"Robe":2}')  ->  {"Robe":2}
 *      A hand-edited file can therefore lose data without error. The write
 *      path takes structured objects only and never raw JSON text.
 *
 * See docs/REWRITE-PLAN.md §4.
 */

/** Bump when the on-disk shape changes incompatibly. */
export const SCHEMA_VERSION = 1

/**
 * How many idempotency keys to remember per character.
 *
 * Bounded on purpose: the list exists to catch a retry, and a retry arrives
 * seconds later. Keeping the most recent handful is enough for that, and keeps
 * a campaign that runs for years from growing a line per purchase. Defined here
 * rather than in track.mjs because the schema enforces the cap on every read,
 * including one performed by a build whose write tools never ran.
 */
export const MAX_APPLIED_KEYS = 32

const ABILITIES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']

/**
 * Fixed top-level field order. Anything absent from this list is dropped by
 * `normalizeState` rather than silently serialized, so a typo in a field name
 * surfaces as a missing value instead of an extra key nobody reads.
 *
 * `player`, `campaign` and `updated` are deliberately absent. They describe the
 * file rather than the character and live in the `.md` frontmatter; keeping them
 * here too would recreate the drift this split exists to prevent.
 */
const TOP_LEVEL_ORDER = [
  'schema', 'name',
  'identity', 'abilities', 'combat', 'saves', 'proficientSaves',
  'skills', 'spellcasting', 'spellSlots', 'spells',
  'equipment', 'currency', 'conditions', 'warnings', 'appliedKeys',
]

/** Ordered sub-object shapes. Keys here are emitted in this order. */
const NESTED_ORDER = {
  identity: ['race', 'class', 'level', 'background', 'alignment', 'xp', 'xpNext'],
  combat: ['hp', 'tempHp', 'ac', 'mageArmorAc', 'initiative', 'speed', 'hitDice', 'deathSaves'],
  'combat.hp': ['current', 'max'],
  'combat.hitDice': ['die', 'remaining'],
  'combat.deathSaves': ['successes', 'failures'],
  spellcasting: ['ability', 'saveDC', 'attackBonus'],
  spells: ['cantrips', 'spellbook', 'prepared'],
  equipment: ['weapons', 'armour', 'gear'],
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Scalar fields the schema declares numeric. Everything else keeps its own
 * type, so `combat.ac: "12"` becomes 12 while `combat.hitDice.die: "d6"` stays
 * a string.
 */
const NUMERIC_FIELDS = new Set([
  'identity.level', 'identity.xp', 'identity.xpNext',
  'combat.tempHp', 'combat.ac', 'combat.mageArmorAc', 'combat.initiative', 'combat.speed',
  'combat.hp.current', 'combat.hp.max',
  'combat.hitDice.remaining',
  'combat.deathSaves.successes', 'combat.deathSaves.failures',
  'spellcasting.saveDC', 'spellcasting.attackBonus',
])

/** Sub-objects that must always exist, so consumers need no null-check. */
const ALWAYS_PRESENT = {
  spellSlots: () => ({}),
  spells: () => ({ cantrips: [], spellbook: [], prepared: [] }),
  equipment: () => ({ weapons: {}, armour: {}, gear: {} }),
  skills: () => ({}),
  abilities: () => ({}),
  saves: () => ({}),
  proficientSaves: () => [],
  // `conditions` is materialized for the same reason as the rest: a consumer
  // reading `state.conditions.length` must not throw on a character that has
  // never been affected by anything. Without this it is `undefined`, which is
  // the empty case wearing a crash.
  conditions: () => [],
  warnings: () => [],
  // Deliberately NOT materialized: `appliedKeys` absent and `appliedKeys: []`
  // mean different things to a human reading the file — "no keyed write has
  // ever happened here" versus "keyed writes happened and the list was since
  // emptied". Only the write tools read it, and they already guard for absence.
  combat: () => ({ hp: { current: null, max: null }, hitDice: { die: null, remaining: null }, deathSaves: { successes: 0, failures: 0 } }),
  spellcasting: () => ({ ability: null, saveDC: null, attackBonus: null }),
  identity: () => ({ race: null, class: null, level: null, background: null, alignment: null, xp: null, xpNext: null }),
  currency: () => 0,
}

/**
 * Order an object's keys: known keys first in their declared order, then any
 * remaining keys in insertion order (or sorted, when `sortRest` is set).
 * @param obj - the source object.
 * @param order - the declared key order, or undefined to keep insertion order.
 * @param sortRest - numeric-aware sort for the leftover keys.
 */
function orderKeys(obj, order, sortRest = false) {
  const keys = Object.keys(obj)
  const known = (order ?? []).filter((k) => keys.includes(k))
  const rest = keys.filter((k) => !known.includes(k))
  if (sortRest) rest.sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b))
  return [...known, ...rest]
}

/**
 * Rebuild a state object into its canonical shape and key order.
 *
 * `spellSlots` keys are sorted numerically; `skills` and the equipment
 * dictionaries keep the author's insertion order. Absolute paths, functions
 * and other non-JSON values are dropped rather than serializing as null.
 *
 * @param state - a partial or untrusted state object.
 * @returns a new object safe for `JSON.stringify`, with canonical ordering.
 */
export function normalizeState(state) {
  const src = isPlainObject(state) ? state : {}
  const out = {}

  for (const key of TOP_LEVEL_ORDER) {
    if (!(key in src)) continue
    const value = src[key]

    if (key === 'spellSlots') {
      const slots = {}
      for (const lvl of orderKeys(isPlainObject(value) ? value : {}, undefined, true)) {
        const entry = value[lvl]
        if (!isPlainObject(entry)) continue
        slots[lvl] = { total: numOrNull(entry.total), used: numOrNull(entry.used) }
      }
      out.spellSlots = slots
      continue
    }

    if (key === 'abilities') {
      const abilities = {}
      const source = isPlainObject(value) ? value : {}
      for (const ab of ABILITIES) {
        if (ab in source) abilities[ab] = numOrNull(source[ab])
      }
      out.abilities = abilities
      continue
    }

    if (key === 'skills') {
      // Insertion order is the DM's own skill ordering; preserve it.
      const skills = {}
      for (const nameKey of orderKeys(isPlainObject(value) ? value : {})) {
        const s = value[nameKey]
        if (!isPlainObject(s)) continue
        skills[nameKey] = {
          ability: s.ability ?? null,
          bonus: numOrNull(s.bonus),
          proficient: s.proficient === true,
        }
      }
      out.skills = skills
      continue
    }

    if (key === 'saves') {
      const saves = {}
      const source = isPlainObject(value) ? value : {}
      for (const ab of ABILITIES) {
        if (ab in source) saves[ab] = numOrNull(source[ab])
      }
      out.saves = saves
      continue
    }

    if (key === 'proficientSaves') {
      out.proficientSaves = (Array.isArray(value) ? value : [])
        .filter((v) => typeof v === 'string' && ABILITIES.includes(v))
      continue
    }

    if (key === 'spells') {
      const spells = {}
      const source = isPlainObject(value) ? value : {}
      for (const list of NESTED_ORDER.spells) {
        spells[list] = (Array.isArray(source[list]) ? source[list] : [])
          .filter((v) => typeof v === 'string' && v !== '')
      }
      // Preserve any extra spell lists the sheet grows later.
      for (const list of orderKeys(source).filter((k) => !NESTED_ORDER.spells.includes(k))) {
        if (Array.isArray(source[list])) {
          spells[list] = source[list].filter((v) => typeof v === 'string' && v !== '')
        }
      }
      out.spells = spells
      continue
    }

    if (key === 'equipment') {
      // name -> quantity, insertion order preserved. Quantitative and diffable:
      // changing one count rewrites one line.
      const equipment = {}
      const source = isPlainObject(value) ? value : {}
      for (const bucket of NESTED_ORDER.equipment) {
        const items = isPlainObject(source[bucket]) ? source[bucket] : {}
        const cleaned = {}
        for (const itemName of orderKeys(items)) {
          const qty = numOrNull(items[itemName])
          if (qty !== null) cleaned[itemName] = qty
        }
        equipment[bucket] = cleaned
      }
      for (const bucket of orderKeys(source).filter((k) => !NESTED_ORDER.equipment.includes(k))) {
        if (isPlainObject(source[bucket])) equipment[bucket] = { ...source[bucket] }
      }
      out.equipment = equipment
      continue
    }

    if (key === 'currency') {
      // Money is one copper total, never three fields. Storing denominations
      // invites updating one of them, which is how `8 gp 0 sp 0 cp` minus
      // `15 cp` became `8 gp 0 sp -15 cp` — a form no character holds. With a
      // single integer there is no intermediate state to be caught in.
      // Denominations are produced for display by state-rules.formatCurrency.
      if (isPlainObject(value)) {
        // A legacy `{gp,sp,cp}` triple is folded into a total on read, so an
        // unmigrated file keeps its value rather than losing it.
        const gp = numOrNull(value.gp) ?? 0
        const sp = numOrNull(value.sp) ?? 0
        const cp = numOrNull(value.cp) ?? 0
        out.currency = Math.trunc(gp * 100 + sp * 10 + cp)
      } else {
        out.currency = numOrNull(value)
      }
      continue
    }

    if (key === 'conditions') {
      // A list of condition names: prone, poisoned, restrained. Stored as
      // strings in the DM's own order, deduplicated, because two `prone`
      // entries are one condition and would render as two.
      const seen = new Set()
      const conditions = []
      for (const c of Array.isArray(value) ? value : []) {
        if (typeof c !== 'string') continue
        const trimmed = c.trim()
        if (trimmed === '' || seen.has(trimmed)) continue
        seen.add(trimmed)
        conditions.push(trimmed)
      }
      out.conditions = conditions
      continue
    }

    if (key === 'appliedKeys') {
      // Idempotency keys already applied to this character, oldest first.
      // Bookkeeping for the write tools rather than character state, but it has
      // to live in the file for a retry to be recognised after a restart.
      // Deduplicated and capped so a long campaign cannot grow it without limit.
      const seen = new Set()
      const keys = []
      for (const k of Array.isArray(value) ? value : []) {
        if (typeof k !== 'string' || k === '' || seen.has(k)) continue
        seen.add(k)
        keys.push(k)
      }
      out.appliedKeys = keys.slice(Math.max(0, keys.length - MAX_APPLIED_KEYS))
      continue
    }

    if (key === 'warnings') {
      out.warnings = (Array.isArray(value) ? value : []).filter((v) => typeof v === 'string')
      continue
    }

    if (isPlainObject(value)) {
      const nested = {}
      const order = NESTED_ORDER[key]
      for (const k of orderKeys(value, order)) {
        const v = value[k]
        if (isPlainObject(v)) {
          const inner = {}
          for (const ik of orderKeys(v, NESTED_ORDER[`${key}.${k}`])) {
            inner[ik] = typeof v[ik] === 'number' || v[ik] === null ? v[ik] : numOrNull(v[ik]) ?? v[ik]
          }
          nested[k] = inner
        } else if (typeof v === 'number' || v === null) {
          nested[k] = v
        } else if (typeof v === 'boolean' || typeof v === 'string') {
          // `ac` and `speed` are numbers; `die` is a string. Coerce only the
          // fields the schema declares numeric, so a string field like
          // hitDice.die stays a string.
          nested[k] = NUMERIC_FIELDS.has(`${key}.${k}`) ? numOrNull(v) : v
        } else {
          nested[k] = v
        }
      }
      out[key] = nested
      continue
    }

    out[key] = value
  }

  if (out.schema === undefined) out.schema = SCHEMA_VERSION

  // Materialize the containers every consumer reads, so no caller has to
  // distinguish "absent" from "empty" — the character panel renders these
  // directly and a missing key would surface as a runtime error in the UI
  // rather than as an empty section.
  for (const [key, make] of Object.entries(ALWAYS_PRESENT)) {
    if (out[key] === undefined) out[key] = make()
  }

  // Keep the declared top-level order even after materializing.
  const ordered = {}
  for (const key of TOP_LEVEL_ORDER) if (key in out) ordered[key] = out[key]
  for (const key of Object.keys(out)) if (!(key in ordered)) ordered[key] = out[key]
  return ordered
}

/** Coerce to a finite number, or null. Never NaN, which is not valid JSON. */
function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Serialize a state object to canonical JSON text.
 *
 * Byte-identical for equal input. Unicode is emitted literally rather than
 * escaped (`电爪 Shocking Grasp` stays readable in the diff, which matters for
 * a file whose entire purpose is a legible history).
 *
 * @param state - the state object (normalized here, so callers need not).
 * @returns JSON text with a trailing newline.
 */
export function serializeState(state) {
  return JSON.stringify(normalizeState(state), null, 2) + '\n'
}

/**
 * Parse state JSON text.
 *
 * Never throws: a corrupt state file must degrade to a reportable warning, not
 * take down the panel that exists to show it.
 *
 * @param text - file contents.
 * @returns `{ state, warnings }`; `state` is null when unparseable.
 */
export function parseState(text) {
  const warnings = []
  const raw = stripBom(text)
  if (raw.trim() === '') return { state: null, warnings: ['state file is empty'] }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { state: null, warnings: [`state file is not valid JSON: ${error.message}`] }
  }
  if (!isPlainObject(parsed)) {
    return { state: null, warnings: ['state file must contain a JSON object'] }
  }

  if (parsed.schema === undefined) {
    warnings.push('state file has no schema field; assuming version 1')
  } else if (parsed.schema !== SCHEMA_VERSION) {
    warnings.push(`state file schema ${parsed.schema}, this build reads ${SCHEMA_VERSION}`)
  }

  // A duplicate key is silently resolved by JSON.parse in favour of the last
  // occurrence, so detect it here and report rather than lose it quietly.
  for (const dup of findDuplicateKeys(raw)) warnings.push(`duplicate key "${dup}" in state file; the last value won`)

  const state = normalizeState(parsed)
  state.warnings = [...(state.warnings ?? []), ...warnings]
  return { state, warnings }
}

/** Strip a UTF-8 BOM (Windows editors add one; JSON.parse chokes on it). */
function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : String(text ?? '')
}

/**
 * Find duplicate keys within any single JSON object.
 *
 * A regex scan, not a real parse: it only needs to catch the case a human
 * editing by hand would create. False positives on object-like text inside a
 * string value are possible and only cost a spurious warning.
 * @param text - raw JSON text.
 */
function findDuplicateKeys(text) {
  const found = []
  const objectRe = /\{([^{}]*)\}/g
  let match
  while ((match = objectRe.exec(text)) !== null) {
    const keys = [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map((m) => m[1])
    const seen = new Set()
    for (const k of keys) {
      if (seen.has(k)) found.push(k)
      seen.add(k)
    }
  }
  return [...new Set(found)]
}

/**
 * Compare two states for equality after normalization.
 * @returns true when both serialize identically.
 */
export function statesEqual(a, b) {
  return serializeState(a) === serializeState(b)
}
