/**
 * refresh-2024-srd — rebuild the 2024 dataset's class-level content from the
 * authoritative structured source.
 *
 * Source: 5e-bits/5e-database `src/2024/en` (SRD 5.2 / D&D 2024, CC-BY-4.0) —
 * the same upstream the dataset was originally built from, fetched fresh.
 * Downloaded to a temp dir (or a dir passed as argv[2]) and merged into
 * `data/srd-2024.json`:
 *
 *   - `classes`      ← Classes.json + Levels.json + Subclasses.json: per
 *                      class the core traits (hit die, primary ability,
 *                      saving throws, armor/weapon training, skill choices),
 *                      the spellcasting block, subclass names, and the full
 *                      20-level table (proficiency bonus, feature names,
 *                      cantrips known, prepared/known spells, per-level
 *                      spell slots).
 *   - `features`     ← Features.json: replaces the previously stale (2014
 *                      worded) per-class feature descriptions with the 2024
 *                      text, now including each feature's level.
 *
 * Everything else in the dataset (spells, equipment, monsters, ...) is left
 * untouched. The merge is idempotent: re-running with a fresher upstream
 * simply rewrites these three arrays.
 *
 * Usage: node scripts/refresh-2024-srd.mjs [download-dir]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'srd-2024.json')
const DIR = process.argv[2]
const BASE = 'https://raw.githubusercontent.com/5e-bits/5e-database/main/src/2024/en'
const FILES = ['Classes', 'Levels', 'Features', 'Subclasses']

async function load(name) {
  const local = DIR !== undefined ? path.join(DIR, `5e-SRD-${name}.json`) : undefined
  if (local !== undefined && existsSync(local)) {
    return JSON.parse(readFileSync(local, 'utf8'))
  }
  const res = await fetch(`${BASE}/5e-SRD-${name}.json`)
  if (!res.ok) throw new Error(`fetch ${name}: HTTP ${res.status}`)
  return res.json()
}

const ABILITY_CODES = { str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA' }
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null)

const [classesRaw, levelsRaw, featuresRaw, subclassesRaw] = await Promise.all(FILES.map(load))

const classes = classesRaw.map((c) => {
  const levels = levelsRaw
    .filter((l) => l.class?.index === c.index && l.subclass === undefined)
    .sort((a, b) => a.level - b.level)

  const saves = c.proficiencies
    .filter((p) => p.index.startsWith('saving-throw-'))
    .map((p) => ABILITY_CODES[p.index.replace('saving-throw-', '')])
    .filter(Boolean)
  const training = c.proficiencies
    .filter((p) => !p.index.startsWith('saving-throw-'))
    .map((p) => p.name)

  const table = levels.map((l) => {
    const sc = l.spellcasting ?? {}
    const spellSlots = {}
    for (let i = 1; i <= 9; i += 1) {
      const n = sc[`spell_slots_level_${i}`]
      if (Number.isFinite(n) && n > 0) spellSlots[String(i)] = n
    }
    const row = {
      level: l.level,
      profBonus: `+${l.prof_bonus}`,
      features: (l.features ?? []).map((f) => f.name),
    }
    if (sc.cantrips_known !== undefined) row.cantripsKnown = sc.cantrips_known
    if (sc.prepared_spells !== undefined) row.preparedSpells = sc.prepared_spells
    if (sc.spells_known !== undefined) row.spellsKnown = sc.spells_known
    if (Object.keys(spellSlots).length > 0) row.spellSlots = spellSlots
    if (l.class_specific !== undefined && Object.keys(l.class_specific).length > 0) {
      row.specific = l.class_specific
    }
    return row
  })

  const mechanic = table.some((r) => r.preparedSpells !== undefined) ? 'prepared'
    : table.some((r) => r.spellsKnown !== undefined) ? 'known'
    : null

  return {
    name: c.name,
    ruleset: '2024',
    hitDie: `d${c.hit_die}`,
    primaryAbility: c.primary_ability?.desc ?? null,
    saves,
    armorTraining: training.filter((t) => /armor|shield/i.test(t)).join(', ') || null,
    weaponTraining: training.filter((t) => /weapon/i.test(t)).join(', ') || null,
    otherTraining: training.filter((t) => !/armor|shield|weapon/i.test(t)).join(', ') || null,
    skillChoices: (c.proficiency_choices ?? []).map((pc) => pc.desc).join('; ') || null,
    spellcasting: c.spellcasting === undefined ? null : {
      ability: c.spellcasting.spellcasting_ability?.name ?? null,
      level: c.spellcasting.level ?? null,
      mechanic,
      cantripSwap: c.spellcasting.info?.some((i) => /replace one of your cantrips/i.test(i.desc?.join(' ') ?? '')) === true,
      notes: (c.spellcasting.info ?? []).map((i) => ({ name: i.name, text: (i.desc ?? []).join(' ') })),
    },
    subclasses: subclassesRaw.filter((s) => s.class?.index === c.index).map((s) => s.name),
    equipmentOptions: (c.starting_equipment_options ?? []).map((o) => o.desc).filter(Boolean),
    table,
  }
})

const features = featuresRaw.map((f) => ({
  index: f.index,
  name: f.name,
  description: f.description ?? null,
  class: f.class?.index ?? null,
  level: f.level?.level ?? null,
  type: 'class',
}))

const target = JSON.parse(readFileSync(DATA, 'utf8'))
target.classes = classes
target.features = features
target._meta.record_counts.classes = classes.length
target._meta.record_counts.features = features.length
target._meta.sources['5e-bits-classes'] = {
  repo: '5e-bits/5e-database', branch: 'main', subpath: 'src/2024/en',
  files: FILES.map((f) => `5e-SRD-${f}.json`), refreshed_at: new Date().toISOString(),
}
writeFileSync(DATA, JSON.stringify(target, null, 1) + '\n', 'utf8')

const casters = classes.filter((c) => c.spellcasting !== null)
console.log(`classes: ${classes.length} (${casters.length} casters: ${casters.map((c) => c.name).join(', ')})`)
console.log(`features: ${features.length}`)
const bard = classes.find((c) => c.name === 'Bard')
console.log('Bard lv1 row:', JSON.stringify(bard.table[0]))
console.log('Bard lv5 row:', JSON.stringify(bard.table[4]))
