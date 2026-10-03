/**
 * state-io tests — the read/write pair for a character's two files.
 *
 * These run against a REAL temporary directory on disk, not a mock. Mocking
 * the filesystem is what let two bugs reach the profile earlier in this
 * project: a mock more permissive than the real thing cannot fail, and a mock
 * that cannot fail is not a test. The cost here is a few milliseconds of real
 * I/O, which is worth paying for a module that rewrites campaign data.
 *
 * Two kinds of test live here, and they obey different rules (see
 * test/support/live-data.mjs and docs/harness/TEST-DATA-OWNERSHIP.md):
 *
 *   - the round-trip cases below own their input outright: a temp directory
 *     this file creates and deletes.
 *   - the final block reads the LIVE character, because "reading never writes"
 *     is an invariant that must hold for whatever is actually on disk. It
 *     asserts a property (nothing moved, the read is self-consistent) and
 *     never a snapshot of that character's numbers.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  readCharacter,
  writeCharacter,
  listCharacters,
  readAllCharacters,
  statePath,
  sheetPath,
} from '../src/host/tools/state-io.mjs'
import { serializeState } from '../src/host/tools/state-schema.mjs'
import { liveExists, snapshotTree, diffTree } from './support/live-data.mjs'

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failures += 1
    console.log('  FAIL ' + name)
    console.log('       ' + (error && error.message ? error.message : error))
  }
}

/** A real fs service over a real directory, shaped like the host contract. */
function makeFs() {
  const nodePath = (p) => String(p).replace(/\//g, path.sep)
  const target = (p) => ({ targetKey: String(p).toLowerCase(), displayPath: String(p).replace(/\\/g, '/') })
  return {
    async resolve(p) { return target(p) },
    async stat(t) {
      if (typeof t === 'string') throw new TypeError('stat requires an FsTarget')
      try {
        const s = require('node:fs').statSync(nodePath(t.displayPath))
        return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs }
      } catch { return undefined }
    },
    async readText(t) {
      if (typeof t === 'string') throw new TypeError('readText requires an FsTarget')
      return readFileSync(nodePath(t.displayPath), 'utf8')
    },
    async writeText(t, text) {
      if (typeof t === 'string') throw new TypeError('writeText requires an FsTarget')
      writeFileSync(nodePath(t.displayPath), text, 'utf8')
    },
    async listDir(t) {
      if (typeof t === 'string') throw new TypeError('listDir requires an FsTarget')
      const { readdirSync } = require('node:fs')
      const base = String(t.displayPath).replace(/\/$/, '')
      return readdirSync(nodePath(t.displayPath), { withFileTypes: true }).map((e) => ({
        name: e.name,
        target: target(`${base}/${e.name}`),
        type: e.isDirectory() ? 'directory' : 'file',
      }))
    },
  }
}

const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)

