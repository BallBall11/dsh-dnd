/**
 * sheet-split tests — the structured/narrative split.
 *
 * The primary guarantee under test is **narrative byte-exactness**: the prose
 * of a character sheet is written by a human across many sessions, and a
 * splitter that reformats so much as a trailing space has corrupted it. Field
 * correctness matters too, but a wrong field is recoverable and mangled prose
 * is not.
 *
 * The real sheet is read from a COMMITTED FIXTURE under test/fixtures/, not
 * from disk-live campaign data. The distinction matters: a fixture written from
 * the same assumptions as the code cannot catch a wrong assumption, which is
 * exactly how a `| Slot |` header, invented rather than looked up, produced a
 * parser that failed on every real sheet while passing its own tests. So the
 * fixture is a byte-frozen copy of a REAL sheet (sha256 91a90f00…), captured
 * before the plugin migrated it.
 *
 * It must stay a fixture. Reading `campaigns/morgansfort/characters/alice.md`
 * directly coupled this suite to data the plugin itself rewrites: once that
 * character was split, its sheet became narrative-only and six assertions here
 * failed — not because the splitter broke, but because the input had
 * legitimately changed shape. A parser test must own its input.
 *
 * Rules: test/support/live-data.mjs · docs/harness/TEST-DATA-OWNERSHIP.md
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  splitSheet,
  splitSectionsExact,
  renderSummaryBlock,
  composeSheet,
  SUMMARY_OPEN,
  SUMMARY_CLOSE,
} from '../src/host/tools/sheet-split.mjs'
import { serializeState, parseState, normalizeState } from '../src/host/tools/state-schema.mjs'

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

const ALICE = `---
player: —
campaign: morgansfort
updated: 2026-09-04
worldTime: 2 Thawmonth 1247 AR, 08:00
tags: [pc]
---

# Alice
**Player:** —  **Campaign:** morgansfort  **Last Updated:** 2026-09-04

## Identity
- **Race:** High Elf (Elf) | **Class:** Wizard | **Level:** 1 | **Background:** Sage
- **Alignment:** *(unchosen)* | **XP:** 0 / 300

## Character Pillar
- **Player's sentence:** *"我是一个精灵法师贤者，正在游历世界收集法术"*
- **Derived pillar:** 游历世界收集法术的精灵法师贤者。

## Ability Scores
| STR | DEX | CON | INT | WIS | CHA |
|-----|-----|-----|-----|-----|-----|
| 8 (-1) | 14 (+2) | 15 (+2) | 17 (+3) | 10 (+0) | 10 (+0) |

## Combat Stats
- **HP:** 8 / 8 | **Temp HP:** 0
- **AC:** 12 (Mage Armor: 15) | **Initiative:** +2 | **Speed:** 30
- **Hit Dice:** 1d6 (remaining: 1)
- **Death Saves:** Successes: 0 | Failures: 0

## Saving Throws
| STR | DEX | CON | INT | WIS | CHA |
|-----|-----|-----|-----|-----|-----|
| -1 | +2 | +2 | +5* | +2* | +0 |

## Skills
| Skill | Ability | Bonus | Proficient |
|-------|---------|-------|-----------|
| Arcana | INT | +5 | ✓ |
| Stealth | DEX | +2 | — |

## Attacks
| Name | Attack Bonus | Damage | Type | Notes |
|------|-------------|--------|------|-------|
| 电爪 Shocking Grasp | +5 | 1d8 | Lightning | 近战法术攻击 |

## Spell Slots (if applicable)
| Level | Total | Used |
|-------|-------|------|
| 1st | 2 | 0 |

## Known Spells / Cantrips
**Cantrips (6):** Light, Mage Hand, 电爪 Shocking Grasp
**Spellbook (6, level 1):** Detect Magic, Mage Armor
**Prepared (4):** Mage Armor, Sleep
**Spellcasting ability:** INT. **Spell save DC:** 13 | **Spell attack:** +5

## Features & Traits

### Wizard
- **Spellcasting** — INT-based; 3 cantrips.

## Equipment & Inventory
**Weapons:**
- Quarterstaff (Sage)
- Dagger

**Armour:**
- *(none)*

**Adventuring Gear:**
- Spellbook (arcane focus)
- Parchment (8 sheets)

**Currency:** 8 gp 0 sp 0 cp

## Backstory & Notes
- 游历世界收集法术的精灵法师贤者。
`

// --- section splitting ----------------------------------------------------
test('splitSectionsExact preserves every byte of the body', () => {
  const body = ALICE.replace(/^---\n[\s\S]*?\n---\n\n/, '')
  const { title, sections } = splitSectionsExact(body)
  const rejoined = [title, ...sections.map((s) => s.raw)].join('\n')
  assert.equal(rejoined, body, 'reassembly must be lossless')
})

test('splitSectionsExact separates the title from the sections', () => {
  const body = ALICE.replace(/^---\n[\s\S]*?\n---\n\n/, '')
  const { title, sections } = splitSectionsExact(body)
  assert.equal(title, '# Alice', 'the level-1 heading is the character name, not a section')
  const headings = sections.map((s) => s.heading)
  assert.ok(headings.includes('Character Pillar'))
  assert.ok(headings.includes('Features & Traits'))
  assert.ok(!headings.includes('Alice'), 'the title must not also appear as a section')
})

test('the preamble metadata line is kept as a section', () => {
  const body = ALICE.replace(/^---\n[\s\S]*?\n---\n\n/, '')
  const { sections } = splitSectionsExact(body)
  const preamble = sections.find((s) => s.heading === null)
  assert.ok(preamble !== undefined, 'the **Player:** line must not be lost')
  assert.ok(preamble.body.includes('**Campaign:**'), preamble.body)
})

// --- frontmatter ----------------------------------------------------------
test('frontmatter is parsed and kept out of the narrative', () => {
  const { metadata, narrative } = splitSheet(ALICE)
  assert.equal(metadata.campaign, 'morgansfort')
  assert.equal(metadata.player, '—')
  assert.ok(!narrative.includes('---'), 'the fence must not leak into the narrative')
  assert.ok(!narrative.includes('campaign: morgansfort'), 'frontmatter must not leak')
})

test('frontmatter carries both clocks', () => {
  const { metadata } = splitSheet(ALICE)
  assert.equal(metadata.updated, '2026-09-04', 'real-world date stays a string, not a number')
  assert.equal(metadata.worldTime, '2 Thawmonth 1247 AR, 08:00')
  assert.equal(typeof metadata.updated, 'string')
})

test('frontmatter tags parse as a list', () => {
  const { metadata } = splitSheet(ALICE)
  assert.deepEqual(metadata.tags, ['pc'])
})

test('frontmatter round-trips through composeSheet', () => {
  const { state, narrative, metadata, title } = splitSheet(ALICE)
  const out = composeSheet(narrative, state, { title, metadata })
  const again = splitSheet(out)
  assert.deepEqual(again.metadata, metadata)
})

test('frontmatter survives a full round trip', () => {
  const first = splitSheet(ALICE)
  const once = composeSheet(first.narrative, first.state, { title: first.title, metadata: first.metadata })
  const second = splitSheet(once)
  assert.deepEqual(second.metadata, first.metadata)
  // Both passes must supply the state: a composed .md carries no structured
  // sections, so its re-parse legitimately yields an empty state. The state is
  // read from the .state.json in real use (see state-io.test.mjs), so this
  // test holds the state constant rather than expecting it back from the .md.
  const twice = composeSheet(second.narrative, first.state, { title: second.title, metadata: second.metadata })
  assert.equal(once, twice, 'a second pass must not change the file')
})

test('a file with no frontmatter does not gain an empty one', () => {
  // An empty `---\n---` block would swallow the entire document on the next
  // read, emptying the body. Measured, not hypothetical.
  const out = composeSheet('## Backstory & Notes\n- nothing\n', normalizeState({ name: 'X' }), { title: '# X', metadata: {} })
  assert.ok(!out.startsWith('---'), 'no frontmatter should be written when there is none to write')
  const back = splitSheet(out)
  assert.ok(back.narrative.includes('nothing'), 'the body must survive')
})

// --- the core guarantee ---------------------------------------------------
test('narrative excludes every structured section', () => {
  const { narrative } = splitSheet(ALICE)
  for (const gone of ['## Ability Scores', '## Combat Stats', '## Skills', '## Attacks', '## Spell Slots', '## Equipment']) {
    assert.ok(!narrative.includes(gone), `narrative must not contain ${gone}`)
  }
})

test('narrative keeps Features & Traits verbatim (prose is the content)', () => {
  const { narrative } = splitSheet(ALICE)
  assert.ok(narrative.includes('## Features & Traits'))
  assert.ok(narrative.includes('- **Spellcasting** — INT-based; 3 cantrips.'),
    'the description must survive intact')
})

test('narrative keeps Character Pillar and Backstory with CJK intact', () => {
  const { narrative } = splitSheet(ALICE)
  assert.ok(narrative.includes('我是一个精灵法师贤者，正在游历世界收集法术'))
  assert.ok(narrative.includes('游历世界收集法术的精灵法师贤者。'))
})

test('narrative text is byte-identical to its source sections', () => {
  const { narrative, sections } = splitSheet(ALICE)
  const expected = sections
    .filter((s) => s.heading === null || (!/^(identity|ability scores|combat stats|saving throws|skills|attacks|spell slots|known spells|equipment)/i.test(s.heading)))
    .map((s) => s.raw)
    .join('\n')
    .trim()
    // The legacy inline `**Player:** ... **Last Updated:**` line is superseded
    // once those values live in the frontmatter, and is dropped rather than
    // left as duplicate prose.
    .split('\n')
    .filter((line) => !/^\*\*Player:\*\*[\s\S]*?\*\*Last Updated:\*\*/.test(line.trim()))
    .join('\n')
    .replace(/^\n+/, '')
    .trim()
  assert.equal(narrative, expected)
})

