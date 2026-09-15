/**
 * sheet-parse.test.mjs — regression suite for the character sheet parser.
 *
 * The first case is the bug that motivated the rewrite: v0.1.0 matched only the
 * first spell-slot row, so a multi-circle caster silently parsed as a
 * single-circle one. That assertion would have failed against the old parser.
 */
import assert from 'node:assert/strict'
import { parseCharacterSheet, formatCharacter, PARSE_VERSION } from '../src/host/tools/sheet-parse.mjs'

let failures = 0
function test(name, fn) {
  try {
    fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failures += 1
    console.error('  FAIL ' + name)
    console.error('       ' + error.message)
  }
}

// --- single-circle caster (the v0.1.0 happy path, must keep working) -------
const ALICE = `# Alice
## Identity
- **Race:** High Elf (Elf) | **Class:** Wizard | **Level:** 1 | **Background:** Sage
- **Alignment:** n | **XP:** 0 / 300
## Ability Scores
| STR | DEX | CON | INT | WIS | CHA |
|-----|-----|-----|-----|-----|-----|
| 8 | 14 | 13 | 16 | 12 | 10 |
## Combat Stats
- **HP:** 8 / 8 | **Temp HP:** 0
- **AC:** 12 (Mage Armor: 15) | **Initiative:** +2 | **Speed:** 30
- **Hit Dice:** 1d6 (remaining: 1)
- **Death Saves:** Successes: 0 | Failures: 0
## Skills
| Skill | Ability | Bonus | Proficient |
| --- | --- | --- | --- |
| Arcana | INT | +5 | ✓ |
| Perception | WIS | +1 | — |
## Attacks
| Name | To Hit | Damage | Type |
| --- | --- | --- | --- |
| 电爪 Shocking Grasp | +5 | 1d8 | melee |
| Dagger | +4 | 1d4+2 | melee |
## Known Spells
**Spell save DC:** 13 | **Spell attack:** +5
| Slot | Total | Used |
| --- | --- | --- |
| 1st | 2 | 1 |
**Cantrips:** fire bolt, light, mage hand
**Prepared:** mage armor, shield
**Currency:** 30 gp, 10 sp
`

console.log('sheet parser:')

test('parses identity, HP, AC, abilities', () => {
  const c = parseCharacterSheet(ALICE)
  assert.equal(c.parseVersion, PARSE_VERSION)
  assert.equal(c.name, 'Alice')
  assert.equal(c.race, 'High Elf (Elf)')
  assert.equal(c.klass, 'Wizard')
  assert.equal(c.level, 1)
  assert.equal(c.background, 'Sage')
  assert.deepEqual(c.hitPoints, { current: 8, max: 8 })
  assert.equal(c.ac, 12)
  assert.equal(c.mageArmorAc, 15)
  assert.equal(c.initiative, '+2')
  assert.equal(c.speed, 30)
  assert.equal(c.abilityScores.INT.score, 16)
  assert.equal(c.xp, '0')
  assert.equal(c.xpNext, '300')
})

test('parses skills and attacks', () => {
  const c = parseCharacterSheet(ALICE)
  assert.equal(c.skills.length, 2)
  assert.equal(c.skills[0].name, 'Arcana')
  assert.equal(c.skills[0].proficient, true)
  assert.equal(c.skills[1].proficient, false)
  assert.equal(c.attacks.length, 2)
  assert.equal(c.attacks[0].name, '电爪 Shocking Grasp')
  assert.equal(c.attacks[0].bonus, '+5')
})

test('parses a single spell-slot row', () => {
  const c = parseCharacterSheet(ALICE)
  assert.deepEqual(c.spellSlots, { level: 1, total: 2, used: 1 })
  assert.deepEqual(c.spellSlotsByLevel, { 1: { total: 2, used: 1 } })
  assert.equal(c.spellSaveDC, 13)
  assert.equal(c.spellAttack, '+5')
})

test('reports no warnings for a complete sheet', () => {
  assert.deepEqual(parseCharacterSheet(ALICE).warnings, [])
})

// --- THE BUG: multi-circle caster -----------------------------------------
// v0.1.0's regex was /\|\s*([0-9]+)st\s*\|.../ — first match only. This sheet
// would have parsed as spellSlots { level: 1, total: 4, used: 1 } and the
// 2nd/3rd circles would have vanished with no warning.
const MAGE = `# Magus
## Identity
- **Race:** Human | **Class:** Wizard | **Level:** 9 | **Background:** Sage
## Ability Scores
| STR | DEX | CON | INT | WIS | CHA |
|-----|-----|-----|-----|-----|-----|
| 8 | 14 | 12 | 20 | 12 | 10 |
## Combat Stats
- **HP:** 48 / 48 | **Temp HP:** 0
- **AC:** 15 | **Initiative:** +2 | **Speed:** 30
- **Death Saves:** Successes: 0 | Failures: 0
## Known Spells
**Spell save DC:** 17 | **Spell attack:** +9
| Slot | Total | Used |
| --- | --- | --- |
| 1st | 4 | 1 |
| 2nd | 3 | 2 |
| 3rd | 3 | 0 |
| 4th | 2 | 1 |
`

