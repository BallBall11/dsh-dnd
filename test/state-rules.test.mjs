/**
 * state-rules tests.
 *
 * The scenario that motivated this module is the first case below: Alice has
 * 8 gp 0 sp 0 cp and spends 15 cp. The naive subtraction yields -15 cp, which
 * the earlier build wrote to disk and rendered in the summary as
 * "8 gp 0 sp -15 cp" â€?a state no character can be in, displayed without
 * complaint.
 *
 * The two halves are deliberately different: conversion is applied, because
 * 1 gp = 10 sp = 100 cp is unambiguous; validation only reports, because
 * clamping a bad value would hide it behind a plausible one.
 */
import assert from 'node:assert/strict'
import {
  toCopper,
  fromCopper,
  addCurrency,
  spendCurrency,
  formatCurrency,
  formatCurrencyShort,
  parseCurrency,
  validateState,
  hasErrors,
  formatFindings,
} from '../src/host/tools/state-rules.mjs'
import { normalizeState } from '../src/host/tools/state-schema.mjs'

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

// --- the motivating scenario ---------------------------------------------
test('spending 15 cp from 8 gp breaks a gold piece', () => {
  const { total, affordable } = spendCurrency(800, 15)
  assert.equal(affordable, true, 'the character has 800 cp')
  assert.equal(total, 785, '8 gp - 15 cp is 785 cp')
  assert.equal(formatCurrency(total), '7 gp 8 sp 5 cp', 'shown as 7 gp 8 sp 5 cp, never -15 cp')
})

test('the naive subtraction this replaces is not representable', () => {
  // The old shape allowed `{gp:8, sp:0, cp:-15}`. A single integer has no way
  // to express it, which is the point: the bad state cannot be constructed.
  const naive = { gp: 8, sp: 0, cp: -15 }
  assert.equal(toCopper(naive), 785, 'the legacy triple still folds to the right total on read')
  const findings = validateState(normalizeState({ currency: naive })).filter((f) => f.field === 'currency')
  assert.deepEqual(findings, [], 'and folds cleanly, since the total it implies is valid')
})

test('a stored purse is always a single integer', () => {
  const s = normalizeState({ currency: { gp: 7, sp: 8, cp: 5 } })
  assert.equal(s.currency, 785)
  assert.equal(typeof s.currency, 'number')
})

// --- conversion -----------------------------------------------------------
test('toCopper totals a purse', () => {
  assert.equal(toCopper({ gp: 8, sp: 0, cp: 0 }), 800)
  assert.equal(toCopper({ gp: 1, sp: 1, cp: 1 }), 111)
  assert.equal(toCopper(785), 785, 'a number is already a total')
  assert.equal(toCopper({}), 0)
})

test('toCopper accepts a prose string', () => {
  assert.equal(toCopper('8 gp 0 sp 0 cp'), 800)
  assert.equal(toCopper('15 cp'), 15)
  assert.equal(toCopper('1 gp 2 sp'), 120)
})

test('fromCopper breaks a total back down for display', () => {
  assert.deepEqual(fromCopper(785), { gp: 7, sp: 8, cp: 5 })
  assert.deepEqual(fromCopper(0), { gp: 0, sp: 0, cp: 0 })
  assert.deepEqual(fromCopper(99), { gp: 0, sp: 9, cp: 9 })
  assert.deepEqual(fromCopper(100), { gp: 1, sp: 0, cp: 0 })
})

test('a debt renders with a consistent sign, never mixed', () => {
  // Mixed signs would be indistinguishable from a real purse at a glance.
  // `-0` is normalized to `0`, since "-0 gp" reads as a bug.
  assert.deepEqual(fromCopper(-15), { gp: 0, sp: -1, cp: -5 })
  assert.equal(toCopper(fromCopper(-15)), -15)
  assert.ok(!Object.is(fromCopper(-15).gp, -0), 'negative zero must not leak into a denomination')
})

test('formatCurrencyShort omits leading empty units', () => {
  assert.equal(formatCurrencyShort(95), '9 sp 5 cp')
  assert.equal(formatCurrencyShort(7), '7 cp')
  assert.equal(formatCurrencyShort(785), '7 gp 8 sp 5 cp')
  assert.equal(formatCurrencyShort(0), '0 cp')
  assert.equal(formatCurrencyShort(100), '1 gp')
})

test('toCopper and fromCopper are inverse', () => {
  for (const total of [0, 1, 9, 10, 99, 100, 785, 99999]) {
    assert.equal(toCopper(fromCopper(total)), total)
  }
})

test('parseCurrency handles every denomination', () => {
  assert.equal(parseCurrency('1 pp'), 1000)
  assert.equal(parseCurrency('1 gp'), 100)
  assert.equal(parseCurrency('1 ep'), 50)
  assert.equal(parseCurrency('1 sp'), 10)
  assert.equal(parseCurrency('1 cp'), 1)
  assert.equal(parseCurrency('1 gold'), 100)
  assert.equal(parseCurrency('2 silver 3 copper'), 23)
})

test('parseCurrency ignores unknown words rather than zeroing', () => {
  assert.equal(parseCurrency('8 gp or best offer'), 800)
})

test('formatCurrency renders the prose form', () => {
  assert.equal(formatCurrency(785), '7 gp 8 sp 5 cp')
  assert.equal(formatCurrency({ gp: 7, sp: 8, cp: 5 }), '7 gp 8 sp 5 cp')
  assert.equal(formatCurrency(0), '0 gp 0 sp 0 cp')
})

// --- add and spend --------------------------------------------------------
test('addCurrency adds and converts', () => {
  assert.equal(addCurrency(100, 15), 115)
  assert.equal(addCurrency(800, -15), 785)
})

