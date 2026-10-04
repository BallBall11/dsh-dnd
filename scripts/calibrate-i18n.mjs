/**
 * Calibrate data/i18n-zh.json against the 5etools-cn terminology table
 * (tjliqy/5etools-cn @ cn2.0, docs/terms-20260922-142718.json — the site's
 * own curated EN->CN glossary, 47829 entries).
 *
 * Resolution per term: the category matching the map (spell->'spell',
 * mastery->'itemMastery' then '', classes->'variantrule'/'class'/'') wins;
 * the bulk '' category is the fallback; entries flagged to_be_discussed are
 * skipped; a term the glossary does not cover keeps its current value.
 *
 * Usage: node scripts/calibrate-i18n.mjs <path-to-terms.json>
 * One-off: the calibrated file is committed; the glossary is NOT vendored.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const termsPath = process.argv[2]
if (termsPath === undefined) {
  console.error('usage: node scripts/calibrate-i18n.mjs <terms.json>')
  process.exit(1)
}
const glossary = JSON.parse(readFileSync(termsPath, 'utf8'))
const ours = JSON.parse(readFileSync(new URL('../data/i18n-zh.json', import.meta.url), 'utf8'))

/** category priority per map, then '' bulk, else keep. */
const CATEGORY_PRIORITY = {
  spells: ['spell', ''],
  skills: ['skill', 'variantrule', ''],
  conditions: ['condition', 'status', 'variantrule', ''],
  mastery: ['itemMastery', 'variantrule', ''],
  weaponProperties: ['itemProperty', 'variantrule', ''],
  classNames: ['class', 'variantrule', ''],
  races: ['race', 'variantrule', ''],
  features: ['classFeature', 'subclassFeature', 'feat', 'variantrule', ''],
  schools: ['', 'spell'],
  damageTypes: ['variantrule', '', 'spell'],
  weapons: ['item', ''],
  armor: ['item', ''],
  gear: ['item', ''],
}

// Maps that also get an ADD pass: every glossary term under these categories
// is added if the map lacks it, so coverage grows with each calibration run.
const ADD_CATEGORIES = {
  spells: ['spell'],
}

// index: en -> category -> ARRAY of [cn, originalKey], first non-discussed
// wins per bucket; the original key enables case-insensitive retries.
const index = new Map()
for (const it of glossary.items) {
  if (it.to_be_discussed) continue
  const en = String(it.en).trim()
  if (en === '') continue
  if (!index.has(en)) index.set(en, new Map())
  const cat = it.category === undefined ? '' : String(it.category)
  if (!index.get(en).has(cat)) index.get(en).set(cat, [])
  index.get(en).get(cat).push([it.cn, en])
}

// Case-folded side index for itemProperty, whose glossary keys some entries
// lowercase ("light", "finesse") — a plain index.get('Light') misses them.
const itemPropertyLower = new Map()
for (const it of glossary.items) {
  if (it.to_be_discussed || it.category !== 'itemProperty') continue
  const key = String(it.en).trim().toLowerCase()
  if (!itemPropertyLower.has(key)) itemPropertyLower.set(key, it.cn)
}

function resolve(en, priority) {
  // Weapon properties first: the closed 9-entry set must beat the bulk
  // category, whose "Light" -> 光线 (a spells-sync artifact) would otherwise
  // clobber the Light WEAPON property -> 轻型.
  if (priority[0] === 'itemProperty') {
    const lower = itemPropertyLower.get(en.toLowerCase())
    if (lower !== undefined) return lower
  }
  const buckets = index.get(en)
  if (buckets === undefined) return null
  for (const cat of priority) {
    const bucket = buckets.get(cat)
    if (bucket !== undefined && bucket.length > 0) return bucket[0][0]
  }
  return null
}

const report = []
for (const [mapName, entries] of Object.entries(ours)) {
  const priority = CATEGORY_PRIORITY[mapName]
  if (priority === undefined || entries === null || typeof entries !== 'object') continue
  let changed = 0
  for (const en of Object.keys(entries)) {
    const cn = resolve(en, priority)
    if (cn !== null && cn !== entries[en]) {
      entries[en] = cn
      changed += 1
    }
  }
  // Add pass: pull in glossary terms the map does not have yet.
  const addCats = ADD_CATEGORIES[mapName]
  let added = 0
  if (addCats !== undefined) {
    for (const it of glossary.items) {
      if (it.to_be_discussed || !addCats.includes(it.category)) continue
      const en = String(it.en).trim()
      if (en === '' || entries[en] !== undefined) continue
      entries[en] = it.cn
      added += 1
    }
  }
  report.push(`${mapName}: ${changed} corrected, ${added} added`)
}

ours._meta.calibrated_against = 'tjliqy/5etools-cn@cn2.0 docs/terms-20260922-142718.json'
ours._meta.calibrated_at = new Date().toISOString()

writeFileSync(new URL('../data/i18n-zh.json', import.meta.url), JSON.stringify(ours, null, 1) + '\n', 'utf8')
console.log(report.join('\n'))