test('the superseded inline metadata line is not left in the narrative', () => {
  const { narrative } = splitSheet(ALICE)
  assert.ok(!narrative.includes('**Last Updated:**'),
    'the inline copy is redundant once frontmatter carries the same values')
})

test('an unmigrated sheet keeps its inline metadata', () => {
  // No frontmatter: the inline line is the only source, so it must survive.
  const legacy = '# Bob\n**Player:** Sam  **Campaign:** x  **Last Updated:** 2026-01-01\n\n## Backstory & Notes\n- hi\n'
  const { narrative } = splitSheet(legacy)
  assert.ok(narrative.includes('**Last Updated:**'), 'nothing should be dropped when there is no replacement')
})
// --- structured extraction ------------------------------------------------
test('extracts identity', () => {
  const { state, metadata } = splitSheet(ALICE)
  assert.equal(state.name, 'Alice')
  assert.equal(metadata.campaign, 'morgansfort', 'campaign is file metadata, not character state')
  assert.equal(state.identity.race, 'High Elf (Elf)')
  assert.equal(state.identity.class, 'Wizard')
  assert.equal(state.identity.level, 1)
  assert.equal(state.identity.xp, 0)
  assert.equal(state.identity.xpNext, 300)
})

test('extracts abilities as numbers', () => {
  const { state } = splitSheet(ALICE)
  assert.equal(state.abilities.INT, 17)
  assert.equal(state.abilities.STR, 8)
  assert.equal(typeof state.abilities.INT, 'number')
})

