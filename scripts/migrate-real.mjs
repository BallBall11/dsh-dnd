/**
 * The real migration, run once: morgansfort/alice.md -> alice.md + alice.state.json.
 *
 * Writes ONLY after the dry run (migrate-real-dryrun.mjs) showed every derived
 * field matching the sheet. The backup made beforehand is not this script's
 * responsibility, but this script refuses to run without one.
 *
 * Two things it checks afterwards that a plain re-read would not:
 *
 *   - the NARRATIVE section, below the generated block, is byte-identical to
 *     what it was. The numbers are supposed to move out; the prose is not
 *     supposed to move at all.
 *   - a SECOND write changes nothing (fixpoint). A migration that is not
 *     idempotent would produce a fresh diff on every read-then-write, which
 *     makes the git history useless.
 */
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { readCharacter, writeCharacter } from '../src/host/tools/state-io.mjs'
import { readCalendar } from '../src/host/tools/clock.mjs'

const nodePath = (p) => String(p).replace(/\//g, path.sep)
const target = (p) => ({ targetKey: String(p).toLowerCase(), displayPath: String(p).replace(/\\/g, '/') })

const fs = {
  async resolve(p) { return target(p) },
  async stat(t) {
    try {
      const s = statSync(nodePath(t.displayPath))
      return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs }
    } catch { return undefined }
  },
  async readText(t) { return readFileSync(nodePath(t.displayPath), 'utf8') },
  async writeText(t, text) { writeFileSync(nodePath(t.displayPath), text, 'utf8') },
  async listDir(t) {
    const base = String(t.displayPath).replace(/\/$/, '')
    const { readdirSync } = await import('node:fs')
    return readdirSync(nodePath(t.displayPath), { withFileTypes: true }).map((e) => ({
      name: e.name, target: target(`${base}/${e.name}`),
      type: e.isDirectory() ? 'directory' : 'file',
    }))
  },
}

const CAMPAIGN = 'D:/DND/campaigns/morgansfort'
const DIR = `${CAMPAIGN}/characters`
const SHEET = `${DIR}/alice.md`
const STATE = `${DIR}/alice.state.json`

const sha = (p) => createHash('sha256').update(readFileSync(nodePath(p))).digest('hex')
const GENERATED_OPEN = '<!-- dsh-dnd:generated -->'
const GENERATED_CLOSE = '<!-- /dsh-dnd:generated -->'

/**
 * The PROSE sections: the ones that are not machine-owned and must survive the
 * migration untouched.
 *
 * Comparing the whole narrative would be wrong, and the first version of this
 * script made exactly that mistake: it asserted the prose was byte-identical
 * and failed on a CORRECT migration. The structured sections — Identity,
 * Ability Scores, Combat Stats, Saving Throws, Skills, Attacks, Spell Slots,
 * Known Spells, Equipment — are SUPPOSED to leave the .md. That is the entire
 * point. What must not move is the writing.
 */
const PROSE_SECTIONS = [
  '## Character Pillar',
  '## Campaign History',
  '## Features & Traits',
  '## Backstory & Notes',
]

