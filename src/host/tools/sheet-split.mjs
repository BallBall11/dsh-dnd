/**
 * tools/sheet-split.mjs — split a character sheet into structured state and
 * narrative text.
 *
 * ## The contract
 *
 * `splitSheet(text)` returns three things:
 *
 *   state      the structured half, as a state-schema object
 *   narrative  every section that must NOT be parsed into fields
 *   sections   the raw section map, so a writer can reassemble losslessly
 *
 * The hard guarantee is this: **narrative sections come back byte-identical to
 * their input.** A sheet is hand-written prose maintained across sessions by a
 * human; anything this module does that alters a single character of it is a
 * data-loss bug regardless of how good the parsed fields look.
 *
 * ## Which sections are which
 *
 * Classification follows the authoritative template
 * (`.agents/skills/dnd/templates/character-sheet.md`) read section by section,
 * and was confirmed with the requester:
 *
 *   structured  Identity, Ability Scores, Combat Stats, Saving Throws, Skills,
 *               Attacks, Spell Slots, Known Spells / Cantrips, Equipment &
 *               Inventory
 *   narrative   Character Pillar, Campaign History, Features & Traits,
 *               Backstory & Notes
 *
 * Two judgement calls worth recording:
 *
 *   Features & Traits is narrative. Its entries are `**Name** — prose`, and
 *   the prose is the content; parsing it into a list of names would discard
 *   the part that matters. The requester's rule was explicit: "特性和 traits
 *   应该是文本化的，放入 md 文档".
 *
 *   Equipment is structured, as a name -> quantity map. Loose junk a character
 *   plausibly carries without it being worth listing is deliberately NOT
 *   enumerated — the model judges that from context rather than the schema
 *   forcing an exhaustive inventory.
 *
 * Unknown sections are treated as narrative. A future template addition should
 * survive a round trip untouched rather than be silently dropped for not being
 * recognized.
 */

import { parseCharacterSheet } from './sheet-parse.mjs'
import {
  normalizeState,
  SCHEMA_VERSION,
} from './state-schema.mjs'
import { parseFrontmatter, renderFrontmatter } from './frontmatter.mjs'
import { METADATA_ORDER } from './clock.mjs'
import { parseCurrency as parseCoins, formatCurrency } from './state-rules.mjs'

/** Sections parsed into fields. Everything else is preserved as text. */
export const STRUCTURED_SECTIONS = [
  'identity',
  'ability scores',
  'combat stats',
  'saving throws',
  'skills',
  'attacks',
  'spell slots',
  'known spells',
  'equipment',
]

/** The summary block marker. Everything between these lines is generated. */
export const SUMMARY_OPEN = '<!-- dsh-dnd:generated -->'
export const SUMMARY_CLOSE = '<!-- /dsh-dnd:generated -->'

/**
 * Split a document into `## Heading` sections, preserving the exact text.
 *
 * Unlike `splitSections` in shared.mjs (which trims bodies for reading), this
 * keeps every byte so a write can reproduce the input. The `raw` field is the
 * complete section text including its heading line; `body` is what follows it.
 *
 * The generated summary block is emitted as its own section, fenced by its
 * `<!-- dsh-dnd:generated -->` markers rather than by a heading. It must be
 * separable because it is regenerated on every write: leaving it inside the
 * preamble would pull it into the narrative, and the next write would nest a
 * second copy inside the first.
 *
 * `title` is the document's `# Name` heading, returned separately because it
 * is the one heading that is content rather than a section label.
 *
 * @param text - the document.
 * @returns `{ title, sections }` where sections is
 *   `[{ heading, level, raw, body }]`.
 */
