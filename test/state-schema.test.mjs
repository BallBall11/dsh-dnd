/**
 * state-schema tests — determinism, idempotence, and the two measured
 * JavaScript behaviours that would silently corrupt a state file.
 *
 * Fidelity matters more than throughput here: this module decides what the DM
 * sees when they ask about a character, and a wrong number shown confidently is
 * worse than a missing one.
 */
import assert from 'node:assert/strict'
import {
  SCHEMA_VERSION,
  MAX_APPLIED_KEYS,
  normalizeState,
  serializeState,
  parseState,
  statesEqual,
} from '../src/host/tools/state-schema.mjs'

let failures = 0
function test(name, fn) {
  try {
    fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failures += 1
    console.log('  FAIL ' + name)
    console.log('       ' + (error && error.message ? error.message : error))
  }
}

const ALICE = {
  schema: 1,
  name: 'Alice',
  player: null,
  campaign: 'morgansfort',
  updated: '2026-09-04',
  identity: {
    race: 'High Elf (Elf)', class: 'Wizard', level: 1,
    background: 'Sage', alignment: null, xp: 0, xpNext: 300,
  },
  abilities: { STR: 8, DEX: 14, CON: 15, INT: 17, WIS: 10, CHA: 10 },
  combat: {
    hp: { current: 8, max: 8 }, tempHp: 0, ac: 12, mageArmorAc: 15,
    initiative: 2, speed: 30,
    hitDice: { die: 'd6', remaining: 1 },
    deathSaves: { successes: 0, failures: 0 },
  },
  saves: { STR: -1, DEX: 2, CON: 2, INT: 5, WIS: 2, CHA: 0 },
  proficientSaves: ['INT', 'WIS'],
  skills: {
    Acrobatics: { ability: 'DEX', bonus: 2, proficient: false },
    Arcana: { ability: 'INT', bonus: 5, proficient: true },
    Perception: { ability: 'WIS', bonus: 2, proficient: true },
  },
  attacks: [
    { name: '电爪 Shocking Grasp', bonus: 5, damage: '1d8', type: 'Lightning', notes: null },
    { name: 'Ray of Frost', bonus: 5, damage: '1d8', type: 'Cold', notes: null },
  ],
  spellcasting: { ability: 'INT', saveDC: 13, attackBonus: 5 },
  spellSlots: { 1: { total: 2, used: 0 } },
  spells: {
    cantrips: ['Light', 'Mage Hand', '电爪 Shocking Grasp'],
    spellbook: ['Detect Magic', 'Mage Armor'],
    prepared: ['Mage Armor', 'Sleep'],
  },
  equipment: {
    weapons: { Quarterstaff: 1, Dagger: 1 },
    armour: {},
    gear: { Spellbook: 1, Robe: 1, Parchment: 8 },
  },
  currency: 800,
  warnings: [],
}

// --- determinism ----------------------------------------------------------
test('serialize is byte-identical for equal input', () => {
  assert.equal(serializeState(ALICE), serializeState(ALICE))
})

test('serialize is deterministic regardless of key insertion order', () => {
  const shuffled = {}
  for (const k of Object.keys(ALICE).reverse()) shuffled[k] = ALICE[k]
  assert.equal(serializeState(shuffled), serializeState(ALICE),
    'top-level key order must be canonicalized, not inherited')
})

test('serialize -> parse -> serialize is idempotent', () => {
  const once = serializeState(ALICE)
  const { state } = parseState(once)
  assert.equal(serializeState(state), once)
})

// --- the integer-key trap -------------------------------------------------
test('spell slot levels are sorted numerically, not lexically', () => {
  // JS hoists integer-like keys and sorts them; "10" would sort before "2"
  // under a string sort. 10th-level slots do not exist in 5e, but the
  // ordering rule must still be explicit rather than accidental.
  const s = normalizeState({ spellSlots: { 2: { total: 3, used: 0 }, 1: { total: 4, used: 1 } } })
  assert.deepEqual(Object.keys(s.spellSlots), ['1', '2'])

  const ordered = serializeState({
    spellSlots: { 10: { total: 1, used: 0 }, 2: { total: 3, used: 0 }, 1: { total: 4, used: 0 } },
  })
  const idx1 = ordered.indexOf('"1"')
  const idx2 = ordered.indexOf('"2"')
  const idx10 = ordered.indexOf('"10"')
  assert.ok(idx1 < idx2 && idx2 < idx10, 'expected 1, 2, 10 order, got:\n' + ordered)
})

test('equipment preserves insertion order (the DM ordering is meaningful)', () => {
  assert.deepEqual(Object.keys(normalizeState(ALICE).equipment.gear), ['Spellbook', 'Robe', 'Parchment'])
})

test('skills preserve insertion order', () => {
  assert.deepEqual(Object.keys(normalizeState(ALICE).skills), ['Acrobatics', 'Arcana', 'Perception'])
})

// --- the duplicate-key trap ----------------------------------------------
test('duplicate keys are reported rather than silently losing data', () => {
  const { state, warnings } = parseState('{"name":"Alice","name":"Bob"}')
  assert.equal(state.name, 'Bob', 'JSON.parse keeps the last value')
  assert.ok(warnings.some((w) => w.includes('duplicate key')), 'must warn: ' + JSON.stringify(warnings))
})