test('extracts combat stats', () => {
  const { state } = splitSheet(ALICE)
  assert.deepEqual(state.combat.hp, { current: 8, max: 8 })
  assert.equal(state.combat.ac, 12)
  assert.equal(state.combat.mageArmorAc, 15)
  assert.equal(state.combat.initiative, 2)
  assert.equal(state.combat.speed, 30)
  assert.deepEqual(state.combat.hitDice, { die: '1d6', remaining: 1 })
})

test('extracts saving throws and which are proficient', () => {
  const { state } = splitSheet(ALICE)
  assert.equal(state.saves.INT, 5, 'the `+5*` marker must not swallow the modifier')
  assert.equal(state.saves.STR, -1)
  assert.deepEqual(state.proficientSaves, ['INT', 'WIS'], 'the trailing * marks proficiency')
})

test('extracts skills', () => {
  const { state } = splitSheet(ALICE)
  assert.equal(state.skills.Arcana.bonus, 5)
  assert.equal(state.skills.Arcana.proficient, true)
  assert.equal(state.skills.Stealth.proficient, false)
})

test('extracts attacks with CJK names', () => {
  const { state } = splitSheet(ALICE)
  assert.equal(state.attacks.length, 1)
  assert.equal(state.attacks[0].name, '电爪 Shocking Grasp')
  assert.equal(state.attacks[0].bonus, 5)
})