export function splitSectionsExact(text) {
  const src = String(text ?? '')
  const lines = src.split(/\r?\n/)
  const out = []
  let current = null
  let title = null
  let inSummary = false

  for (const line of lines) {
    const trimmed = line.trim()

    // The generated block is captured whole, markers included, so it can be
    // discarded rather than mistaken for prose.
    if (trimmed === SUMMARY_OPEN) {
      if (current !== null) out.push(current)
      current = { heading: 'generated', level: 0, lines: [] }
      inSummary = true
      continue
    }
    if (trimmed === SUMMARY_CLOSE) {
      current.lines.push(line)
      out.push(current)
      current = null
      inSummary = false
      continue
    }
    if (inSummary) {
      current.lines.push(line)
      continue
    }

    const match = line.match(/^(#{1,6})\s+(.*)$/)
    if (match !== null) {
      const level = match[1].length
      const heading = match[2].trim()
      // A level-1 heading is the character's name, not a section. Keeping it
      // out of the section list means the narrative cannot accidentally
      // contain (and a re-composition cannot duplicate) the title line.
      if (level === 1 && title === null) {
        title = line
        continue
      }
      if (current !== null) out.push(current)
      current = { heading, level, lines: [] }
      continue
    }
    if (current === null) {
      // Preamble before the first `##` heading (the `**Player:** ...`
      // metadata line). Kept as a pseudo-section so nothing is lost.
      current = { heading: null, level: 0, lines: [] }
    }
    current.lines.push(line)
  }
  if (current !== null) out.push(current)

  const sections = out.map((s) => {
    const raw = s.heading === null
      ? s.lines.join('\n')
      : (s.heading === 'generated'
        ? s.lines.join('\n')
        : `${'#'.repeat(s.level)} ${s.heading}\n${s.lines.join('\n')}`)
    return { heading: s.heading, level: s.level, raw, body: s.lines.join('\n') }
  })
  return { title, sections }
}

/** True when a heading names one of the structured sections. */
function isStructuredHeading(heading) {
  if (heading === null) return false
  const h = heading.toLowerCase()
  return STRUCTURED_SECTIONS.some((s) => h.startsWith(s))
}

/**
 * True for the generated summary block, which is not source material.
 *
 * The unnamed preamble (`heading === null`) is NOT a summary block: it holds
 * whatever sits between the title and the first `##`, which on an unmigrated
 * sheet is the legacy `**Player:** ... **Last Updated:**` metadata line. The
 * block is identified by its own heading, set from the `<!-- dsh-dnd:generated -->`
 * markers in `splitSectionsExact`.
 */
function isSummaryBlock(heading) {
  return heading === 'generated' || heading === '/dsh-dnd:generated'
}

/**
 * The legacy inline metadata line, e.g.
 *   `**Player:** —  **Campaign:** morgansfort  **Last Updated:** 2026-09-04`
 *
 * Sheets written before frontmatter existed carry their file metadata here.
 * Once those values live in the frontmatter the inline copy is redundant, and
 * leaving it in the narrative would mean the same fact is maintained twice —
 * the drift this design exists to prevent.
 */
const LEGACY_META_LINE = /^\*\*Player:\*\*[\s\S]*?\*\*Last Updated:\*\*[^\n]*$/

/**
 * Drop the legacy metadata line from narrative text.
 *
 * Only applied when the values were actually available from frontmatter, so a
 * sheet that has not been migrated keeps its metadata rather than losing it.
 *
 * @param narrative - narrative text.
 * @param frontmatter - the parsed frontmatter.
 * @returns the narrative with a superseded metadata line removed.
 */
function stripLegacyMetadataLine(narrative, frontmatter) {
  // Only drop it when the frontmatter actually carries a replacement. A sheet
  // with no frontmatter keeps its inline metadata, which is then its only copy.
  if (frontmatter === undefined || frontmatter === null || frontmatter.campaign == null) return narrative
  return dropLegacyMetadataLine(narrative)
}

/**
 * Remove the legacy metadata line unconditionally.
 *
 * Used by the write path, which is about to emit a frontmatter block carrying
 * the same values. On read the line must survive when nothing replaces it; on
 * write a replacement is guaranteed, so leaving it would place the same fact in
 * two files and the next read would have to choose between them.
 *
 * @param narrative - narrative text.
 * @returns the narrative without the superseded line.
 */
export function dropLegacyMetadataLine(narrative) {
  return String(narrative ?? '')
    .split('\n')
    .filter((line) => !LEGACY_META_LINE.test(line.trim()))
    .join('\n')
    .replace(/^\n+/, '')
    .trim()
}

/**
 * Split a character sheet into structured state and narrative text.
 *
 * @param text - the whole `.md` file.
 * @param context - `{ campaign, name }` used to fill fields the file omits.
 * @returns `{ state, narrative, sections, title, metadata, warnings }`.
 */
export function splitSheet(text, context = {}) {
  const raw0 = String(text ?? '')
  const warnings = []

  // Frontmatter is file metadata, not character content, so it is removed
  // before anything else looks at the document — otherwise `---` would be
  // read as prose and `player:` as a section.
  const fm = parseFrontmatter(raw0)
  for (const w of fm.warnings ?? []) warnings.push(w)
  const src = fm.present ? fm.body.replace(/^\n/, '') : raw0

  const { title, sections } = splitSectionsExact(src)

  // The narrative is every section that is neither structured nor the
  // generated summary. Reassembled from `raw`, so it is byte-exact.
  const narrativeParts = []
  for (const section of sections) {
    if (isSummaryBlock(section.heading)) continue
    if (isStructuredHeading(section.heading)) continue
    narrativeParts.push(section.raw)
  }
  const narrative = stripLegacyMetadataLine(narrativeParts.join('\n').trim(), fm.data)

  // Structured fields come from the existing, tested parser rather than a
  // second implementation — two parsers would drift.
  const parsed = parseCharacterSheet(src)
  for (const w of parsed.warnings ?? []) warnings.push(w)

  const identity = parseIdentitySection(sections, fm.data)
  const state = normalizeState({
    schema: SCHEMA_VERSION,
    name: parsed.name || context.name || null,

    identity: {
      race: parsed.race ?? null,
      class: parsed.klass ?? null,
      level: parsed.level ?? null,
      background: parsed.background ?? null,
      alignment: identity.alignment ?? null,
      xp: num(parsed.xp),
      xpNext: num(parsed.xpNext),
    },

    abilities: abilitiesFrom(parsed.abilityScores),
    combat: {
      hp: parsed.hitPoints ?? { current: null, max: null },
      tempHp: parsed.tempHp ?? 0,
      ac: parsed.ac ?? null,
      mageArmorAc: parsed.mageArmorAc ?? null,
      initiative: num(parsed.initiative),
      speed: parsed.speed ?? null,
      hitDice: parseHitDice(parsed.hitDice),
      deathSaves: {
        successes: parsed.deathSaves?.success ?? 0,
        failures: parsed.deathSaves?.fail ?? 0,
      },
    },

    saves: parseSavingThrows(sections),
    proficientSaves: parseProficientSaves(sections),

    skills: Object.fromEntries(
      (parsed.skills ?? []).map((s) => [s.name, { ability: s.ability ?? null, bonus: s.bonus ?? null, proficient: s.proficient === true }]),
    ),

    attacks: (parsed.attacks ?? []).map((a) => ({
      name: a.name ?? '', bonus: a.bonus ?? null, damage: a.damage ?? null, type: a.type ?? null, notes: a.notes ?? null,
    })),

    spellcasting: {
      ability: grabFirst(src, /\*\*Spellcasting ability:\*\*\s*([A-Z]{3})/),
      saveDC: parsed.spellSaveDC ?? null,
      attackBonus: num(parsed.spellAttack),
    },

    spellSlots: parsed.spellSlotsByLevel ?? {},

    spells: {
      cantrips: splitList(parsed.cantrips),
      spellbook: splitList(grabFirst(src, /\*\*Spellbook[^:]*:\*\*\s*(.+)$/m)),
      prepared: splitList(parsed.prepared),
    },

    equipment: parseEquipment(sections),
    currency: parseCurrency(parsed.currency),

    warnings,
  })

  return { state, narrative, sections, title, metadata: fm.data, warnings }
}

/** Coerce to a finite number or null (`"+5"` -> 5). */
function num(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(String(value).replace(/^\+/, ''))
  return Number.isFinite(n) ? n : null
}

/** First capture group of the first match, or null. */
function grabFirst(text, re) {
  const m = String(text).match(re)
  return m !== null ? m[1].trim() : null
}

/** `"Light, Mage Hand"` -> `["Light", "Mage Hand"]`, dropping trailing notes. */
function splitList(value) {
  if (value === null || value === undefined) return []
  return String(value)
    .split(/,(?![^(]*\))/)
    .map((s) => s.replace(/\s*\([^)]*\)\s*$/, '').trim())
    .filter((s) => s !== '')
}

/** The parsed abilities carry `{score, modifier, raw}`; the schema wants a number. */
function abilitiesFrom(scores) {
  const out = {}
  for (const [k, v] of Object.entries(scores ?? {})) {
    out[k] = v !== null && typeof v === 'object' ? v.score : num(v)
  }
  return out
}

/** `"1d6 (remaining: 1)"` -> `{ die: "d6", remaining: 1 }`. */
function parseHitDice(value) {
  if (value === null || value === undefined) return { die: null, remaining: null }
  const s = String(value)
  const dieMatch = s.match(/(\d*d\d+)/i)
  const remainMatch = s.match(/remaining:\s*(\d+)/i)
  return {
    die: dieMatch !== null ? dieMatch[1] : null,
    remaining: remainMatch !== null ? parseInt(remainMatch[1], 10) : null,
  }
}

/**
 * The data rows of the first table in a section body.
 *
 * Distinguishing a data row from the `|---|---|` separator needs care, and a
 * naive `^[\s|:\-]+$` test is wrong: the saving-throw row `| -1 | +2 | +2 |`
 * consists only of dashes, plus signs, spaces and pipes, so it matches as a
 * separator and all six saves parse as null. A separator is identified by
 * having no alphanumeric content in any cell, which is the property that
 * actually distinguishes it.
 *
 * @param body - the section text.
 * @returns trimmed cell arrays, separator and header rows excluded.
 */
function dataRows(body) {
  const out = []
  let sawHeader = false
  for (const line of String(body ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) { if (out.length > 0) break; continue }
    const cells = trimmed.split('|').map((c) => c.trim()).filter((c) => c !== '')
    if (cells.length === 0) continue
    // A separator row has no cell containing a letter or digit.
    if (cells.every((c) => !/[A-Za-z0-9\u4e00-\u9fff]/.test(c))) continue
    if (!sawHeader) { sawHeader = true; continue }   // the header row
    out.push(cells)
  }
  return out
}

/** Find a section body by heading prefix. */
function sectionBody(sections, prefix) {
  const p = prefix.toLowerCase()
  const found = sections.find((s) => s.heading !== null && s.heading.toLowerCase().startsWith(p))
  return found !== undefined ? found.body : null
}

/** The `**Player:** X  **Campaign:** Y  **Last Updated:** Z` metadata line. */
/**
 * Identity fields.
 *
 * Alignment is character content and comes from the Identity section.
 * `player` / `campaign` / `updated` describe the file and live in the
 * frontmatter, which is passed in already parsed. The legacy inline
 * `**Player:** ... **Campaign:** ...` line is still read as a fallback so an
 * older sheet's values are not lost on first migration.
 */
function parseIdentitySection(sections, frontmatter = {}) {
  const meta = sections.map((s) => s.body).join('\n')
  return {
    player: frontmatter.player ?? grabFirst(meta, /\*\*Player:\*\*\s*([^*\n]*?)(?=\s*\*\*|$)/m),
    campaign: frontmatter.campaign ?? grabFirst(meta, /\*\*Campaign:\*\*\s*([^*\n]*?)(?=\s*\*\*|$)/m),
    updated: frontmatter.updated ?? grabFirst(meta, /\*\*Last Updated:\*\*\s*([^*\n]+)/m),
    alignment: grabFirst(meta, /\*\*Alignment:\*\*\s*([^|\n*]+)/m) || null,
  }
}

const ABILITY_KEYS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']

/**
 * The `| STR | DEX | ... |` saving-throw row.
 *
 * Reads via `dataRows`, which excludes the separator by content rather than by
 * character class — `| -1 | +2 |` is made only of dashes, pluses and pipes and
 * would otherwise be mistaken for the separator, yielding six nulls.
 */
function parseSavingThrows(sections) {
  const rows = dataRows(sectionBody(sections, 'saving throws'))
  if (rows.length === 0) return {}
  const out = {}
  for (let i = 0; i < ABILITY_KEYS.length && i < rows[0].length; i += 1) {
    // A proficiency marker rides along in the cell (`+5*`). `num` would turn
    // that into NaN -> null, silently losing the modifier of every proficient
    // save — which is exactly the two most-used saves on a wizard.
    out[ABILITY_KEYS[i]] = num(rows[0][i].replace(/\*/g, ''))
  }
  return out
}

/**
 * Which saves are proficient.
 *
 * The template marks proficiency with a trailing `*` in the cell (`+5*`) and
 * explains it in a footnote. Only the cell marker is read: the footnote is
 * prose and its wording is not a contract.
 */
function parseProficientSaves(sections) {
  const rows = dataRows(sectionBody(sections, 'saving throws'))
  if (rows.length === 0) return []
  const out = []
  for (let i = 0; i < ABILITY_KEYS.length && i < rows[0].length; i += 1) {
    if (rows[0][i].includes('*')) out.push(ABILITY_KEYS[i])
  }
  return out
}

/**
 * Equipment as `bucket -> { name: qty }`.
 *
 * Buckets map to the template's prose groups: `**Weapons:**`, `**Armour:**`,
 * `**Adventuring Gear:**`. Items are `- Name` bullets; a trailing `(N)` or
 * `x N` supplies a quantity, otherwise 1.
 *
 * Two details that look trivial and are not:
 *
 *   Bullets are `-`, never `*`. A `*`-prefixed line here is a bold label such
 *   as `**Currency:** 8 gp 0 sp 0 cp`, which belongs to the currency field. A
 *   looser `startsWith('*')` test turns that label into an inventory item
 *   called "*Currency:** 8 gp 0 sp 0 cp" — observed on the real sheet.
 *
 *   `- *(none)*` is an empty bucket, not an item named "(none)".
 */
function parseEquipment(sections) {
  const body = sectionBody(sections, 'equipment')
  const out = { weapons: {}, armour: {}, gear: {} }
  if (body === null) return out

  const BUCKETS = [
    [/^\*\*Weapons:?\*\*/i, 'weapons'],
    [/^\*\*Armou?r:?\*\*/i, 'armour'],
    [/^\*\*Adventuring Gear:?\*\*/i, 'gear'],
  ]
  let bucket = null
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    const header = BUCKETS.find(([re]) => re.test(trimmed))
    if (header !== undefined) { bucket = header[1]; continue }
    if (bucket === null) continue
    // Only `-` bullets are items; `**Label:**` lines are other fields.
    if (!trimmed.startsWith('-')) continue

    let item = trimmed.replace(/^-\s*/, '').trim()
    item = item.replace(/^\*\((.*)\)\*$/, '$1').trim()      // `*(none)*` -> `none`
    if (item === '' || /^\(?none\)?$/i.test(item) || /^\(.*\)$/.test(item)) continue
    const qtyMatch = item.match(/^(.*?)\s*(?:[x×]\s*(\d+)|\((\d+)\s*[a-z]*\))$/i)
    if (qtyMatch !== null) {
      item = qtyMatch[1].trim()
      out[bucket][item] = parseInt(qtyMatch[2] ?? qtyMatch[3], 10)
    } else {
      out[bucket][item] = 1
    }
  }
  return out
}

