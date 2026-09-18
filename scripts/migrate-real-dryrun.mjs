/**
 * Migration DRY RUN for the real morgansfort/alice.md.
 *
 * Parses the unmigrated sheet, derives the state the way `readCharacter` does,
 * and prints a field-by-field comparison against the inline source WITHOUT
 * writing anything. The write only happens if a human reads this and agrees.
 *
 * The point is to make the migration checkable: "the numbers are the same" is a
 * claim, and this prints every field it would put on disk so the claim can be
 * verified rather than trusted.
 *
 * `writeText` throws, so this script cannot write even by accident.
 */
import { readFileSync, statSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { readCharacter } from '../src/host/tools/state-io.mjs'
import { normalizeState, serializeState } from '../src/host/tools/state-schema.mjs'
import { formatCurrency, formatCurrencyShort } from '../src/host/tools/state-rules.mjs'

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
  async writeText() { throw new Error('DRY RUN: this script must never write') },
  async listDir(t) {
    const base = String(t.displayPath).replace(/\/$/, '')
    return readdirSync(nodePath(t.displayPath), { withFileTypes: true }).map((e) => ({
      name: e.name, target: target(`${base}/${e.name}`),
      type: e.isDirectory() ? 'directory' : 'file',
    }))
  },
}

const DIR = 'D:/DND/campaigns/morgansfort/characters'
const c = await readCharacter(fs, DIR, 'alice')

console.log('=== SOURCE ===')
console.log('  sheet sections parsed :', c.state === null ? 'none' : 'yes')
console.log('  needsMigration        :', c.needsMigration)
console.log('  hasStateFile          :', c.hasStateFile)
console.log('  warnings              :', c.warnings.length === 0 ? 'none' : c.warnings.join('; '))

const s = normalizeState(c.state)
const line = (label, value) => console.log('  ' + label.padEnd(22) + ': ' + value)
console.log('')
console.log('=== DERIVED STATE (what would be written to alice.state.json) ===')
line('name', s.name)
line('race / class', `${s.identity.race} / ${s.identity.class}`)
line('level / xp', `${s.identity.level} / ${s.identity.xp} (next ${s.identity.xpNext})`)
line('abilities', Object.entries(s.abilities).map(([k, v]) => `${k} ${v}`).join('  '))
line('HP', `${s.combat.hp.current}/${s.combat.hp.max}`)
line('AC (mage armor)', `${s.combat.ac} (${s.combat.mageArmorAc})`)
line('initiative / speed', `${s.combat.initiative} / ${s.combat.speed}`)
line('hit dice', `${s.combat.hitDice.die} x${s.combat.hitDice.remaining}`)
line('saves', Object.entries(s.saves).map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${v}`).join('  '))
line('proficient saves', s.proficientSaves.join(', '))
line('skills', `${Object.keys(s.skills).length} entries`)
line('  proficient', Object.entries(s.skills).filter(([, v]) => v.proficient).map(([k]) => k).join(', '))
line('attacks', s.attacks.map((a) => `${a.name} ${a.bonus >= 0 ? '+' : ''}${a.bonus} ${a.damage}`).join(' | '))
line('spell ability', s.spellcasting.ability)
line('spell saveDC/atk', `${s.spellcasting.saveDC} / +${s.spellcasting.attackBonus}`)
line('spell slots', Object.entries(s.spellSlots).map(([l, v]) => `L${l} ${v.total - v.used}/${v.total}`).join(', '))
line('cantrips', `${s.spells.cantrips.length}: ${s.spells.cantrips.join(', ')}`)
line('spellbook', `${s.spells.spellbook.length}: ${s.spells.spellbook.join(', ')}`)
line('prepared', `${s.spells.prepared.length}: ${s.spells.prepared.join(', ')}`)
line('weapons', Object.entries(s.equipment.weapons).map(([k, v]) => `${k} x${v}`).join(', '))
line('gear', Object.entries(s.equipment.gear).map(([k, v]) => `${k} x${v}`).join(', '))
line('currency', `${s.currency} cp = ${formatCurrency(s.currency)}`)

console.log('')
console.log('=== NARRATIVE (stays in the .md, never parsed) ===')
console.log('  title    :', c.title)
console.log('  length   :', c.narrative.length, 'chars')
console.log('  first 3 lines:')
for (const l of c.narrative.split('\n').slice(0, 3)) console.log('    | ' + l)

console.log('')
console.log('=== CROSS-CHECK: values that must not change ===')
const raw = readFileSync(nodePath(`${DIR}/alice.md`), 'utf8')
const checks = [
  ['currency 800 cp', s.currency === 800, `derived ${s.currency}`],
  ['HP 8/8', s.combat.hp.current === 8 && s.combat.hp.max === 8, `derived ${s.combat.hp.current}/${s.combat.hp.max}`],
  ['AC 12', s.combat.ac === 12, `derived ${s.combat.ac}`],
  ['INT 17', s.abilities.INT === 17, `derived ${s.abilities.INT}`],
  ['level 1', s.identity.level === 1, `derived ${s.identity.level}`],
  ['18 skills', Object.keys(s.skills).length === 18, `derived ${Object.keys(s.skills).length}`],
  ['1st-level slots 2 total', s.spellSlots['1']?.total === 2, `derived ${s.spellSlots['1']?.total}`],
  ['sheet still says 8 gp', /8 gp/.test(raw), 'source text'],
]
let bad = 0
for (const [label, pass, detail] of checks) {
  if (!pass) bad += 1
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label.padEnd(24)} (${detail})`)
}

console.log('')
console.log(bad === 0 ? 'DRY RUN OK — nothing was written; all cross-checks agree.' : `DRY RUN: ${bad} cross-check(s) disagree.`)
process.exitCode = bad === 0 ? 0 : 1
