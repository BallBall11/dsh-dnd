/**
 * tools/lookup.mjs — bundled SRD dataset lookup.
 *
 * v0.1.0 re-read and re-parsed the whole dataset on EVERY call. The 2014 file
 * carries ~1453 records, so a lookup that should be a map hit was doing a
 * multi-megabyte JSON.parse each time. Here the parsed document is cached
 * against the file's mtime, so a dataset rebuild invalidates it automatically
 * and nothing else ever pays the parse twice.
 *
 *   dnd_srd_lookup   search spells / monsters / equipment / conditions / ...
 */

import { DATA_ROOT, MtimeCache, readActiveCampaign, readTextOrUndefined, dndRoot } from './shared.mjs'
import { sessionOf } from './session-scope.mjs'
// Which file answers which query:
//   - ruleset "2014": `class` category, or a bare class name with no
//     category ("bard", "wizard") -> srd-2014-fulltext.json (full class
//     reference); everything else -> srd-2014.json, MERGED with
//     supplemental.json (hand-curated non-SRD spells/features; their
//     entries are tagged "[curated]" in the output so SRD and supplement
//     stay distinguishable).
//   - ruleset "2024": srd-2024.json, searched as-is; `classes` is a
//     structured array there, so the full-text class route is 2014-only.
const DATASETS = {
  2014: `${DATA_ROOT}/srd-2014.json`,
  2024: `${DATA_ROOT}/srd-2024.json`,
}
const SUPPLEMENTAL = `${DATA_ROOT}/supplemental.json`
// The 2014->2024 rename map (Converting to SRD 5.2.1, CC-BY-4.0). Applied
// when a 2024 lookup misses so an old SRD 5.1 name still resolves to the
// renamed entry, and when a 2014 lookup misses so a 2024 name resolves back.
const RENAMES = `${DATA_ROOT}/srd-2024-renames.json`

// The FULL 2014 SRD (https://github.com/BTMorton/dnd-5e-srd), carried as a
// complete copy: per-class sections with hit points, proficiencies, starting
// equipment, the 20-level class table and every feature in prose. Its shape
// is section objects rather than the array-of-entries shape of DATASETS, so
// only the `class` category reads it.
const FULL_DATASET_2014 = `${DATA_ROOT}/srd-2014-fulltext.json`
// The upstream files use LF; the renderers below need newlines without
// depending on this file's own line-ending convention.
const NL = String.fromCharCode(10)

/** Caller-facing category -> dataset array key. */
const CATEGORY_KEYS = {
  spell: 'spells',
  monster: 'monsters',
  item: 'equipment',
  equipment: 'equipment',
  condition: 'conditions',
  'magic-item': 'magic_items',
  'class-feature': 'features',
  feature: 'features',
  class: 'classes',
  species: 'species',
  race: 'species',
  background: 'backgrounds',
  feat: 'feats',
  weapon: 'equipment',
  armor: 'equipment',
}

/** Dataset array key -> caller-facing category label. */
function labelForKey(key) {
  if (key === 'magic_items') return 'magic-item'
  if (key === 'features') return 'class-feature'
  return key
}

export const name = 'dnd-srd'

/** Cache of parsed datasets, keyed by ruleset and invalidated on mtime. */
const cache = new MtimeCache()

/**
 * A dataset file that is absent is a BROKEN INSTALL, not a failed lookup.
 *
 * The two used to read almost the same, and that is how this defect hid: the
 * tool answered `SRD dataset not found for ruleset 2014: <path>`, which reads
 * like "that entry does not exist" — a perfectly ordinary answer a DM would
 * accept and move past. A missing shipped dataset means the PACKAGE is
 * incomplete, which is a fact about the install and has a fix, so the message
 * says which file is missing, where it was looked for, and what to do. It ends
 * with a distinct `[dataset missing]` tag so a caller (and a test) can tell the
 * two apart without guessing from prose.
 *
 * @param path - the dataset path that could not be read.
 * @param ruleset - "2014" or "2024".
 * @returns the operator-facing message.
 */