/**
 * `"8 gp 0 sp 0 cp"` -> `800` (a copper total).
 *
 * Money is stored as one integer, so this delegates to the single parser in
 * state-rules rather than re-implementing it — two parsers would drift, and
 * the whole point of the integer is that there is nothing to drift.
 */
function parseCurrency(value) {
  if (value === null || value === undefined) return 0
  return parseCoins(value)
}

/**
 * Render the generated summary block from a state object.
 *
 * This is what the DM reads at a glance. It is derived, never authoritative —
 * the writer replaces the whole block on every save, so hand-edits inside it
 * are lost by design and the marker says so.
 *
 * @param state - a normalized state object.
 * @returns the block as text, markers included.
 */
export function renderSummaryBlock(state) {
  const s = normalizeState(state)
  const ab = (k) => {
    const score = s.abilities[k]
    if (score === null || score === undefined) return `${k} —`
    const mod = Math.floor((score - 10) / 2)
    return `${k} ${score} (${mod >= 0 ? '+' : ''}${mod})`
  }
  const hp = s.combat.hp.current !== null ? `${s.combat.hp.current}/${s.combat.hp.max}` : '—'
  const ac = s.combat.ac !== null
    ? `${s.combat.ac}${s.combat.mageArmorAc !== null ? ` (Mage Armor ${s.combat.mageArmorAc})` : ''}`
    : '—'
  const slots = Object.keys(s.spellSlots).length > 0
    ? Object.entries(s.spellSlots)
      .map(([lvl, v]) => `${lvl}环 ${(v.total ?? 0) - (v.used ?? 0)}/${v.total ?? 0}`)
      .join(' · ')
    : '—'

  const lines = [
    SUMMARY_OPEN,
    `> 本块由 dsh-dnd 生成；改数值请编辑 \`${s.name ?? 'character'}.state.json\`，本块会被覆盖。`,
    '>',
    `> HP ${hp} · AC ${ac} · Init ${s.combat.initiative ?? '—'} · Speed ${s.combat.speed ?? '—'}`,
    `> ${['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'].map(ab).join(' · ')}`,
    `> 法术位 ${slots}${s.spellcasting.saveDC !== null ? ` · 法术DC ${s.spellcasting.saveDC}` : ''}${s.spellcasting.attackBonus !== null ? ` · 法术攻击 ${s.spellcasting.attackBonus >= 0 ? '+' : ''}${s.spellcasting.attackBonus}` : ''}`,
    `> 💰 ${formatCurrency(s.currency)}`,
    SUMMARY_CLOSE,
  ]
  return lines.join('\n')
}

