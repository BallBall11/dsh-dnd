// parse.test.mjs — regression test for parseCharacterSheet (bundled parser).
// Run: node test/parse.test.mjs  (exits non-zero on failure)
import assert from 'node:assert/strict'
import { parseCharacterSheet } from '../src/host/dnd-sheet.mjs'

const SAMPLE = `# Alice
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

const c = parseCharacterSheet(SAMPLE)
assert.equal(c.name, 'Alice')
assert.equal(c.race, 'High Elf (Elf)')
assert.equal(c.klass, 'Wizard')
assert.equal(c.level, 1)
assert.equal(c.xp, '0')
assert.equal(c.xpNext, '300')
assert.deepEqual(c.hitPoints, { current: 8, max: 8 })
assert.equal(c.tempHp, 0)
assert.equal(c.ac, 12)
assert.equal(c.mageArmorAc, 15)
assert.equal(c.initiative, '+2')
assert.equal(c.speed, 30)
assert.equal(c.hitDice, '1d6 (remaining: 1)')
assert.deepEqual(c.deathSaves, { success: 0, fail: 0 })
assert.equal(c.abilityScores.INT, '16')
assert.equal(c.skills.length, 2)
assert.equal(c.skills[0].name, 'Arcana')
assert.equal(c.skills[0].proficient, true)
assert.equal(c.attacks.length, 2)
assert.equal(c.attacks[0].name, '电爪 Shocking Grasp')
assert.equal(c.attacks[0].bonus, '+5')
assert.equal(c.spellSaveDC, 13)
assert.equal(c.spellAttack, '+5')
assert.deepEqual(c.spellSlots, { level: 1, total: 2, used: 1 })
assert.equal(c.cantrips, 'fire bolt, light, mage hand')
assert.equal(c.currency, '30 gp, 10 sp')

console.log('parse.test.mjs: all assertions passed')