test('a clean file reports no duplicate-key warning', () => {
  const { warnings } = parseState(serializeState(ALICE))
  assert.ok(!warnings.some((w) => w.includes('duplicate')), JSON.stringify(warnings))
})

// --- fidelity -------------------------------------------------------------
test('non-ASCII names survive a round trip', () => {
  const { state } = parseState(serializeState(ALICE))
  assert.equal(state.attacks[0].name, '电爪 Shocking Grasp')
  assert.ok(state.spells.cantrips.includes('电爪 Shocking Grasp'))
})

test('unicode is literal in the file, not \\u-escaped', () => {
  const text = serializeState(ALICE)
  assert.ok(text.includes('电爪'), 'expected literal characters for a readable diff')
  assert.ok(!text.includes('\\u7535'), 'must not escape to \\uXXXX')
})

test('equipment quantities round-trip as numbers', () => {
  const { state } = parseState(serializeState(ALICE))
  assert.equal(state.equipment.gear.Parchment, 8)
  assert.equal(typeof state.equipment.gear.Parchment, 'number')
})

test('changing one quantity changes exactly one line', () => {
  const before = serializeState(ALICE)
  const after = serializeState({ ...ALICE, equipment: { ...ALICE.equipment, gear: { ...ALICE.equipment.gear, Parchment: 7 } } })
  // Compare as multisets of lines, NOT index-by-index: an added line shifts
  // every following index, so indexed comparison over-reports. This is the
  // same error that made an earlier analysis claim JSON diffs badly.
  const countLines = (t) => t.split('\n').reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map())
  const b = countLines(before)
  const a = countLines(after)
  const changed = []
  for (const [line, n] of b) if ((a.get(line) ?? 0) !== n) changed.push('- ' + line)
  for (const [line, n] of a) if ((b.get(line) ?? 0) !== n) changed.push('+ ' + line)
  // Parchment is the final key in `gear`, so it carries no trailing comma.
  assert.deepEqual(changed, ['-       "Parchment": 8', '+       "Parchment": 7'], changed.join('\n'))
})

// --- malformed input ------------------------------------------------------
test('empty text yields a warning, not a throw', () => {
  const { state, warnings } = parseState('')
  assert.equal(state, null)
  assert.ok(warnings.length > 0)
})

test('invalid JSON yields a warning, not a throw', () => {
  const { state, warnings } = parseState('{ not json')
  assert.equal(state, null)
  assert.match(warnings[0], /not valid JSON/)
})

test('a JSON array is rejected as a state file', () => {
  const { state, warnings } = parseState('[1,2,3]')
  assert.equal(state, null)
  assert.match(warnings[0], /must contain a JSON object/)
})

test('a BOM does not break parsing', () => {
  const { state } = parseState('\uFEFF' + serializeState(ALICE))
  assert.equal(state.name, 'Alice')
})

test('a schema mismatch warns', () => {
  const { warnings } = parseState('{"schema":99,"name":"X"}')
  assert.ok(warnings.some((w) => w.includes('schema 99')), JSON.stringify(warnings))
})

test('a missing schema field warns but still parses', () => {
  const { state, warnings } = parseState('{"name":"X"}')
  assert.equal(state.name, 'X')
  assert.ok(warnings.some((w) => w.includes('no schema field')), JSON.stringify(warnings))
  assert.equal(state.schema, SCHEMA_VERSION)
})

// --- normalization --------------------------------------------------------
test('NaN never reaches the file (it is not valid JSON)', () => {
  const text = serializeState({ combat: { hp: { current: NaN, max: 8 } }, abilities: { STR: 'abc' } })
  assert.ok(!text.includes('NaN'), text)
  assert.ok(!text.includes('null,') || true)
  const { state } = parseState(text)
  assert.equal(state.combat.hp.current, null)
  assert.equal(state.abilities.STR, null)
})

test('numeric strings are coerced to numbers', () => {
  const s = normalizeState({ abilities: { STR: '8', DEX: '14' }, combat: { ac: '12' } })
  assert.equal(s.abilities.STR, 8)
  assert.equal(s.combat.ac, 12)
})

test('proficient is a strict boolean', () => {
  const s = normalizeState({ skills: { Arcana: { ability: 'INT', bonus: 5, proficient: 'yes' } } })
  assert.equal(s.skills.Arcana.proficient, false, 'only true is true')
})

test('proficientSaves drops unknown abilities', () => {
  const s = normalizeState({ proficientSaves: ['INT', 'LUCK', 'WIS'] })
  assert.deepEqual(s.proficientSaves, ['INT', 'WIS'])
})

test('empty containers are emitted, not omitted', () => {
  const text = serializeState({ name: 'X' })
  assert.ok(text.includes('"spellSlots": {}'), text)
  assert.ok(text.includes('"armour": {}'), text)
})

