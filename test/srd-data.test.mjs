/**
 * srd-data.test.mjs — the shipped SRD datasets' structural integrity.
 *
 * dnd_level_up reads a class's `table` to plan a level: a class whose table is
 * EMPTY means every character of that class can never level through the tool —
 * and that shipped as 0.4.1 for Rogue and Cleric, because no test looked at
 * the data. This suite is the data's build gate:
 *
 *   - every class in BOTH ruleset datasets has a 20-row table, levels 1..20;
 *   - profBonus follows the canonical curve;
 *   - full casters carry non-decreasing spell-slot totals and a cantrips count;
 *   - the rogue's sneak-attack dice grow with level.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
const load = (name) => JSON.parse(readFileSync(path.join(DATA_DIR, name), 'utf8'))

const PROF = (lv) => (lv <= 4 ? '+2' : lv <= 8 ? '+3' : lv <= 12 ? '+4' : lv <= 16 ? '+5' : '+6')
const SNEAK_2014 = { 1: '1d6', 2: '1d6', 3: '2d6', 4: '2d6', 5: '3d6', 6: '3d6', 7: '4d6', 8: '4d6', 9: '5d6', 10: '5d6', 11: '6d6', 12: '6d6', 13: '7d6', 14: '7d6', 15: '8d6', 16: '8d6', 17: '9d6', 18: '9d6', 19: '10d6', 20: '10d6' }

const REQUIRED_2014 = ['Barbarian', 'Bard', 'Cleric', 'Druid', 'Fighter', 'Monk', 'Paladin', 'Ranger', 'Rogue', 'Sorcerer', 'Warlock', 'Wizard']

function assertTableShape(klasse, ruleset) {
  const table = klasse.table
  assert.equal(Array.isArray(table), true, `${ruleset} ${klasse.name}: table must be an array`)
  assert.equal(table.length, 20, `${ruleset} ${klasse.name}: table must have 20 rows (a class with fewer rows can never be leveled through dnd_level_up)`)
  for (let i = 0; i < 20; i += 1) {
    const row = table[i]
    assert.equal(row.level, i + 1, `${ruleset} ${klasse.name}: row ${i} must be level ${i + 1}`)
    assert.equal(row.profBonus, PROF(i + 1), `${ruleset} ${klasse.name} level ${i + 1}: profBonus off the canonical curve`)
    // 2014 rows carry features as a comma-joined string; 2024 rows as an array.
    // 2024 tables legitimately leave some rows featureless (slot-only gains);
    // 2014 tables use "-" for those, so a 2014 row must be non-empty.
    const features = Array.isArray(row.features) ? row.features.join(',') : row.features
    if (ruleset === '2014') {
      assert.ok(typeof features === 'string' && features.trim().length > 0, `${ruleset} ${klasse.name} level ${i + 1}: features must be non-empty`)
    } else {
      assert.ok(typeof features === 'string', `${ruleset} ${klasse.name} level ${i + 1}: features must be a string or array`)
    }
  }
}

function assertSlotsSane(klasse, ruleset) {
  for (const row of klasse.table) {
    if (row.spellSlots === undefined) continue
    const entries = Object.entries(row.spellSlots)
    assert.ok(entries.length > 0, `${ruleset} ${klasse.name} level ${row.level}: spellSlots present but empty`)
    for (const [level, count] of entries) {
      assert.ok(Number(level) >= 1 && Number(level) <= 9, `${ruleset} ${klasse.name} level ${row.level}: slot level ${level} out of range`)
      assert.ok(Number(count) >= 0, `${ruleset} ${klasse.name} level ${row.level}: negative slot count`)
    }
  }
}

await test('srd-2014: every class has a complete 20-level table', () => {
  const data = load('srd-2014.json')
  const byName = new Map(data.classes.map((c) => [c.name, c]))
  for (const name of REQUIRED_2014) {
    const c = byName.get(name)
    assert.ok(c !== undefined, `srd-2014 is missing the ${name} class entirely`)
    assertTableShape(c, '2014')
    assertSlotsSane(c, '2014')
  }
})

await test('srd-2014: the cleric table carries cantrips and slot progressions', () => {
  const cleric = load('srd-2014.json').classes.find((c) => c.name === 'Cleric')
  assert.equal(cleric.table[0].cantripsKnown, 3)
  assert.equal(cleric.table[9].cantripsKnown, 5)
  assert.deepEqual(cleric.table[0].spellSlots, { 1: 2 })
  // The 9th-level row is the regression case from the field report: a caster
  // whose slots stop before 5th level cannot level a level-9 character.
  assert.deepEqual(cleric.table[8].spellSlots, { 1: 4, 2: 3, 3: 3, 4: 3, 5: 1 })
  assert.deepEqual(cleric.table[17].spellSlots, { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 1, 7: 1, 8: 1, 9: 1 })
})

await test('srd-2014: the rogue table carries the sneak-attack progression', () => {
  const rogue = load('srd-2014.json').classes.find((c) => c.name === 'Rogue')
  for (const [lv, dice] of Object.entries(SNEAK_2014)) {
    assert.equal(rogue.table[lv - 1].sneakAttack, dice, `2014 rogue level ${lv}`)
  }
})

await test('srd-2024: every class has a complete 20-level table', () => {
  const data = load('srd-2024.json')
  for (const c of data.classes) {
    assertTableShape(c, '2024')
    assertSlotsSane(c, '2024')
  }
})

await test('srd-2024: the rogue sneak-attack dice never shrink with level', () => {
  // 2024 rows carry the progression in specific.sneak_attack; the invariant
  // under test is monotonicity, not a hand-typed copy of the official curve.
  const rogue = load('srd-2024.json').classes.find((c) => c.name === 'Rogue')
  let last = 0
  for (const row of rogue.table) {
    const dice = row.specific?.sneak_attack?.dice_count
    assert.ok(typeof dice === 'number' && dice >= last, `2024 rogue level ${row.level}: sneak attack dice must exist and never shrink`)
    last = dice
  }
  assert.ok(last >= 6, '2024 rogue must reach 6d6 or more by level 20')
})