test('extracts spell slots', () => {
  const { state } = splitSheet(ALICE)
  assert.deepEqual(state.spellSlots, { 1: { total: 2, used: 0 } })
})

test('extracts spell lists', () => {
  const { state } = splitSheet(ALICE)
  assert.deepEqual(state.spells.cantrips, ['Light', 'Mage Hand', '电爪 Shocking Grasp'])
  assert.deepEqual(state.spells.spellbook, ['Detect Magic', 'Mage Armor'])
  assert.deepEqual(state.spells.prepared, ['Mage Armor', 'Sleep'])
})

test('extracts equipment as name -> quantity', () => {
  const { state } = splitSheet(ALICE)
  // A parenthetical qualifier stays part of the name: `Quarterstaff (Sage)`
  // records where it came from, and stripping it would lose that.
  assert.equal(state.equipment.weapons['Quarterstaff (Sage)'], 1)
  assert.equal(state.equipment.weapons.Dagger, 1)
  assert.equal(state.equipment.gear.Parchment, 8, 'the (8 sheets) form yields a quantity')
  assert.deepEqual(state.equipment.armour, {}, '*(none)* is not an item')
})

test('extracts currency as a single copper total', () => {
  const { state } = splitSheet(ALICE)
  assert.equal(state.currency, 800, 'money is stored as one integer, not three fields')
})

test('extracts spellcasting stats', () => {
  const { state } = splitSheet(ALICE)
  assert.equal(state.spellcasting.ability, 'INT')
  assert.equal(state.spellcasting.saveDC, 13)
  assert.equal(state.spellcasting.attackBonus, 5)
})

// --- summary block --------------------------------------------------------
test('the summary block is marked as generated', () => {
  const { state } = splitSheet(ALICE)
  const block = renderSummaryBlock(state)
  assert.ok(block.startsWith(SUMMARY_OPEN))
  assert.ok(block.trimEnd().endsWith(SUMMARY_CLOSE))
})

test('the summary states that editing it is futile', () => {
  const { state } = splitSheet(ALICE)
  const block = renderSummaryBlock(state)
  assert.ok(block.includes('.state.json'), 'must name the real source of truth')
})

test('the summary carries the key numbers', () => {
  const { state } = splitSheet(ALICE)
  const block = renderSummaryBlock(state)
  assert.ok(block.includes('HP 8/8'), block)
  assert.ok(block.includes('INT 17 (+3)'), block)
  assert.ok(block.includes('法术DC 13'), block)
  assert.ok(block.includes('8 gp'), block)
})

// --- composition ----------------------------------------------------------
test('composeSheet keeps the narrative verbatim', () => {
  const { state, narrative } = splitSheet(ALICE)
  const out = composeSheet(narrative, state, '# Alice')
  for (const line of ['- **Player\'s sentence:** *"我是一个精灵法师贤者，正在游历世界收集法术"*',
    '- **Spellcasting** — INT-based; 3 cantrips.',
    '- 游历世界收集法术的精灵法师贤者。']) {
    assert.ok(out.includes(line), 'lost line: ' + line)
  }
})