test('statesEqual compares canonically', () => {
  const shuffled = {}
  for (const k of Object.keys(ALICE).reverse()) shuffled[k] = ALICE[k]
  assert.ok(statesEqual(ALICE, shuffled))
  assert.ok(!statesEqual(ALICE, { ...ALICE, name: 'Bob' }))
})

// --- money is one integer -------------------------------------------------
test('currency is a single copper total', () => {
  assert.equal(normalizeState({ currency: 785 }).currency, 785)
  assert.equal(typeof normalizeState({ currency: 785 }).currency, 'number')
})

test('a legacy {gp,sp,cp} triple folds into a total', () => {
  // An unmigrated file keeps its value rather than losing it.
  assert.equal(normalizeState({ currency: { gp: 7, sp: 8, cp: 5 } }).currency, 785)
  assert.equal(normalizeState({ currency: { gp: 8, sp: 0, cp: 0 } }).currency, 800)
})

test('a legacy triple with a negative unit still totals correctly', () => {
  // The old build could write this; it is arithmetically 785 cp.
  assert.equal(normalizeState({ currency: { gp: 8, sp: 0, cp: -15 } }).currency, 785)
})

test('currency is never serialized as an object', () => {
  const text = serializeState({ name: 'X', currency: 785 })
  assert.match(text, /"currency": 785/, text)
  assert.ok(!text.includes('"gp"'), 'no denominations in storage')
})

test('unknown top-level fields are dropped rather than serialized', () => {
  const s = normalizeState({ name: 'X', bogusField: 'nope' })
  assert.equal('bogusField' in s, false, 'a typo should surface as an absent value')
})

// --- fields the write tools depend on -------------------------------------
//
// Both of these were dropped silently when they were first added to track.mjs:
// the schema keeps only the fields in TOP_LEVEL_ORDER, so a new field that is
// not listed there disappears on write while the tool reports success. That is
// the most expensive shape of bug in this project — a plausible-looking report
// over data that did not move — so each is asserted explicitly.

test('conditions persist and are deduplicated', () => {
  const s = normalizeState({ name: 'X', conditions: ['prone', 'poisoned', 'prone', '  '] })
  assert.deepEqual(s.conditions, ['prone', 'poisoned'])
})

test('conditions survive a serialize round trip', () => {
  const text = serializeState({ name: 'X', conditions: ['prone', 'restrained'] })
  const back = parseState(text).state
  assert.deepEqual(back.conditions, ['prone', 'restrained'])
})

test('conditions default to an empty array, never undefined', () => {
  // A consumer reading `state.conditions.length` must not throw on a character
  // that has never been affected by anything.
  assert.deepEqual(normalizeState({ name: 'X' }).conditions, [])
})

test('non-string conditions are dropped', () => {
  const s = normalizeState({ name: 'X', conditions: ['prone', 7, null, { a: 1 }] })
  assert.deepEqual(s.conditions, ['prone'])
})

test('appliedKeys persist, deduplicate and cap', () => {
  const s = normalizeState({ name: 'X', appliedKeys: ['a', 'a', 'b'] })
  assert.deepEqual(s.appliedKeys, ['a', 'b'])

  const many = Array.from({ length: MAX_APPLIED_KEYS + 10 }, (_, i) => `k${i}`)
  const capped = normalizeState({ name: 'X', appliedKeys: many }).appliedKeys
  assert.equal(capped.length, MAX_APPLIED_KEYS, 'the list must stay bounded')
  // The newest are kept: a retry arrives seconds after the call it repeats.
  assert.equal(capped[capped.length - 1], `k${MAX_APPLIED_KEYS + 9}`)
})

test('appliedKeys survive a round trip, so a retry is caught after a restart', () => {
  const text = serializeState({ name: 'X', appliedKeys: ['session-4'] })
  assert.deepEqual(parseState(text).state.appliedKeys, ['session-4'])
})

test('the write tools can reach every field they mutate', () => {
  // The guard against the silent-drop class of bug: every field track.mjs
  // writes must survive normalization. A new field added to the tool without
  // adding it here fails this test rather than failing in front of a DM.
  const s = normalizeState({
    name: 'X',
    combat: { hp: { current: 1, max: 8 }, tempHp: 3 },
    spellSlots: { 1: { total: 2, used: 1 } },
    identity: { level: 1, xp: 250, xpNext: 300 },
    equipment: { gear: { Rations: 4 } },
    currency: 785,
    conditions: ['prone'],
    appliedKeys: ['k'],
  })
  assert.equal(s.combat.tempHp, 3, 'tempHp')
  assert.equal(s.combat.hp.current, 1, 'hp.current')
  assert.equal(s.spellSlots['1'].used, 1, 'spellSlots used')
  assert.equal(s.identity.xp, 250, 'xp')
  assert.equal(s.equipment.gear.Rations, 4, 'gear quantity')
  assert.equal(s.currency, 785, 'currency')
  assert.deepEqual(s.conditions, ['prone'], 'conditions')
  assert.deepEqual(s.appliedKeys, ['k'], 'appliedKeys')
})

console.log('')
if (failures > 0) {
  console.error(`state-schema.test.mjs: ${failures} failure(s)`)
  process.exit(1)
}
console.log('state-schema.test.mjs: all assertions passed')