test('addCurrency accepts a denomination triple', () => {
  assert.equal(addCurrency(100, { sp: 15 }), 250)
})

test('spending everything leaves nothing', () => {
  const { total, affordable } = spendCurrency(100, 100)
  assert.equal(total, 0)
  assert.equal(affordable, true)
})

test('an unaffordable spend reports the shortfall', () => {
  const { total, affordable, shortfall, shortfallText } = spendCurrency(5, 100)
  assert.equal(affordable, false, 'the caller refuses; this function only reports')
  assert.equal(total, -95, 'the arithmetic is still available to explain by how much')
  assert.equal(shortfall, 95)
  assert.equal(shortfallText, '9 sp 5 cp')
})

test('a spend is judged on the total, not on any one denomination', () => {
  // 800 cp is 8 gp; paying 15 cp is trivially affordable even though the
  // character holds no copper pieces at all.
  assert.equal(spendCurrency(800, 15).affordable, true)
})

// --- validation -----------------------------------------------------------
const base = () => normalizeState({
  name: 'Alice',
  identity: { level: 1 },
  abilities: { STR: 8, DEX: 14, CON: 15, INT: 17, WIS: 10, CHA: 10 },
  combat: { hp: { current: 8, max: 8 }, tempHp: 0 },
  spellSlots: { 1: { total: 2, used: 0 } },
  currency: 800,
})

test('a healthy character produces no findings', () => {
  assert.deepEqual(validateState(base()), [])
})

test('HP above maximum is an error', () => {
  const s = base()
  s.combat.hp.current = 12
  const f = validateState(s)
  assert.ok(hasErrors(f), JSON.stringify(f))
  assert.ok(f.some((x) => x.field === 'combat.hp.current'))
})

test('negative HP is an error, and 0 is only a warning', () => {
  const dying = base(); dying.combat.hp.current = 0
  const dyingF = validateState(dying)
  assert.ok(!hasErrors(dyingF), 'unconscious and dying is a legitimate state')
  assert.ok(dyingF.some((x) => x.field === 'combat.hp.current' && x.level === 'warn'))

  const negative = base(); negative.combat.hp.current = -4
  assert.ok(hasErrors(validateState(negative)), 'HP below 0 cannot exist')
})

test('expending more slots than exist is an error', () => {
  const s = base()
  s.spellSlots = { 1: { total: 2, used: 3 } }
  const f = validateState(s)
  assert.ok(hasErrors(f), JSON.stringify(f))
  assert.ok(f.some((x) => x.field === 'spellSlots.1.used'))
})

test('a negative slot count is an error', () => {
  const s = base()
  s.spellSlots = { 1: { total: 2, used: -1 } }
  assert.ok(hasErrors(validateState(s)))
})

test('slot levels outside 1-9 warn', () => {
  const s = base()
  s.spellSlots = { 12: { total: 1, used: 0 } }
  const f = validateState(s)
  assert.ok(f.some((x) => x.field === 'spellSlots.12' && x.level === 'warn'), JSON.stringify(f))
})

test('a negative purse total is an error', () => {
  const s = base()
  s.currency = -15
  const f = validateState(s)
  assert.ok(hasErrors(f), JSON.stringify(f))
  assert.match(f.find((x) => x.field === 'currency').message, /negative coin/)
})

test('the refusal message explains the rule, not just the value', () => {
  const s = base()
  s.currency = -15
  const message = validateState(s).find((x) => x.field === 'currency').message
  assert.match(message, /refused/, 'it should say what happens instead of a debt')
})

test('a healthy purse produces no finding at all', () => {
  // There is no "not canonical" state for a single integer, which is the whole
  // reason for storing one.
  const s = base()
  s.currency = 785
  assert.deepEqual(validateState(s).filter((f) => f.field === 'currency'), [])
})

test('a non-numeric currency warns', () => {
  const s = base()
  s.currency = 'lots'
  assert.ok(validateState(s).some((x) => x.field === 'currency' && x.level === 'warn'))
})

test('an ability score outside 1-30 warns', () => {
  const s = base()
  s.abilities = { ...s.abilities, STR: 42 }
  assert.ok(validateState(s).some((x) => x.field === 'abilities.STR' && x.level === 'warn'))
})

test('a character level outside 1-20 warns', () => {
  const s = base()
  s.identity.level = 25
  assert.ok(validateState(s).some((x) => x.field === 'identity.level'))
})

test('a negative item quantity is an error', () => {
  const s = base()
  s.equipment = { weapons: { Dagger: -1 }, armour: {}, gear: {} }
  assert.ok(hasErrors(validateState(s)))
})

test('validation never mutates the state it is given', () => {
  const s = base()
  s.currency = { gp: 8, sp: 0, cp: -15 }
  const snapshot = JSON.stringify(s)
  validateState(s)
  assert.equal(JSON.stringify(s), snapshot, 'a check must not repair what it finds')
})

test('formatFindings labels errors and warnings', () => {
  const lines = formatFindings([
    { field: 'a', level: 'error', message: 'bad' },
    { field: 'b', level: 'warn', message: 'iffy' },
  ])
  assert.equal(lines[0], 'ERROR a: bad')
  assert.equal(lines[1], 'warn b: iffy')
})

test('a null state reports rather than throws', () => {
  assert.ok(validateState(null).length > 0)
})

console.log('')
if (failures > 0) {
  console.error(`state-rules.test.mjs: ${failures} failure(s)`)
  process.exit(1)
}
console.log('state-rules.test.mjs: all assertions passed')