test('parses EVERY spell-slot row, not just the first (v0.1.0 regression)', () => {
  const c = parseCharacterSheet(MAGE)
  assert.deepEqual(c.spellSlotsByLevel, {
    1: { total: 4, used: 1 },
    2: { total: 3, used: 2 },
    3: { total: 3, used: 0 },
    4: { total: 2, used: 1 },
  }, 'all four circles must survive parsing')
  // `spellSlots` keeps the lowest circle for v0.1.0 consumers.
  assert.deepEqual(c.spellSlots, { level: 1, total: 4, used: 1 })
})

test('renders all circles in the card', () => {
  const card = formatCharacter(parseCharacterSheet(MAGE))
  assert.ok(card.includes('1st 3/4'), 'expected consumed 1st-level slots: ' + card)
  assert.ok(card.includes('2nd 1/3'), 'expected 2nd circle: ' + card)
  assert.ok(card.includes('3rd 3/3'), 'expected 3rd circle: ' + card)
  assert.ok(card.includes('4th 1/2'), 'expected 4th circle: ' + card)
})

// --- prose slot form ------------------------------------------------------
test('parses the compact prose slot form', () => {
  const c = parseCharacterSheet(`# P
## Combat Stats
- **HP:** 10 / 10
## Spells
**Spell Slots:** 1st: 3/1, 2nd: 2/0
`)
  assert.deepEqual(c.spellSlotsByLevel, { 1: { total: 3, used: 1 }, 2: { total: 2, used: 0 } })
})

// --- the header wording used by the REAL sheet ---------------------------
// campaigns/morgansfort/characters/alice.md heads its table `| Level |` while
// the skill's own template uses `| Slot |`. Keying on one of them meant the
// parser silently returned zero slots for a real character. Both must work.
test('parses a `| Level |` slot header (the real morgansfort sheet)', () => {
  const c = parseCharacterSheet(`# A
## Combat Stats
- **HP:** 8 / 8
## Spell Slots (if applicable)
| Level | Total | Used |
|-------|-------|------|
| 1st | 2 | 0 |
`)
  assert.deepEqual(c.spellSlotsByLevel, { 1: { total: 2, used: 0 } })
})

test('parses a `| Slot |` slot header (the skill template)', () => {
  const c = parseCharacterSheet(`# A
## Combat Stats
- **HP:** 8 / 8
| Slot | Total | Used |
| --- | --- | --- |
| 1st | 3 | 1 |
| 2nd | 2 | 0 |
`)
  assert.deepEqual(c.spellSlotsByLevel, { 1: { total: 3, used: 1 }, 2: { total: 2, used: 0 } })
})

// --- ability cells carry their modifier -----------------------------------
test('parses `17 (+3)` ability cells into score + modifier', () => {
  const c = parseCharacterSheet(`# A
## Ability Scores
| STR | DEX | CON | INT | WIS | CHA |
|-----|-----|-----|-----|-----|-----|
| 8 (-1) | 14 (+2) | 15 (+2) | 17 (+3) | 10 (+0) | 10 (+0) |
`)
  assert.equal(c.abilityScores.INT.score, 17)
  assert.equal(c.abilityScores.INT.modifier, 3)
  assert.equal(c.abilityScores.INT.raw, '17 (+3)')
  assert.equal(c.abilityScores.STR.score, 8)
  assert.equal(c.abilityScores.STR.modifier, -1)
})

test('parses bare ability cells', () => {
  const c = parseCharacterSheet(`# A
## Ability Scores
| STR | DEX | CON | INT | WIS | CHA |
|-----|-----|-----|-----|-----|-----|
| 8 | 14 | 13 | 16 | 12 | 10 |
`)
  assert.equal(c.abilityScores.INT.score, 16)
  assert.equal(c.abilityScores.INT.modifier, null)
})

test('renders ability scores with modifiers in the card', () => {
  const card = formatCharacter(parseCharacterSheet(`# A
## Combat Stats
- **HP:** 8 / 8
## Ability Scores
| STR | DEX | CON | INT | WIS | CHA |
|-----|-----|-----|-----|-----|-----|
| 8 (-1) | 14 (+2) | 15 (+2) | 17 (+3) | 10 (+0) | 10 (+0) |
`))
  assert.ok(card.includes('INT 17 (+3)'), card)
  assert.ok(card.includes('STR 8 (-1)'), card)
})