function missingDatasetMessage(path, ruleset) {
  return `[dataset missing] The ${ruleset} SRD dataset is not installed: ${path}\n`
    + `dnd_srd_lookup reads its data from the dsh-dnd package's own data/ directory `
    + `(${DATA_ROOT}). A missing file there means the plugin package is incomplete, `
    + `not that the entry does not exist — no search was performed.\n`
    + `To fix: reinstall the bundle - the datasets ship with it.`
}

/**
 * Read a dataset, cached against the file's mtime.
 * @param fs - the host fs service.
 * @param ruleset - "2014" or "2024".
 * @returns `{ data }` or `{ error }`.
 */
export async function loadDataset(fs, ruleset) {
  const path = DATASETS[ruleset]
  if (path === undefined) return { error: `Unknown ruleset "${ruleset}".` }
  const target = await fs.resolve(path)
  const stat = await fs.stat(target)
  if (stat === undefined) return { error: missingDatasetMessage(path, ruleset) }
  const stamp = `${stat.mtime ?? ''}:${stat.size ?? ''}`
  try {
    const data = await cache.get(`${ruleset}:${path}`, stamp, async () => JSON.parse(await fs.readText(target)))
    return { data }
  } catch (error) {
    return { error: `Failed to parse ${path}: ${error && error.message ? error.message : error}` }
  }
}


// Load the full 2014 dataset. Missing-file errors reuse loadDataset's
// operator-facing wording by proxying through its message builder.
async function loadFull2014(fs) {
  const target = await fs.resolve(FULL_DATASET_2014)
  if ((await fs.stat(target)) === undefined) return { error: missingDatasetMessage(FULL_DATASET_2014, '2014-full') }
  try {
    return { data: JSON.parse(await fs.readText(target)) }
  } catch (error) {
    return { error: `Failed to parse ${FULL_DATASET_2014}: ${error && error.message ? error.message : error}` }
  }
}

// Load the curated supplement. It ships with the bundle like the SRD files,
// so a missing file is the same broken-install condition and gets the same
// operator-facing message.
async function loadSupplemental(fs) {
  const target = await fs.resolve(SUPPLEMENTAL)
  if ((await fs.stat(target)) === undefined) return { error: missingDatasetMessage(SUPPLEMENTAL, '2014-supplement') }
  const stat = await fs.stat(target)
  const stamp = `${stat.mtime ?? ''}:${stat.size ?? ''}`
  try {
    const data = await cache.get(`supplemental:${SUPPLEMENTAL}`, stamp, async () => JSON.parse(await fs.readText(target)))
    return { data }
  } catch (error) {
    return { error: `Failed to parse ${SUPPLEMENTAL}: ${error && error.message ? error.message : error}` }
  }
}

// Load the 2014->2024 rename map. Optional in shape: if the file is absent
// the lookup still works, it just loses alias resolution - a degradation,
// not a broken install, because unlike the SRD files this one only adds
// convenience. Corrupt JSON, though, is surfaced.
async function loadRenames(fs) {
  const target = await fs.resolve(RENAMES)
  if ((await fs.stat(target)) === undefined) return { data: undefined }
  const stat = await fs.stat(target)
  const stamp = `${stat.mtime ?? ''}:${stat.size ?? ''}`
  try {
    const data = await cache.get(`renames:${RENAMES}`, stamp, async () => JSON.parse(await fs.readText(target)))
    return { data }
  } catch (error) {
    return { error: `Failed to parse ${RENAMES}: ${error && error.message ? error.message : error}` }
  }
}

/**
 * Find rename entries whose FROM or TO side matches the query.
 * @returns maps of lowercase matched name -> the [oldName, newName] pair.
 */
function aliasMaps(renames, query) {
  const to = new Map()
  const from = new Map()
  for (const group of ['spells', 'monsters', 'magic_items']) {
    for (const [oldName, newName] of Object.entries(renames[group] ?? {})) {
      if (oldName.toLowerCase().includes(query)) to.set(oldName.toLowerCase(), [oldName, newName])
      if (newName.toLowerCase().includes(query)) from.set(newName.toLowerCase(), [oldName, newName])
    }
  }
  return { to, from }
}

