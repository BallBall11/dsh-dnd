/**
 * tools/panel-meta.mjs — the display index the character panel reads.
 *
 * The panel gets one payload (`GET /dnd/meta`) with everything it needs to
 * render a character in Chinese and to show WHAT a spell or weapon does:
 *
 *   i18n     — the EN->CN maps from data/i18n-zh.json (abilities, skills, ...)
 *   spells   — name -> { zh, level, school, info } where info is the short
 *              combat line ("8d6 火焰 · DEX豁免") parsed from the SRD text
 *   classes  — ruleset -> class -> per-level feature names, so the panel can
 *              show the class features a character HAS at its level even when
 *              the sheet's Features & Traits section was never filled in
 *   weapons  — name -> { zh, damage, properties, mastery } (2024 mastery
 *              assignments; the panel renders the special action a mastery
 *              grants)
 *   armor    — name -> { zh, ac }
 *
 * The payloads are derived from the shipped datasets + the curated i18n file,
 * built once per process and cached. Rebuilding on every request would parse
 * two multi-megabyte datasets; the inputs only change when the bundle does.
 */

import { DATA_ROOT, MtimeCache, parseJsonLoose } from './shared.mjs'
import { loadDataset } from './lookup.mjs'

const I18N = `${DATA_ROOT}/i18n-zh.json`

const cache = new MtimeCache()

/** Damage-type words that can follow a dice expression in a spell description. */
const DAMAGE_WORDS = ['Acid', 'Bludgeoning', 'Cold', 'Fire', 'Force', 'Lightning', 'Necrotic', 'Piercing', 'Poison', 'Psychic', 'Radiant', 'Slashing', 'Thunder']

const SAVE_ABBR = { Dexterity: 'DEX', Constitution: 'CON', Intelligence: 'INT', Wisdom: 'WIS', Charisma: 'CHA', Strength: 'STR' }

/**
 * Translate the damage line "1d4 Piercing" -> "1d4 穿刺" (multi-word types
 * handled longest-first so "Bludgeoning" is matched before its parts).
 * @param damage - the dataset damage string, e.g. "1d8 Slashing" or "1d4 Piercing or Slashing".
 */
function translateDamage(damage, i18n) {
  let out = String(damage)
  const types = Object.keys(i18n.damageTypes).sort((a, b) => b.length - a.length)
  for (const t of types) out = out.replace(new RegExp('\\b' + t + '\\b', 'gi'), i18n.damageTypes[t])
  return out
}

/** Translate "AC 11 + DEX" -> "AC 11 + 敏捷". */
function translateAc(ac, i18n) {
  return String(ac).replace(/\b(STR|DEX|CON|INT|WIS|CHA)\b/g, (code) => i18n.abilities[code] ?? code)
}