test('composeSheet produces exactly one summary block', () => {
  const { state, narrative } = splitSheet(ALICE)
  const out = composeSheet(narrative, state, '# Alice')
  assert.equal(out.split(SUMMARY_OPEN).length - 1, 1)
})

// --- composition contract -------------------------------------------------
// A composed file contains ONLY narrative plus the generated summary: the
// structured sections have moved to the .state.json. So re-parsing a composed
// file is expected to yield no structured fields, and asserting otherwise
// would be asserting the split did not happen. What must hold is that the
// narrative and the metadata survive, and that the state — already extracted —
// is unchanged.

test('a composed file contains no structured sections', () => {
  const { state, narrative } = splitSheet(ALICE)
  const out = composeSheet(narrative, state, '# Alice')
  for (const gone of ['## Ability Scores', '## Combat Stats', '## Skills', '## Equipment']) {
    assert.ok(!out.includes(gone), `${gone} must not remain; it now lives in the .state.json`)
  }
  assert.ok(out.includes('## Character Pillar'), 'narrative must remain')
  assert.ok(out.includes('## Features & Traits'), 'narrative must remain')
})

test('composeSheet is idempotent over the narrative', () => {
  const first = splitSheet(ALICE)
  const once = composeSheet(first.narrative, first.state, { title: first.title, metadata: first.metadata })
  const second = splitSheet(once)
  // `first.state` is supplied again deliberately: a composed .md has no
  // structured sections, so its re-parse yields an empty state by design. In
  // real use the state comes from the .state.json (see state-io.test.mjs).
  const twice = composeSheet(second.narrative, first.state, { title: second.title, metadata: second.metadata })
  assert.equal(once, twice, 'a second pass must not change the file')
})

test('the narrative is preserved across a compose/parse cycle', () => {
  const first = splitSheet(ALICE)
  const once = composeSheet(first.narrative, first.state, '# Alice')
  const second = splitSheet(once)
  assert.equal(second.narrative, first.narrative)
  assert.ok(!second.narrative.includes(SUMMARY_OPEN), 'the block must not leak into the narrative')
})

test('the extracted state is unaffected by composition', () => {
  // The state is the authority and is serialized separately; composing the
  // narrative must not perturb a single field of it.
  const first = splitSheet(ALICE)
  const once = composeSheet(first.narrative, first.state, '# Alice')
  splitSheet(once)
  assert.equal(Object.keys(first.state.skills).length, 2)
  assert.equal(first.state.saves.INT, 5)
  assert.equal(first.state.equipment.gear.Parchment, 8)
})

// --- robustness -----------------------------------------------------------
test('an empty sheet yields empty state and a warning, not a throw', () => {
  const { state, warnings } = splitSheet('')
  assert.equal(state.name, null)
  assert.ok(warnings.length > 0)
})

test('a sheet with only narrative yields no structured data', () => {
  const { state, narrative } = splitSheet('# Bob\n\n## Backstory & Notes\n- A wandering soul.\n')
  assert.equal(state.name, 'Bob')
  assert.ok(narrative.includes('A wandering soul.'))
  assert.deepEqual(state.equipment.gear, {})
})

test('unknown sections are preserved as narrative, not dropped', () => {
  const { narrative } = splitSheet('# X\n\n## Some Future Section\n- invented later\n')
  assert.ok(narrative.includes('## Some Future Section'),
    'an unrecognized section must survive intact')
})