const CLASS_NAME_KEYS = new Set(['barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk', 'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard'])

// Case-insensitive class-name match against the full dataset's sections.
async function matchClassName(fs, query) {
  const loaded = await loadFull2014(fs)
  if (loaded.error !== undefined) return undefined
  const wanted = query.trim().toLowerCase()
  const hit = Object.keys(loaded.data).find((k) => CLASS_NAME_KEYS.has(k.toLowerCase()) && k.toLowerCase().includes(wanted))
  return hit
}

// Flatten the upstream content shape: a string, or a nested array of lines.
function flattenContent(content, out) {
  const acc = out ?? []
  if (typeof content === 'string') acc.push(content)
  else if (Array.isArray(content)) for (const item of content) flattenContent(item, acc)
  return acc
}

// Render ONE class section from the full 2014 SRD as a readable digest.
function renderClassSection(name, section) {
  const cf = section?.['Class Features']
  if (cf === undefined || cf === null) return `#${name}` + NL + '(no Class Features section found)'
  const cap = (text, n) => (text.length > n ? text.slice(0, n) + ' ...' : text)
  const lines = [`# ${name} (2014 SRD, full class reference)`]

  for (const [key, value] of Object.entries(cf)) {
    if (key === 'content' || value === null || value === undefined) continue
    if (value !== null && typeof value === 'object' && value.table !== undefined) {
      lines.push('', `## ${key}`)
      const t = value.table
      const cols = Object.keys(t)
      for (let i = 0; i < (t.Level?.length ?? 0); i += 1) {
        const parts = []
        const prof = t['Proficiency Bonus']?.[i] ?? t['Proficieny Bonus']?.[i]
        if (prof !== undefined) parts.push('prof ' + String(prof).trim())
        const feats = String(t.Features?.[i] ?? '').trim()
        if (feats !== '' && feats !== '-') parts.push(feats)
        for (const c of cols) {
          if (c === 'Level' || c === 'Features' || c === 'Proficiency Bonus' || c === 'Proficieny Bonus') continue
          const v = String(t[c][i] ?? '').trim()
          if (v !== '' && v !== '-') parts.push(`${c} ${v}`)
        }
        lines.push(`- Lv${i + 1}: ` + parts.join(' | '))
      }
      continue
    }
    const body = flattenContent(typeof value === 'string' ? value : value.content)
      .map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
    if (body.length === 0) continue
    lines.push('', `## ${key}`, ...body.map((l) => '- ' + cap(l, 500)))
  }
  return lines.join(NL)
}

// The `class` category entry point: match, render, cap.
async function classReference(fs, query, max) {
  const loaded = await loadFull2014(fs)
  if (loaded.error !== undefined) return loaded.error
  const wanted = query.trim().toLowerCase()
  const names = Object.keys(loaded.data).filter((k) => CLASS_NAME_KEYS.has(k.toLowerCase()))
  const hits = names.filter((k) => k.toLowerCase().includes(wanted))
  if (hits.length === 0) {
    return `[no match] No class matches "${query}" (2014 full reference). Known: ${names.join(',')}.`
  }
  const top = hits.slice(0, Math.max(1, Math.min(max, 3)))
  const SEP = NL + NL + '=====' + NL + NL
  return top.map((name) => renderClassSection(name, loaded.data[name])).join(SEP)
}