function spellInfoFor(entry, i18n) {
  if (entry === null || typeof entry !== 'object') return null
  const parts = []
  const description = typeof entry.description === 'string' ? entry.description : ''
  const dice = description.match(/\b\d+d\d+\b/i)
  if (dice !== null) {
    const window = description.slice(Math.max(0, dice.index - 60), dice.index + 100)
    const type = DAMAGE_WORDS.find((t) => window.includes(t) || window.includes(t.toLowerCase()))
    parts.push(dice[0] + (type !== undefined ? ' ' + (i18n.damageTypes[type] ?? type) : ''))
  }
  const save = description.match(/\b(Dexterity|Constitution|Intelligence|Wisdom|Charisma|Strength)\s+saving throw\b/i)
  if (save !== null) parts.push(`${SAVE_ABBR[save[1]] ?? save[1]}豁免`)
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * Build the panel meta payload.
 * @param fs - the host fs service.
 * @returns `{ data }` or `{ error }`.
 */
export async function buildPanelMeta(fs) {
  const target = await fs.resolve(I18N)
  const stat = await fs.stat(target)
  if (stat === undefined) return { error: `[meta missing] ${I18N} is not installed - the bundle is incomplete. Reinstall it.` }
  const stamp = `${stat.mtime ?? ''}:${stat.size ?? ''}`
  try {
    const data = await cache.get('panel-meta', stamp, async () => {
      const i18n = parseJsonLoose(await fs.readText(target))
      const spells = {}
      const classes = { '2014': {}, '2024': {} }
      const weapons = {}
      const armor = {}

      // 2024 first, then 2014 overrides shared names: the 2014 wording is the
      // ruleset the bundle defaults to, and the panel shows whichever campaign
      // ruleset via the per-class feature tables, not the spell info line.
      for (const ruleset of ['2024', '2014']) {
        const loaded = await loadDataset(fs, ruleset)
        if (loaded.error !== undefined || loaded.data === null || typeof loaded.data !== 'object') continue
        const data = loaded.data
        for (const spell of Array.isArray(data.spells) ? data.spells : []) {
          if (spell === null || typeof spell !== 'object' || typeof spell.name !== 'string') continue
          if (spells[spell.name] !== undefined) continue
          spells[spell.name] = {
            zh: i18n.spells[spell.name] ?? null,
            level: Number.isFinite(spell.level) ? spell.level : null,
            school: typeof spell.school === 'string' ? (i18n.schools[spell.school] ?? spell.school) : null,
            info: spellInfoFor(spell, i18n),
          }
        }
        for (const cls of Array.isArray(data.classes) ? data.classes : []) {
          if (cls === null || typeof cls !== 'object' || typeof cls.name !== 'string') continue
          const byLevel = []
          for (const row of Array.isArray(cls.table) ? cls.table : []) {
            byLevel.push(Array.isArray(row.features) ? row.features : [])
          }
          classes[ruleset][cls.name] = byLevel
        }
        for (const item of Array.isArray(data.equipment) ? data.equipment : []) {
          if (item === null || typeof item !== 'object' || typeof item.name !== 'string') continue
          if (typeof item.damage === 'string' && item.damage !== '' && weapons[item.name] === undefined) {
            weapons[item.name] = {
              zh: i18n.weapons[item.name] ?? null,
              damage: translateDamage(item.damage, i18n),
              // Properties arrive translated ("灵巧", "轻型") so the panel
              // renders them verbatim instead of re-mapping client-side.
              properties: (Array.isArray(item.properties) ? item.properties : [])
                .map((p) => i18n.weaponProperties[p] ?? p),
              mastery: i18n.weaponMasteryByWeapon[item.name] ?? null,
            }
          }
          if (typeof item.ac === 'string' && item.ac !== '' && armor[item.name] === undefined) {
            armor[item.name] = { zh: i18n.armor[item.name] ?? null, ac: translateAc(item.ac, i18n) }
          }
        }
      }

      return {
        // The i18n maps sit at the TOP LEVEL, not under an `i18n` key: the
        // panel's zh() helper looks up meta.skills / meta.abilities directly,
        // and an earlier nesting under meta.i18n made the whole translation
        // layer silently inert — every card rendered English with no error.
        abilities: i18n.abilities ?? {}, skills: i18n.skills ?? {}, conditions: i18n.conditions ?? {},
        damageTypes: i18n.damageTypes ?? {}, schools: i18n.schools ?? {},
        weaponProperties: i18n.weaponProperties ?? {}, mastery: i18n.mastery ?? {}, features: i18n.features ?? {},
        gear: i18n.gear ?? {}, armorNames: i18n.armor ?? {},
        classNames: i18n.classNames ?? {}, races: i18n.races ?? {},
        // Name-only fallbacks for equipment the datasets do not index
        // (an instrument stashed in weapons, a small knife in gear).
        weaponNames: i18n.weapons ?? {},
        spells,
        classes,
        weapons,
        armor,
      }
    })
    return { data }
  } catch (error) {
    return { error: `Failed to build panel meta: ${error && error.message ? error.message : error}` }
  }
}

/**
 * The `**Name** — prose` entries of the sheet's Features & Traits section.
 * That section is narrative, so the structured state does not carry it — but
 * the panel needs the list. Parsing happens server-side so the panel keeps
 * rendering what the Host sends.
 * @param narrative - the sheet's narrative blob.
 * @returns an array of `{ name, text }`.
 */
export function extractFeatures(narrative) {
  if (typeof narrative !== 'string' || narrative === '') return []
  const features = []
  const pattern = /\*\*([^*]+)\*\*\s*[—–-]+\s*([^\n*]+)/g
  let match
  while ((match = pattern.exec(narrative)) !== null) {
    const name = match[1].trim()
    const text = match[2].trim()
    // The composed sheet's legacy metadata line ("**Player:** — ...") matches
    // the same shape; it is file metadata, not a feature.
    if (name === '' || name.endsWith(':')) continue
    features.push({ name, text })
  }
  return features
}