/**
 * Reassemble a character file from frontmatter, narrative, and a summary.
 *
 * The narrative is inserted **verbatim** — no re-indentation, no whitespace
 * normalization, no line-ending conversion. It is prose a human maintains
 * across sessions, and a writer that reformats it has corrupted it.
 *
 * @param narrative - narrative section text, byte-exact from splitSheet.
 * @param state - the state to summarize.
 * @param options - `{ title, metadata, now }`. `metadata` may be a plain
 *   object or the result of `buildMetadata`; when omitted the existing
 *   metadata cannot be known here, so the caller should pass it through.
 * @returns the new file contents.
 */
export function composeSheet(narrative, state, options = {}) {
  // Backwards-compatible call shape: composeSheet(narrative, state, '# Name').
  const opts = typeof options === 'string' ? { title: options } : options
  const heading = opts.title ?? `# ${normalizeState(state).name ?? 'Unnamed'}`
  const summary = renderSummaryBlock(state)
  const rest = String(narrative ?? '').replace(/^\s*\n/, '')
  const body = `${heading}\n${summary}\n\n${rest}${rest.endsWith('\n') ? '' : '\n'}`
  const front = opts.metadata !== undefined && opts.metadata !== null
    ? renderFrontmatter(opts.metadata, METADATA_ORDER)
    : ''
  return front + body
}