// Render one structured 2024 class as a readable digest. The 2024 dataset
// has no class prose (the upstream carries none), but it does carry the
// build-defining facts: hit die, saves, spellcasting block, subclass list
// and the full 20-level table.
function renderClass2024(c) {
  const lines = [`# ${c.name} (2024 SRD)`]
  const facts = []
  if (c.hitDie) facts.push(`hit die ${c.hitDie}`)
  if (c.primaryAbility) facts.push(`primary ability: ${c.primaryAbility}`)
  if (Array.isArray(c.saves) && c.saves.length > 0) facts.push(`save profs: ${c.saves.join(', ')}`)
  if (c.armorTraining) facts.push(`armor: ${c.armorTraining}`)
  if (c.weaponTraining) facts.push(`weapons: ${c.weaponTraining}`)
  if (c.otherTraining) facts.push(`other: ${c.otherTraining}`)
  if (c.skillChoices) facts.push(`skills: ${c.skillChoices}`)
  if (facts.length > 0) lines.push('', ...facts.map((f) => `- ${f}`))
  if (c.spellcasting !== null && c.spellcasting !== undefined) {
    const sc = c.spellcasting
    lines.push('', `## Spellcasting`, `- ability ${sc.ability ?? '?'}, ${sc.mechanic ?? 'unknown'} caster, from level ${sc.level ?? '?'}`)
    for (const note of sc.notes ?? []) lines.push(`- ${note.name}: ${note.text}`)
  }
  if (Array.isArray(c.subclasses) && c.subclasses.length > 0) {
    lines.push('', '## Subclasses', `- ${c.subclasses.join(', ')}`)
  }
  lines.push('', '## Level table')
  for (const row of c.table ?? []) {
    const parts = [`prof ${row.profBonus}`]
    if (row.features?.length > 0) parts.push(row.features.join(', '))
    if (row.cantripsKnown !== undefined) parts.push(`cantrips ${row.cantripsKnown}`)
    if (row.preparedSpells !== undefined) parts.push(`prepared ${row.preparedSpells}`)
    if (row.spellsKnown !== undefined) parts.push(`known ${row.spellsKnown}`)
    if (row.spellSlots !== undefined) {
      parts.push('slots ' + Object.entries(row.spellSlots).map(([lv, n]) => `L${lv}:${n}`).join(' '))
    }
    lines.push(`- Lv${row.level}: ` + parts.join(' | '))
  }
  return lines.join(NL)
}

// 2024 class route: match against the structured classes array and render.
function classReference2024(data, query, max) {
  const classes = Array.isArray(data.classes) ? data.classes : []
  const wanted = query.trim().toLowerCase()
  const hits = classes.filter((c) => String(c.name ?? '').toLowerCase().includes(wanted))
  if (hits.length === 0) {
    return `[no match] No class matches "${query}" (2024). Known: ${classes.map((c) => c.name).join(', ')}.`
  }
  const top = hits.slice(0, Math.max(1, Math.min(max, 3)))
  const SEP = NL + NL + '=====' + NL + NL
  return top.map(renderClass2024).join(SEP)
}
/** Render one dataset entry as compact markdown. */
function formatEntry(entry, category) {
  const name = entry.name ?? '(unnamed)'
  const extra = []
  if (typeof entry.hit_points === 'number') extra.push(`HP ${entry.hit_points}`)
  if (typeof entry.armor_class === 'number') extra.push(`AC ${entry.armor_class}`)
  if (typeof entry.level === 'number') extra.push(`Level ${entry.level}`)
  if (typeof entry.challenge_rating === 'number') extra.push(`CR ${entry.challenge_rating}`)
  const description = entry.description ?? entry.text ?? ''
  const body = typeof description === 'string' ? description : JSON.stringify(description)
  const trimmed = body.length > 2500 ? `${body.slice(0, 2500)}…` : body
  return `### ${name}${category !== undefined ? ` (${category})` : ''}${extra.length > 0 ? ` | ${extra.join(' | ')}` : ''}\n${trimmed}`
}

/**
 * Score a fuzzy match so a near miss still surfaces something useful.
 * Exact > prefix > substring; the skill's own lookup does the same.
 * @returns a score, or -1 for no match.
 */
function scoreName(name, query) {
  const lower = name.toLowerCase()
  if (lower === query) return 3
  if (lower.startsWith(query)) return 2
  if (lower.includes(query)) return 1
  return -1
}

/**
 * Build this module's tools.
 * @param ctx - host context; `fs` is optional (tools degrade with a message).
 * @returns an array of tool definitions.
 */