// --- degraded sheets warn instead of silently returning null --------------
test('an empty sheet warns rather than throwing', () => {
  const c = parseCharacterSheet('')
  assert.equal(c.hitPoints, null)
  assert.ok(c.warnings.length >= 2, 'expected warnings, got ' + JSON.stringify(c.warnings))
  assert.ok(c.warnings.some((w) => w.includes('Combat Stats')))
  assert.ok(c.warnings.some((w) => w.includes('ability-score')))
})

test('a sheet with Combat Stats but no HP line warns specifically', () => {
  const c = parseCharacterSheet(`# X
## Combat Stats
- **AC:** 14
## Ability Scores
| STR | DEX | CON | INT | WIS | CHA |
| --- | --- | --- | --- | --- | --- |
| 10 | 10 | 10 | 10 | 10 | 10 |
`)
  assert.equal(c.hitPoints, null)
  assert.ok(c.warnings.some((w) => w.includes('HP')), 'expected an HP warning: ' + JSON.stringify(c.warnings))
})

test('handles a non-numeric Level without producing NaN', () => {
  const c = parseCharacterSheet(`# Y
- **Race:** Elf | **Class:** Rogue | **Level:** pending
`)
  assert.equal(c.level, null)
  assert.ok(c.warnings.some((w) => w.includes('Level')))
})

test('reads inspiration state', () => {
  const withInspiration = parseCharacterSheet(`# Z
## Combat Stats
- **HP:** 5 / 5
- **Inspiration:** Yes
`)
  assert.equal(withInspiration.inspiration, true)
  const without = parseCharacterSheet(`# Z
## Combat Stats
- **HP:** 5 / 5
`)
  assert.equal(without.inspiration, false)
})

test('parses death saves', () => {
  const c = parseCharacterSheet(`# D
## Combat Stats
- **HP:** 0 / 20
- **Death Saves:** Successes: 2 | Failures: 1
`)
  assert.deepEqual(c.deathSaves, { success: 2, fail: 1 })
})

// --- the real sheet, read from disk --------------------------------------
// The synthetic fixtures above each matched a shape the code already handled.
// This one parses the actual campaign file, so a parser that disagrees with
// the real data fails here rather than in front of the DM mid-session.
// Read-only: nothing is ever written back.
import { readFileSync, existsSync } from 'node:fs'
const REAL_SHEET = 'D:/DND/campaigns/morgansfort/characters/alice.md'

if (existsSync(REAL_SHEET)) {
  const real = parseCharacterSheet(readFileSync(REAL_SHEET, 'utf8'))

  test('parses the real morgansfort/alice.md', () => {
    assert.equal(real.name, 'Alice')
    assert.equal(real.klass, 'Wizard')
    assert.equal(real.level, 1)
    assert.deepEqual(real.hitPoints, { current: 8, max: 8 })
    assert.equal(real.ac, 12)
    assert.equal(real.mageArmorAc, 15)
    assert.deepEqual(real.warnings, [], 'the real sheet must parse cleanly: ' + JSON.stringify(real.warnings))
  })

  test('the real sheet yields its spell slots', () => {
    assert.deepEqual(real.spellSlotsByLevel, { 1: { total: 2, used: 0 } })
    assert.equal(real.spellSaveDC, 13)
    assert.equal(real.spellAttack, '+5')
  })

  test('the real sheet yields ability scores with modifiers', () => {
    assert.equal(real.abilityScores.INT.score, 17)
    assert.equal(real.abilityScores.INT.modifier, 3)
    assert.equal(real.abilityScores.CON.score, 15)
  })

  test('the real sheet yields its 18 skills and 3 proficiencies', () => {
    assert.equal(real.skills.length, 18)
    const proficient = real.skills.filter((s) => s.proficient).map((s) => s.name).sort()
    assert.deepEqual(proficient, ['Arcana', 'History', 'Perception'])
  })

  test('the real sheet yields its attacks', () => {
    assert.equal(real.attacks.length, 2)
    assert.ok(real.attacks.some((a) => a.name.includes('Shocking Grasp')), JSON.stringify(real.attacks))
    assert.ok(real.attacks.every((a) => a.bonus === '+5'), JSON.stringify(real.attacks))
  })

  test('the real sheet yields currency and cantrips', () => {
    assert.match(real.currency, /8 gp/, real.currency)
    assert.match(real.cantrips, /Light/, real.cantrips)
  })
} else {
  console.log('  skip real morgansfort/alice.md (not present)')
}

console.log('')
if (failures > 0) {
  console.error(`sheet-parse.test.mjs: ${failures} failure(s)`)
  process.exit(1)
}
console.log('sheet-parse.test.mjs: all assertions passed')