/** Pull one `## Heading` section out of a sheet's text. */
function sectionOf(text, heading) {
  const at = text.indexOf(heading)
  if (at === -1) return null
  const rest = text.slice(at + heading.length)
  const next = rest.search(/^## /m)
  return (next === -1 ? rest : rest.slice(0, next)).trim()
}

// Refuse to run without a backup: this is real campaign data.
const backups = (await import('node:fs')).readdirSync(nodePath('D:/DND/campaigns'))
  .filter((n) => n.startsWith('morgansfort.backup-'))
if (backups.length === 0) {
  console.error('REFUSING: no campaigns/morgansfort.backup-* directory found. Back up first.')
  process.exit(1)
}
console.log('backup present:', backups.join(', '))
console.log('')

// `readCharacter` is async — without this await `before` is a Promise and every
// field reads as undefined, which is how the first run of this script failed.
// The harness being async is not optional here: it reads two files.
const before = await readCharacter(fs, DIR, 'alice')
if (before.hasStateFile) {
  console.error('REFUSING: alice.state.json already exists. Nothing to migrate.')
  process.exit(1)
}
const sheetBefore = readFileSync(nodePath(SHEET), 'utf8')
const sheetHashBefore = sha(SHEET)
console.log('before migration:')
console.log('  sheet bytes :', sheetBefore.length)
console.log('  sheet sha   :', sheetHashBefore)
console.log('  has state   :', before.hasStateFile)
console.log('')

const calendar = await readCalendar(fs, CAMPAIGN)
// An unmigrated sheet has no frontmatter, so `metadata` is `{}` — the legacy
// inline `**Player:** ... **Campaign:** ...` line is deliberately not parsed
// into it (the write path strips that line instead). The campaign name comes
// from the directory we are migrating, not from the sheet.
const written = await writeCharacter(fs, DIR, 'alice', {
  state: before.state,
  narrative: before.narrative,
  title: before.title,
  campaign: before.metadata.campaign ?? 'morgansfort',
  player: before.metadata.player ?? null,
  tags: before.metadata.tags ?? ['pc'],
  calendar,
})

console.log('write result:')
console.log('  refused   :', written.refused)
if (written.refused) console.log('  reason    :', written.reason)
console.log('  findings  :', (written.findings ?? []).length === 0 ? 'none' : '')
for (const f of written.findings ?? []) console.log(`    ${f.level} ${f.field}: ${f.message}`)
console.log('')

const after = await readCharacter(fs, DIR, 'alice')
const sheetAfter = readFileSync(nodePath(SHEET), 'utf8')

console.log('after migration:')
console.log('  sheet bytes:', sheetAfter.length)
console.log('  sheet sha  :', sha(SHEET))
console.log('  state sha  :', sha(STATE))
console.log('  state file :', existsSync(nodePath(STATE)))
console.log('  has state  :', after.hasStateFile)
console.log('  migration  :', after.needsMigration)
console.log('')

const checks = []
const check = (label, pass, detail) => { checks.push(pass); console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`) }

console.log('verification:')
for (const heading of PROSE_SECTIONS) {
  const was = sectionOf(sheetBefore, heading)
  const now = sectionOf(sheetAfter, heading)
  check(`prose section intact: ${heading}`,
    was !== null && now !== null && was === now,
    was === null ? 'missing from the source!' : `${(was ?? '').length} chars`)
}

// The structured sections must have LEFT the .md, and arrived in the state file.
const STRUCTURED = ['## Identity', '## Ability Scores', '## Combat Stats',
  '## Saving Throws', '## Skills', '## Attacks', '## Equipment & Inventory']
for (const heading of STRUCTURED) {
  check(`structured section migrated out: ${heading}`,
    sectionOf(sheetAfter, heading) === null,
    'still present in the .md')
}

check('the legacy inline metadata line was removed',
  !/\*\*Last Updated:\*\*/.test(sheetAfter))
check('exactly one generated block', (sheetAfter.match(/<!-- dsh-dnd:generated -->/g) ?? []).length === 1)
check('frontmatter carries the real clock', /^updated: \d{4}-\d{2}-\d{2}$/m.test(sheetAfter))
check('frontmatter carries the world clock', /^worldTime: .+$/m.test(sheetAfter))
check('no longer needs migration', after.needsMigration === false)
check('numbers survived', after.state.currency === 800 && after.state.combat.hp.max === 8
  && after.state.abilities.INT === 17 && Object.keys(after.state.skills).length === 18)
check('no longer names alice.md as unmigrated', after.hasStateFile === true)

// Every value the structured sections carried must be in the state file. This
// is the check that actually matters: the prose comparison above proves the
// writing survived, but only this proves the NUMBERS did.
console.log('')
console.log('no number was lost (every removed value is in alice.state.json):')
const st = after.state
const NUMBERS = [
  ['STR 8', st.abilities.STR === 8],
  ['DEX 14', st.abilities.DEX === 14],
  ['CON 15', st.abilities.CON === 15],
  ['INT 17', st.abilities.INT === 17],
  ['WIS 10', st.abilities.WIS === 10],
  ['CHA 10', st.abilities.CHA === 10],
  ['HP 8/8', st.combat.hp.current === 8 && st.combat.hp.max === 8],
  ['AC 12 / mage armour 15', st.combat.ac === 12 && st.combat.mageArmorAc === 15],
  ['initiative 2 / speed 30', st.combat.initiative === 2 && st.combat.speed === 30],
  ['hit dice 1d6 x1', st.combat.hitDice.die === '1d6' && st.combat.hitDice.remaining === 1],
  ['saves INT +5, WIS +2', st.saves.INT === 5 && st.saves.WIS === 2],
  ['proficient saves INT, WIS', st.proficientSaves.includes('INT') && st.proficientSaves.includes('WIS')],
  ['18 skills', Object.keys(st.skills).length === 18],
  ['3 proficient skills', Object.values(st.skills).filter((s) => s.proficient).length === 3],
  ['attack bonus +5 x2', st.attacks.every((a) => a.bonus === 5) && st.attacks.length === 2],
  ['spell DC 13 / attack +5', st.spellcasting.saveDC === 13 && st.spellcasting.attackBonus === 5],
  ['1st-level slots 2 total, 0 used', st.spellSlots['1'].total === 2 && st.spellSlots['1'].used === 0],
  ['6 cantrips', st.spells.cantrips.length === 6],
  ['6 spellbook', st.spells.spellbook.length === 6],
  ['4 prepared', st.spells.prepared.length === 4],
  ['2 weapons', Object.keys(st.equipment.weapons).length === 2],
  ['6 gear items', Object.keys(st.equipment.gear).length === 6],
  ['Parchment x8', st.equipment.gear.Parchment === 8],
  ['currency 800 cp = 8 gp', st.currency === 800],
  ['XP 0 / 300', st.identity.xp === 0 && st.identity.xpNext === 300],
]
for (const [label, pass] of NUMBERS) check(label, pass)

// A second write must be a no-op. If it is not, every future read-then-write
// produces a diff, and the git history stops being readable.
console.log('')
console.log('fixpoint check (a second write must change nothing):')
const firstState = readFileSync(nodePath(STATE), 'utf8')
const firstSheet = readFileSync(nodePath(SHEET), 'utf8')
await writeCharacter(fs, DIR, 'alice', {
  state: after.state,
  narrative: after.narrative,
  title: after.title,
  campaign: after.metadata.campaign ?? 'morgansfort',
  player: after.metadata.player ?? null,
  tags: after.metadata.tags ?? ['pc'],
  calendar,
})
const secondState = readFileSync(nodePath(STATE), 'utf8')
const secondSheet = readFileSync(nodePath(SHEET), 'utf8')
// `updated` is a date, so two writes on the same day produce identical text.
check('the state file is unchanged by a second write', firstState === secondState)
check('the sheet is unchanged by a second write', firstSheet === secondSheet)

console.log('')
const failed = checks.filter((c) => !c).length
if (failed > 0) {
  console.error(`MIGRATION: ${failed} check(s) failed. The backup is at campaigns/${backups[0]}/`)
  process.exit(1)
}
console.log('MIGRATION OK — alice.md split into alice.md + alice.state.json, prose intact.')