export function buildTools(ctx) {
  // Read lazily, not once at mount: `ctx.get` is a point-in-time read, and a
  // mount that runs before the filesystem backend is ready would otherwise
  // capture undefined for the life of the process.
  const getFs = () => ctx.get('fs')
  const renderText = (_args, value) => [{ type: 'text', text: String(value) }]

  const lookup = {
    name: 'dnd_srd_lookup',    description: 'Look up an entry in the bundled 5e SRD datasets (rulesets 2014 and 2024) by name and optional category. Ranks exact and prefix matches above substring hits. For the full module corpus (not just SRD) use dnd_campaign_search.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or partial name, e.g. "fireball", "goblin", "longsword", "poisoned".' },
        ruleset: { type: 'string', description: 'Ruleset to search: "2014" (default) or "2024".', enum: ['2014', '2024'] },
        category: {
          type: 'string',
          description: 'Optional category filter. Omit to search every category.',
          enum: ['spell', 'monster', 'item', 'equipment', 'condition', 'magic-item', 'class-feature', 'class', 'weapon', 'armor'],
        },        max: { type: 'integer', description: 'Maximum matches to return (default 5).' },
      },
      required: ['query'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      // Validated BEFORE anything is loaded. `String(undefined)` is the string
      // "undefined" — non-empty, so the old emptiness check passed and the tool
      // searched the SRD for a word that does not exist, reporting "No SRD
      // entry matches \"undefined\"". That reads like a legitimate miss rather
      // than a missing argument, which is what made it survive so long.
      if (args.query === undefined || args.query === null || String(args.query).trim() === '') {
        return 'dnd_srd_lookup needs a `query`, e.g. "fireball" or "goblin". '
          + 'Nothing was searched.'
      }

      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'
      const ruleset = args.ruleset === undefined ? '2014' : String(args.ruleset)
      if (DATASETS[ruleset] === undefined) {
        return `Unknown ruleset "${ruleset}". Known: ${Object.keys(DATASETS).join(', ')}. Nothing was searched.`
      }
      const loaded = await loadDataset(fs, ruleset)
      if (loaded.error !== undefined) return loaded.error
      const data = loaded.data
      if (data === null || typeof data !== 'object') return `SRD dataset for ${ruleset} is not an object.`

      const query = String(args.query).toLowerCase().trim()
      const max = Number(args.max) > 0 ? Number(args.max) : 5

      const wantedKey = args.category !== undefined ? CATEGORY_KEYS[String(args.category).toLowerCase()] : undefined
      if (args.category !== undefined && wantedKey === undefined) {
        return `Unknown category "${args.category}". Known: ${Object.keys(CATEGORY_KEYS).join(', ')}.`
      }
      // The full-text class document and the curated supplement are both
      // 2014 assets; 2024 classes are rendered from the structured dataset.
      if (ruleset === '2014') {
        if (wantedKey === 'classes') return await classReference(fs, String(args.query), max)
        if (wantedKey === undefined) {
          const className = await matchClassName(fs, String(args.query))
          if (className !== undefined) return await classReference(fs, className, max)
        }
      } else if (wantedKey === 'classes' || wantedKey === undefined) {
        const classes = Array.isArray(data.classes) ? data.classes : []
        const wanted = query.toLowerCase()
        const classHit = classes.find((c) => String(c.name ?? '').toLowerCase() === wanted)
          ?? classes.find((c) => String(c.name ?? '').toLowerCase().startsWith(wanted))
        if (wantedKey === 'classes' && classHit === undefined) {
          return classReference2024(data, String(args.query), max)
        }
        if (classHit !== undefined) return classReference2024(data, String(classHit.name), max)
      }
      const keys = wantedKey !== undefined
        ? [wantedKey]
        : Object.keys(data).filter((k) => Array.isArray(data[k]))

      const supplemental = ruleset === '2014' ? await loadSupplemental(fs) : { data: undefined }
      if (supplemental.error !== undefined) return supplemental.error
      const supData = supplemental.data
      const supKeys = supData !== null && typeof supData === 'object'
        ? Object.keys(supData).filter((k) => Array.isArray(supData[k]) && (wantedKey === undefined || k === wantedKey))
        : []

      const scored = []
      for (const key of keys) {
        const entries = data[key]
        if (!Array.isArray(entries)) continue
        for (const entry of entries) {
          if (entry === null || typeof entry !== 'object') continue
          const score = scoreName(String(entry.name ?? ''), query)
          if (score < 0) continue
          scored.push({ entry, category: labelForKey(key), score })
        }
      }
      // Curated non-SRD entries join the same scored scan; the label marks
      // them so a DM can tell an SRD hit from a house supplement.
      for (const key of supKeys) {
        const entries = supData[key]
        if (!Array.isArray(entries)) continue
        for (const entry of entries) {
          if (entry === null || typeof entry !== 'object') continue
          const score = scoreName(String(entry.name ?? ''), query)
          if (score < 0) continue
          scored.push({ entry, category: `${labelForKey(key)} · curated`, score })
        }
      }
      if (scored.length === 0) {
        // Nothing matched under this ruleset's names. Before reporting an
        // honest miss, try the 2014->2024 rename map: a query under the OTHER
        // ruleset's naming still resolves (2024 old name -> new entry, with
        // the rename called out; 2014 new name -> old entry, likewise).
        const renames = await loadRenames(fs)
        if (renames.error !== undefined) return renames.error
        if (renames.data !== undefined) {
          const { to, from } = aliasMaps(renames.data, query)
          const map = ruleset === '2024' ? to : from
          for (const [aliasName, [oldName, newName]] of map) {
            const mappedName = ruleset === '2024' ? newName : oldName
            const alt = []
            const collect = (key) => {
              const entries = data[key]
              if (!Array.isArray(entries)) return
              for (const entry of entries) {
                if (entry === null || typeof entry !== 'object') continue
                const score = scoreName(String(entry.name ?? ''), mappedName.toLowerCase())
                if (score > 0) alt.push({ entry, category: labelForKey(key), score })
              }
            }
            for (const key of wantedKey !== undefined ? [wantedKey] : Object.keys(data).filter((k) => Array.isArray(data[k]))) collect(key)
            if (alt.length > 0) {
              alt.sort((a, b) => b.score - a.score)
              const direction = ruleset === '2024' ? `renamed in SRD 5.2.1: "${oldName}" is now "${newName}"` : `"${newName}" was renamed from "${oldName}" in SRD 5.2.1`
              return `[ruleset ${ruleset}] ${alt.length} match${alt.length === 1 ? '' : 'es'} — ${direction}:\n\n`
                + alt.slice(0, max).map((m) => formatEntry(m.entry, m.category)).join('\n\n---\n\n')
            }
          }
          if (ruleset === '2024' && renames.data.omitted !== undefined) {
            for (const [oldName, replacement] of Object.entries(renames.data.omitted)) {
              if (!oldName.toLowerCase().includes(query)) continue
              return `[omitted in SRD 5.2.1] "${oldName}" has no stat block in the 2024 rules. `
                + `The conversion guide recommends using "${replacement}" instead.`
            }
          }
        }
        // Distinct from missingDatasetMessage() on purpose: reaching here means
        // the dataset WAS loaded and searched, so the entry genuinely is absent.
        // The tag is the machine-checkable half of that distinction.
        return `[no match] No SRD entry matches "${args.query}"`
          + `${args.category !== undefined ? ` in category ${args.category}` : ''} `
          + `(ruleset ${ruleset}). The dataset was searched, so this entry is simply not in it.`
      }
      scored.sort((a, b) => b.score - a.score || String(a.entry.name).localeCompare(String(b.entry.name)))
      const top = scored.slice(0, max)
      const head = `[ruleset ${ruleset}] ${scored.length} match${scored.length === 1 ? '' : 'es'}`
        + (scored.length > top.length ? `, showing the best ${top.length}:` : ':')
      return `${head}\n\n` + top.map((m) => formatEntry(m.entry, m.category)).join('\n\n---\n\n')
    },
  }

  return [lookup]
}