const root = mkdtempSync(path.join(tmpdir(), 'dnd-stateio-'))
const dir = path.join(root, 'characters').replace(/\\/g, '/')
mkdirSync(dir.replace(/\//g, path.sep), { recursive: true })
const fs = makeFs()

/** An unmigrated sheet: structured sections inline, no frontmatter. */
const LEGACY = `# Alice
**Player:** —  **Campaign:** morgansfort  **Last Updated:** 2026-09-04

## Identity
- **Race:** High Elf (Elf) | **Class:** Wizard | **Level:** 1 | **Background:** Sage
- **Alignment:** *(unchosen)* | **XP:** 0 / 300

## Character Pillar
- **Player's sentence:** *"我是一个精灵法师贤者"*

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

## Attacks
| Name | Attack Bonus | Damage | Type | Notes |
|------|-------------|--------|------|-------|
| 电爪 Shocking Grasp | +5 | 1d8 | Lightning | melee |

## Spell Slots (if applicable)
| Level | Total | Used |
|-------|-------|------|
| 1st | 2 | 0 |

## Known Spells / Cantrips
**Cantrips (6):** Light, Mage Hand
**Spellcasting ability:** INT. **Spell save DC:** 13 | **Spell attack:** +5

## Features & Traits

### Wizard
- **Spellcasting** — INT-based; 3 cantrips.

## Equipment & Inventory
**Weapons:**
- Quarterstaff (Sage)

**Armour:**
- *(none)*

**Adventuring Gear:**
- Spellbook (arcane focus)

**Currency:** 8 gp 0 sp 0 cp

## Backstory & Notes
- 游历世界收集法术的精灵法师贤者。
`

const CALENDAR = {
  day: 2, month: 3, year: 1247, hour: 8,
  months: ['Frostfall', 'Deepwinter', 'Thawmonth', 'Seedtime', 'Bloomtide', 'Highsun',
    'Harvestmoon', 'Duskfall', 'Leafall', 'Chillreach', 'Longnight', 'Stormrise'],
}

writeFileSync(path.join(dir.replace(/\//g, path.sep), 'alice.md'), LEGACY, 'utf8')

// --- reading an unmigrated sheet -----------------------------------------
await test('reads an unmigrated sheet and reports migration is available', async () => {
  const c = await readCharacter(fs, dir, 'alice')
  assert.equal(c.name, 'alice')
  assert.equal(c.hasStateFile, false)
  assert.equal(c.needsMigration, true)
  assert.ok(c.state !== null, 'state must be derived from the sheet')
})

await test('derives the full state from an unmigrated sheet', async () => {
  const { state } = await readCharacter(fs, dir, 'alice')
  assert.equal(state.name, 'Alice')
  assert.equal(state.abilities.INT, 17)
  assert.deepEqual(state.combat.hp, { current: 8, max: 8 })
  assert.equal(state.saves.INT, 5)
  assert.deepEqual(state.proficientSaves, ['INT', 'WIS'])
  assert.equal(state.skills.Arcana.bonus, 5)
  assert.deepEqual(state.spellSlots, { 1: { total: 2, used: 0 } })
  assert.equal(state.equipment.weapons['Quarterstaff (Sage)'], 1)
  assert.equal(state.currency, 800, 'money is stored as one integer, not three fields')
})

await test('reading does not create any file', async () => {
  await readCharacter(fs, dir, 'alice')
  assert.ok(!existsSync(path.join(dir.replace(/\//g, path.sep), 'alice.state.json')),
    'a read must never write')
})

await test('narrative is returned and excludes structured sections', async () => {
  const { narrative } = await readCharacter(fs, dir, 'alice')
  assert.ok(narrative.includes('## Character Pillar'))
  assert.ok(narrative.includes('## Features & Traits'))
  assert.ok(narrative.includes('游历世界收集法术的精灵法师贤者。'))
  assert.ok(!narrative.includes('## Ability Scores'))
})

// --- listing ---------------------------------------------------------------
await test('lists characters from .md files', async () => {
  const listed = await listCharacters(fs, dir)
  assert.deepEqual(listed, [{ name: 'alice', hasStateFile: false }])
})

await test('readAllCharacters returns every character', async () => {
  const { characters } = await readAllCharacters(fs, dir)
  assert.equal(characters.length, 1)
  assert.equal(characters[0].state.name, 'Alice')
})

// --- writing --------------------------------------------------------------
await test('writeCharacter creates both files', async () => {
  const before = await readCharacter(fs, dir, 'alice')
  await writeCharacter(fs, dir, 'alice', {
    state: before.state,
    narrative: before.narrative,
    title: before.title,
    campaign: 'morgansfort',
    player: '—',
    calendar: CALENDAR,
    now: new Date('2026-09-15T12:00:00Z'),
  })
  assert.ok(existsSync(statePath(dir, 'alice').replace(/\//g, path.sep)))
  assert.ok(existsSync(sheetPath(dir, 'alice').replace(/\//g, path.sep)))
})

await test('the state file is valid JSON with the full state', async () => {
  const text = readFileSync(statePath(dir, 'alice').replace(/\//g, path.sep), 'utf8')
  const parsed = JSON.parse(text)
  assert.equal(parsed.name, 'Alice')
  assert.equal(parsed.abilities.INT, 17)
  assert.equal(parsed.schema, 1)
})

await test('the .md gains frontmatter with BOTH clocks', async () => {
  const text = readFileSync(sheetPath(dir, 'alice').replace(/\//g, path.sep), 'utf8')
  assert.ok(text.startsWith('---\n'), 'frontmatter must be first')
  assert.match(text, /^updated: 2026-09-15$/m, 'the real-world clock is stamped')
  assert.match(text, /^worldTime: 2 Thawmonth 1247 AR, 08:00$/m, 'the in-world clock is stamped')
})

await test('the .md keeps its narrative', async () => {
  const text = readFileSync(sheetPath(dir, 'alice').replace(/\//g, path.sep), 'utf8')
  assert.ok(text.includes('## Character Pillar'))
  assert.ok(text.includes('游历世界收集法术的精灵法师贤者。'))
  assert.ok(text.includes('### Wizard'))
  assert.ok(text.includes('- **Spellcasting** — INT-based; 3 cantrips.'))
})

await test('the .md drops the structured sections', async () => {
  const text = readFileSync(sheetPath(dir, 'alice').replace(/\//g, path.sep), 'utf8')
  assert.ok(!text.includes('## Ability Scores'))
  assert.ok(!text.includes('## Skills'))
  assert.ok(!text.includes('## Equipment'))
})

await test('the .md carries a generated summary', async () => {
  const text = readFileSync(sheetPath(dir, 'alice').replace(/\//g, path.sep), 'utf8')
  assert.ok(text.includes('<!-- dsh-dnd:generated -->'))
  assert.ok(text.includes('HP 8/8'))
  assert.ok(text.includes('INT 17 (+3)'))
})

// --- reading a migrated character -----------------------------------------
await test('a migrated character reads state from the JSON, not the .md', async () => {
  const c = await readCharacter(fs, dir, 'alice')
  assert.equal(c.hasStateFile, true)
  assert.equal(c.needsMigration, false)
  assert.equal(c.state.abilities.INT, 17, 'the numbers must survive the migration')
  assert.equal(c.state.skills.Arcana.bonus, 5)
})

await test('the migrated state is fully intact', async () => {
  const { state } = await readCharacter(fs, dir, 'alice')
  assert.equal(Object.keys(state.skills).length, 1)
  assert.equal(state.equipment.gear['Spellbook (arcane focus)'], 1)
  assert.deepEqual(state.spellSlots, { 1: { total: 2, used: 0 } })
})

await test('the metadata round-trips', async () => {
  const c = await readCharacter(fs, dir, 'alice')
  assert.equal(c.metadata.campaign, 'morgansfort')
  assert.equal(c.metadata.updated, '2026-09-15')
  assert.equal(c.metadata.worldTime, '2 Thawmonth 1247 AR, 08:00')
})

await test('the legacy inline metadata line is gone after migration', async () => {
  const c = await readCharacter(fs, dir, 'alice')
  assert.ok(!c.narrative.includes('**Last Updated:**'),
    'the inline copy is superseded by frontmatter and must not linger')
})

await test('the written .md does not contain the legacy line either', async () => {
  // The read-side guard keeps the line when there is no frontmatter, because
  // it is then the only copy. The write path creates a replacement, so it must
  // strip the line — otherwise the same fact sits in two places in the output,
  // which is what the whole split exists to prevent.
  const text = readFileSync(sheetPath(dir, 'alice').replace(/\//g, path.sep), 'utf8')
  assert.ok(!text.includes('**Last Updated:**'), 'the migrated file must not restate metadata inline')
  assert.ok(!text.includes('**Player:**'), 'nor the player field')
  assert.ok(text.includes('updated:'), 'the frontmatter is the one place it lives')
})

// --- the critical property ------------------------------------------------
await test('reading a migrated character twice is stable', async () => {
  const a = await readCharacter(fs, dir, 'alice')
  const b = await readCharacter(fs, dir, 'alice')
  assert.equal(serializeState(a.state), serializeState(b.state))
  assert.equal(a.narrative, b.narrative)
  assert.deepEqual(a.metadata, b.metadata)
})

await test('writing a migrated character is idempotent', async () => {
  const c = await readCharacter(fs, dir, 'alice')
  const opts = {
    state: c.state, narrative: c.narrative, title: c.title,
    campaign: c.metadata.campaign, player: c.metadata.player,
    calendar: CALENDAR, now: new Date('2026-09-15T12:00:00Z'),
  }
  await writeCharacter(fs, dir, 'alice', opts)
  const first = readFileSync(sheetPath(dir, 'alice').replace(/\//g, path.sep), 'utf8')
  await writeCharacter(fs, dir, 'alice', opts)
  const second = readFileSync(sheetPath(dir, 'alice').replace(/\//g, path.sep), 'utf8')
  assert.equal(first, second, 'writing the same content twice must produce identical bytes')
})

await test('the summary reflects changed state', async () => {
  const c = await readCharacter(fs, dir, 'alice')
  const wounded = { ...c.state, combat: { ...c.state.combat, hp: { current: 3, max: 8 } } }
  await writeCharacter(fs, dir, 'alice', {
    state: wounded, narrative: c.narrative, title: c.title,
    campaign: c.metadata.campaign, player: c.metadata.player,
    calendar: CALENDAR, now: new Date('2026-09-15T12:00:00Z'),
  })
  const text = readFileSync(sheetPath(dir, 'alice').replace(/\//g, path.sep), 'utf8')
  assert.ok(text.includes('HP 3/8'), 'the summary must show the new HP')
  const back = await readCharacter(fs, dir, 'alice')
  assert.deepEqual(back.state.combat.hp, { current: 3, max: 8 })
})

await test('a change to state does not disturb the narrative', async () => {
  const before = readFileSync(sheetPath(dir, 'alice').replace(/\//g, path.sep), 'utf8')
  const c = await readCharacter(fs, dir, 'alice')
  await writeCharacter(fs, dir, 'alice', {
    state: { ...c.state, abilities: { ...c.state.abilities, INT: 18 } },
    narrative: c.narrative, title: c.title,
    campaign: c.metadata.campaign, player: c.metadata.player,
    calendar: CALENDAR, now: new Date('2026-09-15T12:00:00Z'),
  })
  const after = readFileSync(sheetPath(dir, 'alice').replace(/\//g, path.sep), 'utf8')
  const drop = (t) => t.split('\n').filter((l) => !l.startsWith('>') && !l.startsWith('<!--')).join('\n')
  assert.equal(drop(before), drop(after), 'only the generated block may change')
})

// --- error handling -------------------------------------------------------
await test('a missing character reports a warning rather than throwing', async () => {
  const c = await readCharacter(fs, dir, 'nobody')
  assert.equal(c.state, null)
  assert.ok(c.warnings.length > 0)
})

await test('a corrupt state file warns and yields no state', async () => {
  const p = statePath(dir, 'broken').replace(/\//g, path.sep)
  writeFileSync(p, '{ this is not json', 'utf8')
  writeFileSync(path.join(dir.replace(/\//g, path.sep), 'broken.md'), '# Broken\n## Backstory & Notes\n- x\n', 'utf8')
  const c = await readCharacter(fs, dir, 'broken')
  assert.equal(c.state, null)
  assert.ok(c.warnings.some((w) => /could not be read|not valid JSON/.test(w)), JSON.stringify(c.warnings))
})

await test('listing sees a state file with no sheet', async () => {
  writeFileSync(statePath(dir, 'orphan').replace(/\//g, path.sep), '{"schema":1,"name":"Orphan"}', 'utf8')
  const listed = await listCharacters(fs, dir)
  assert.ok(listed.some((c) => c.name === 'orphan' && c.hasStateFile), JSON.stringify(listed))
})

// --- refusing to write an impossible state --------------------------------
// Clamping would be worse than the bug: a DM reading a plausible number has no
// way to learn the character was in an impossible state. A refused write is
// visible; a silently repaired one is not.

await test('a write with more slots expended than exist is refused', async () => {
  const c = await readCharacter(fs, dir, 'alice')
  const before = readFileSync(statePath(dir, 'alice').replace(/\//g, path.sep), 'utf8')
  const result = await writeCharacter(fs, dir, 'alice', {
    state: { ...c.state, spellSlots: { 1: { total: 2, used: 5 } } },
    narrative: c.narrative, campaign: c.metadata.campaign, player: c.metadata.player,
    calendar: CALENDAR, now: new Date('2026-09-15T12:00:00Z'),
  })
  assert.equal(result.refused, true)
  assert.match(result.reason, /more than the character has/)
  const after = readFileSync(statePath(dir, 'alice').replace(/\//g, path.sep), 'utf8')
  assert.equal(after, before, 'a refused write must touch nothing')
})

await test('a write with a negative purse is refused', async () => {
  const c = await readCharacter(fs, dir, 'alice')
  const result = await writeCharacter(fs, dir, 'alice', {
    state: { ...c.state, currency: -15 },
    narrative: c.narrative, campaign: c.metadata.campaign, player: c.metadata.player,
    calendar: CALENDAR, now: new Date('2026-09-15T12:00:00Z'),
  })
  assert.equal(result.refused, true)
  assert.match(result.reason, /negative coin/)
})

await test('a refused write still reports what was wrong', async () => {
  const c = await readCharacter(fs, dir, 'alice')
  const result = await writeCharacter(fs, dir, 'alice', {
    state: { ...c.state, combat: { ...c.state.combat, hp: { current: 99, max: 8 } } },
    narrative: c.narrative, campaign: c.metadata.campaign, player: c.metadata.player,
    calendar: CALENDAR, now: new Date('2026-09-15T12:00:00Z'),
  })
  assert.equal(result.refused, true)
  assert.ok(result.findings.some((f) => f.field === 'combat.hp.current' && f.level === 'error'))
  assert.ok(result.warnings.length > 0, 'the reason must reach the caller as a warning')
})

await test('strict:false allows a write and reports the findings', async () => {
  // For importing an existing sheet that is already in a doubtful state:
  // refusing would make it impossible to store what is actually on the page.
  const c = await readCharacter(fs, dir, 'alice')
  const result = await writeCharacter(fs, dir, 'alice', {
    state: { ...c.state, currency: -15 },
    narrative: c.narrative, campaign: c.metadata.campaign, player: c.metadata.player,
    calendar: CALENDAR, now: new Date('2026-09-15T12:00:00Z'), strict: false,
  })
  assert.equal(result.refused, false)
  assert.ok(result.findings.length > 0, 'the problem is still reported')

  // Restore a valid state, so a later test does not inherit the deliberate one.
  await writeCharacter(fs, dir, 'alice', {
    state: { ...c.state, currency: 800 },
    narrative: c.narrative, campaign: c.metadata.campaign, player: c.metadata.player,
    calendar: CALENDAR, now: new Date('2026-09-15T12:00:00Z'),
  })
})

await test('a valid write is not refused and reports no errors', async () => {
  const c = await readCharacter(fs, dir, 'alice')
  const result = await writeCharacter(fs, dir, 'alice', {
    state: c.state, narrative: c.narrative, campaign: c.metadata.campaign, player: c.metadata.player,
    calendar: CALENDAR, now: new Date('2026-09-15T12:00:00Z'),
  })
  assert.equal(result.refused, false)
  assert.ok(!result.findings.some((f) => f.level === 'error'), JSON.stringify(result.findings))
})

// --- the real character, read-only ----------------------------------------
//
// INVARIANT TEST, not a parser test. The promise under test is "READING NEVER
// WRITES"; it must hold for every possible state of the live campaign, so this
// block is allowed to read live data — and is forbidden from asserting what
// that data says.
//
// The history matters. The first version asserted `needsMigration === true` and
// that no `.state.json` existed. Both were true when written and both became
// deliberately false when that character was migrated with the operator's
// consent — so the suite went red while the code was perfect. The next version
// still asserted `c.state.identity.class === 'Wizard'`, `hp 8/8`, `currency
// 800`: the same mistake with a smaller blast radius. A campaign number is
// supposed to change.
//
// What remains is the shape of the read, plus a byte-level "nothing moved".
// Both survive any legitimate campaign edit.
const REAL_DIR = 'D:/DND/campaigns/morgansfort/characters'
if (liveExists(REAL_DIR)) {
  await test('reading the real character writes nothing', async () => {
    // Snapshot the WHOLE character directory, not just alice's two files: the
    // invariant is that a read is inert, so a read that created a stray file
    // anywhere under here must fail this too.
    const before = snapshotTree(REAL_DIR)

    const c = await readCharacter(fs, REAL_DIR, 'alice')
    assert.equal(typeof c.state, 'object', 'a read must still return state')

    const changes = diffTree(before, snapshotTree(REAL_DIR))
    assert.deepEqual(changes, [], 'reading must not write. Differences: ' + changes.join('; '))
  })

  await test('reading every character in the directory writes nothing', async () => {
    // The listing path is the one the panel uses. Whatever characters exist,
    // reading all of them must be inert — including a character that is
    // mid-migration or has a malformed state file.
    const before = snapshotTree(REAL_DIR)
    await readAllCharacters(fs, REAL_DIR)
    const changes = diffTree(before, snapshotTree(REAL_DIR))
    assert.deepEqual(changes, [], 'listing must not write. Differences: ' + changes.join('; '))
  })

  await test('the real character reads the same twice', async () => {
    // A read that depended on hidden state — a cache warmed by the first call,
    // a clock, a mutation in place — would show up here. This compares two
    // reads of the SAME data, so it says nothing about what the values are.
    const first = await readCharacter(fs, REAL_DIR, 'alice')
    const second = await readCharacter(fs, REAL_DIR, 'alice')
    assert.deepEqual(second.state, first.state)
    assert.equal(second.narrative, first.narrative)
    assert.equal(second.needsMigration, first.needsMigration)
  })

  await test('the read is self-describing about which source it used', async () => {
    // A migrated character reads its numbers from `.state.json`; an unmigrated
    // one derives them from the sheet. Both are legal, so assert the RULE that
    // links the flag to the file rather than either particular outcome.
    const c = await readCharacter(fs, REAL_DIR, 'alice')
    assert.equal(c.hasStateFile, !c.needsMigration,
      'needsMigration must be exactly the inverse of hasStateFile — a character that has no '
      + 'state file needs migrating, and one that has a state file does not. Got '
      + `needsMigration=${c.needsMigration}, hasStateFile=${c.hasStateFile}`)
  })
}

rmSync(root, { recursive: true, force: true })

console.log('')
if (failures > 0) {
  console.error(`state-io.test.mjs: ${failures} failure(s)`)
  process.exit(1)
}
console.log('state-io.test.mjs: all assertions passed')