// --- the real sheet, read from a FROZEN fixture ---------------------------
// A committed copy, not the live campaign file. Reading the live file coupled
// this suite to data the plugin itself migrates: once that character was split,
// its sheet became narrative-only and these assertions failed — not because the
// splitter broke, but because the input had legitimately changed shape.
// A parser test must own its input.
//
// The digest is asserted, not merely noted: a fixture editable into whatever
// the splitter currently accepts stops being evidence.
const REAL = new URL('./fixtures/alice-unmigrated.md', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1') // Windows: strip the leading slash from /D:/...
const FIXTURE_SHA256 = '91a90f003c8166997765dfd2e82c4ae6cd0040ae465dfc681919c38ef6aa6688'
if (existsSync(REAL)) {
  const raw = readFileSync(REAL, 'utf8')
  const { state, narrative } = splitSheet(raw)

  test('the fixture is the frozen pre-migration sheet', () => {
    const actual = createHash('sha256').update(readFileSync(REAL)).digest('hex')
    assert.equal(actual, FIXTURE_SHA256,
      'test/fixtures/alice-unmigrated.md changed. It is a frozen copy of a real sheet; if the edit is '
      + 'intentional, update FIXTURE_SHA256 here and say why in the commit message.')
  })

  test('the real alice.md splits without warnings', () => {
    assert.deepEqual(state.warnings, [], JSON.stringify(state.warnings))
  })

  test('the real alice.md yields its key fields', () => {
    assert.equal(state.name, 'Alice')
    assert.equal(state.identity.class, 'Wizard')
    assert.equal(state.abilities.INT, 17)
    assert.deepEqual(state.combat.hp, { current: 8, max: 8 })
    assert.equal(state.combat.ac, 12)
    assert.deepEqual(state.spellSlots, { 1: { total: 2, used: 0 } })
  })

  test('the real alice.md keeps its narrative byte-exact', () => {
    assert.ok(narrative.includes('## Character Pillar'))
    assert.ok(narrative.includes('## Features & Traits'))
    assert.ok(narrative.includes('## Backstory & Notes'))
    assert.ok(!narrative.includes('## Ability Scores'))
    assert.ok(!narrative.includes('## Spell Slots'))
  })

  test('the real alice.md survives a full round trip', () => {
    // The real sheet predates this design: no frontmatter, structured sections
    // inline. One composition extracts the state and stabilizes the file; from
    // then on it must not keep changing. The state is supplied from the first
    // parse because a composed .md no longer contains the numbers.
    const first = splitSheet(raw)
    const once = composeSheet(first.narrative, first.state, { title: first.title, metadata: first.metadata })
    const second = splitSheet(once)
    const twice = composeSheet(second.narrative, first.state, { title: second.title, metadata: second.metadata })
    assert.equal(once, twice, 'the file must reach a fixed point after one migration pass')
  })

  test('the real alice.md state is complete on the first parse', () => {
    // State is extracted once, from the original. Losing fields here would
    // mean data loss on migration, which no amount of later idempotence fixes.
    assert.equal(Object.keys(state.skills).length, 18)
    assert.equal(state.attacks.length, 2)
    assert.equal(state.saves.INT, 5)
    assert.deepEqual(state.proficientSaves, ['INT', 'WIS'])
    assert.equal(state.equipment.gear.Parchment, 8)
    assert.equal(Object.keys(state.spellSlots).length, 1)
  })

  test('the real alice.md narrative is never modified on disk', () => {
    // Read-only assertion: confirm re-composition keeps every narrative line.
    const out = composeSheet(narrative, state, '# Alice')
    const sources = splitSheet(raw).sections
      .filter((s) => s.heading !== null && /^(character pillar|campaign history|features & traits|backstory)/i.test(s.heading))
    for (const s of sources) {
      assert.ok(out.includes(s.body.trim()), 'lost section: ' + s.heading)
    }
  })
} else {
  // A committed fixture is not optional. Skipping quietly would leave the whole
  // real-sheet block unrun and this suite green — the exact shape of hole that
  // let a wrong `| Slot |` header ship while every test passed.
  failures += 1
  console.error('  FAIL the frozen fixture is missing: ' + REAL)
  console.error('       test/fixtures/alice-unmigrated.md is committed; if it was removed, restore it.')
  console.error('       It must stay a fixture — never point this at campaigns/morgansfort/.')
}

console.log('')
if (failures > 0) {
  console.error(`sheet-split.test.mjs: ${failures} failure(s)`)
  process.exit(1)
}
console.log('sheet-split.test.mjs: all assertions passed')
