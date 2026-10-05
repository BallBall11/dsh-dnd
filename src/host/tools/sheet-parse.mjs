/**
 * tools/sheet-parse.mjs — character sheet markdown parser.
 *
 * The v0.1.0 parser had a data-loss bug worth calling out, because it is the
 * reason this file was rewritten rather than ported:
 *
 *     const slotsM = text.match(/\|\s*([0-9]+)st\s*\|\s*(\d+)\s*\|\s*(\d+)/)
 *
 * That matches the FIRST spell-slot row only. A wizard with 1st/2nd/3rd level
 * slots parsed as a character with 1st level slots — the higher circles were
 * silently dropped, and the panel showed a wrong sheet with no warning. A
 * wrong number is worse than a missing one here: the DM reads it at the table.
 *
 * The parser now:
 *   - collects 1st/2nd/3rd/4th/... rows into a level-keyed map
 *   - reports what it could NOT recognise in `warnings[]` instead of returning
 *     null silently, so the caller (and the panel) can surface it
 *   - carries a `version` so a future format change is detectable
 *
 * It stays deliberately tolerant: character sheets are hand-edited markdown,
 * so a missing section is normal and must not be an error.
 */

import { grab, grabInt, splitSections } from './shared.mjs'

/** Bumped when the parsed shape changes in a way callers must notice. */
export const PARSE_VERSION = 2

const ABILITIES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']

/** Ordinal suffix for a spell level, e.g. 1 -> "1st", 3 -> "3rd". */
function ordinal(level) {
  const n = Number(level)
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

/** Split a markdown table row into trimmed, non-empty cells. */
function cells(row) {
  return row.split('|').map((c) => c.trim()).filter((c) => c !== '')
}

/** True for a `|---|---|` separator row. */
function isSeparator(cells_) {
  return cells_.join('|').replace(/[:\-|]/g, '').trim() === ''
}

/**
 * Collect the data rows of the first table whose header matches `headerRe`.
 * @param text - the section text.
 * @param headerRe - regex applied to each line to find the header.
 * @param minCells - rows with fewer cells are skipped (separators, blanks).
 */
function tableRows(text, headerRe, minCells) {
  const lines = String(text).split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!headerRe.test(lines[i])) continue
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!lines[j].trim().startsWith('|')) break
      const row = cells(lines[j])
      if (row.length < minCells || isSeparator(row)) continue
      out.push(row)
    }
    break
  }
  return out
}

/**
 * Parse the `| STR | DEX | ... |` ability table.
 *
 * Cells come in two shapes in real sheets: a bare score (`16`) and a score with
 * its modifier (`17 (+3)`). The raw cell is preserved as `raw` because that is
 * what a sheet round-trip needs, but `score` is the number callers actually
 * compute with — leaving "17 (+3)" as the only value forced every consumer to
 * re-parse it.
 *
 * @returns `{ STR: { score, modifier, raw }, ... }`.
 */
function parseAbilities(text) {
  const rows = tableRows(text, /STR.*DEX.*CON.*INT.*WIS.*CHA/i, 6)
  if (rows.length === 0) return {}
  const out = {}
  for (let i = 0; i < ABILITIES.length; i += 1) {
    const raw = rows[0][i]
    const scoreMatch = String(raw).match(/-?\d+/)
    const modMatch = String(raw).match(/\(([+-]?\d+)\)/)
    out[ABILITIES[i]] = {
      score: scoreMatch !== null ? parseInt(scoreMatch[0], 10) : null,
      modifier: modMatch !== null ? parseInt(modMatch[1], 10) : null,
      raw,
    }
  }
  return out
}

/** Parse the Skills table into rows of `{ name, ability, bonus, proficient }`. */
function parseSkills(sectionText) {
  const out = []
  for (const row of tableRows(sectionText, /^##\s*\/?Skills/i, 4)) {
    if (/^Skill$/i.test(row[0])) continue
    out.push({
      name: row[0],
      ability: row[1],
      bonus: row[2],
      proficient: row[3].includes('✓'),
    })
  }
  return out
}

/**
 * Parse EVERY spell-slot row, not just the first.
 *
 * Accepts three shapes seen in real sheets:
 *   | Slot  | Total | Used |     (the skill's template)
 *   | Level | Total | Used |     (morgansfort/alice.md)
 *   1st: 2/1, 2nd: 3/2             (compact prose)
 *
 * The header matters: an earlier version keyed only on `Slot`, so Alice's
 * sheet — which says `Level` — parsed to zero slots while a hand-written test
 * fixture using `Slot` passed. The fixture matched the code instead of the
 * data. Both headers are now accepted, and the test uses the real sheet's
 * wording.
 *
 * @param text - the whole sheet.
 * @returns `{ byLevel: { 1: {total,used}, ... }, first: {...} | null }`.
 */
function parseSpellSlots(text) {
  const byLevel = {}

  // Table form: one row per level. This is the fix — the old regex took the
  // first match and stopped.
  for (const row of tableRows(text, /^\|\s*(?:Slot|Level|Spell Level)\s*\|/i, 3)) {
    const levelMatch = String(row[0]).match(/(\d+)/)
    if (levelMatch === null) continue
    const level = parseInt(levelMatch[1], 10)
    const total = parseInt(row[1], 10)
    const used = parseInt(row[2], 10)
    if (!Number.isFinite(level) || !Number.isFinite(total)) continue
    byLevel[level] = { total, used: Number.isFinite(used) ? used : 0 }
  }
  if (Object.keys(byLevel).length > 0) {
    const lowest = Math.min(...Object.keys(byLevel).map(Number))
    return { byLevel, first: { level: lowest, ...byLevel[lowest] } }
  }

  // Prose form: "1st: 4/1, 2nd: 3/1" (totals first, used second).
  const prose = grab(text, /\*\*(?:Spell )?Slots?(?:\s*\([^)]*\))?:\*\*\s*([^\n]+)/i)
  if (prose !== '') {
    const re = /(\d+)(?:st|nd|rd|th)?\s*[:：]\s*(\d+)\s*\/\s*(\d+)/gi
    let match
    while ((match = re.exec(prose)) !== null) {
      byLevel[parseInt(match[1], 10)] = {
        total: parseInt(match[2], 10),
        used: parseInt(match[3], 10),
      }
    }
  }
  const levels = Object.keys(byLevel).map(Number)
  return {
    byLevel,
    first: levels.length > 0
      ? { level: Math.min(...levels), ...byLevel[Math.min(...levels)] }
      : null,
  }
}

/**
 * Parse one character sheet's markdown into a compact plain-JSON object.
 *
 * @param text - the sheet's markdown.
 * @returns the parsed character, with a `warnings` array naming anything that
 *   looked present but could not be understood.
 */
export function parseCharacterSheet(text) {
  const source = String(text ?? '')
  const warnings = []

  const sections = splitSections(source)
  const sectionBody = (needle) => {
    const key = String(needle).toLowerCase()
    for (const [heading, body] of sections) {
      if (heading.toLowerCase().includes(key)) return body
    }
    return ''
  }

  const combat = sectionBody('combat stats')
  const spells = sectionBody('known spells')

  // Identity is a single line: `**Race:** X | **Class:** Y | **Level:** N`.
  const identityLine = source
    .split(/\r?\n/)
    .find((line) => line.includes('**Class:**') && line.includes('**Race:**')) ?? ''
  const identity = (key) => {
    const match = identityLine.match(new RegExp(`\\*\\*${key}:\\*\\*\\s*([^|\\n]+)`))
    return match !== null ? match[1].trim() : undefined
  }

  const hpMatch = combat.match(/\*\*HP:\*\*\s*(\d+)\s*\/\s*(\d+)/)
  const levelValue = identity('Level')
  const slots = parseSpellSlots(source)
  const abilities = parseAbilities(source)

  if (combat === '') warnings.push('No "## Combat Stats" section: HP/AC/initiative are unavailable.')
  else if (hpMatch === null) warnings.push('Combat Stats has no parseable "**HP:** current / max" line.')
  if (Object.keys(abilities).length === 0) warnings.push('No ability-score table found (expected a STR..CHA header row).')
  if (levelValue !== undefined && !Number.isFinite(parseInt(levelValue, 10))) {
    warnings.push(`Identity line has a non-numeric Level: "${levelValue}".`)
  }

  return {
    parseVersion: PARSE_VERSION,
    name: grab(source, /^#\s+(.+)$/m),
    race: identity('Race'),
    klass: identity('Class'),
    // parseInt('pending') is NaN, not null — normalize so callers can rely on
    // "absent" meaning exactly one thing.
    level: (() => {
      if (levelValue === undefined) return null
      const parsed = parseInt(levelValue, 10)
      return Number.isFinite(parsed) ? parsed : null
    })(),
    background: identity('Background'),
    alignment: identity('Alignment'),

    xp: (() => {
      const m = source.match(/\*\*XP:\*\*\s*([\d,]+)\s*\/\s*([\d,]+)/)
      return m !== null ? m[1].replace(/,/g, '') : null
    })(),
    xpNext: (() => {
      const m = source.match(/\*\*XP:\*\*\s*([\d,]+)\s*\/\s*([\d,]+)/)
      return m !== null ? m[2].replace(/,/g, '') : null
    })(),

    hitPoints: hpMatch !== null
      ? { current: parseInt(hpMatch[1], 10), max: parseInt(hpMatch[2], 10) }
      : null,
    tempHp: grabInt(combat, /\*\*Temp HP:\*\*\s*(\d+)/),
    ac: grabInt(combat, /\*\*AC:\*\*\s*(\d+)/),
    mageArmorAc: grabInt(combat, /\(Mage Armor:\s*(\d+)\)/),
    initiative: grab(combat, /\*\*Initiative:\*\*\s*([+-]?\d+)/) || null,
    speed: grabInt(combat, /\*\*Speed:\*\*\s*(\d+)/),
    hitDice: grab(combat, /\*\*Hit Dice:\*\*\s*([^\n|]+)/) || null,
    inspiration: /^\s*-\s*\*\*Inspiration:\*\*\s*Yes/m.test(source),
    deathSaves: (() => {
      const m = combat.match(/Successes:\s*(\d+)\s*\|\s*Failures:\s*(\d+)/)
      return m !== null
        ? { success: parseInt(m[1], 10), fail: parseInt(m[2], 10) }
        : { success: null, fail: null }
    })(),

    abilityScores: abilities,
    skills: parseSkills(source),

    // Spellcasting. `spellSlots` stays as the FIRST (lowest) level for
    // backwards compatibility with the v0.1.0 consumers; `spellSlotsByLevel`
    // is the complete picture and is what the panel should render.
    spellSaveDC: grabInt(spells, /\*\*Spell save DC:\*\*\s*(\d+)/),
    spellAttack: grab(spells, /\*\*Spell attack:\*\*\s*([+-]?\d+)/) || null,
    spellSlots: slots.first,
    spellSlotsByLevel: slots.byLevel,
    cantrips: grab(source, /\*\*Cantrips[^:]*:\*\*\s*(.+)$/m) || null,
    prepared: grab(source, /\*\*Prepared[^:]*:\*\*\s*(.+)$/m) || null,
    currency: grab(source, /\*\*Currency:\*\*\s*([^\n]+)/) || null,

    warnings,
  }
}

/**
 * Render a parsed character as a compact readable card.
 * @param c - a parseCharacterSheet result.
 */
export function formatCharacter(c) {
  const hp = c.hitPoints !== null ? `${c.hitPoints.current}/${c.hitPoints.max}` : '—'
  const abilityLine = ABILITIES
    .map((k) => {
      const a = c.abilityScores[k]
      if (a === undefined || a.score === null) return `${k} —`
      const mod = a.modifier !== null ? a.modifier : Math.floor((a.score - 10) / 2)
      return `${k} ${a.score} (${mod >= 0 ? '+' : ''}${mod})`
    })
    .join(' ')
  const lines = [
    `# ${c.name || '(unnamed)'}${c.klass !== undefined ? ` — ${c.race != null ? String(c.race).split(' (')[0] + ' ' : ''}${c.klass}` : ''}${c.level !== null ? ` Lv${c.level}` : ''}`,
    `HP ${hp}${c.tempHp ? ` (+${c.tempHp} temp)` : ''} · AC ${c.ac ?? '—'}${c.mageArmorAc ? ` (Mage Armor ${c.mageArmorAc})` : ''} · Init ${c.initiative ?? '—'} · Speed ${c.speed ?? '—'}`,
    `XP ${c.xp ?? '0'}/${c.xpNext ?? '?'}${c.spellSaveDC ? ` · DC ${c.spellSaveDC}` : ''}${c.spellAttack ? ` · Spell atk ${c.spellAttack}` : ''}`,
    abilityLine,
  ]
  if (c.skills.length > 0) {
    lines.push('Skills: ' + c.skills.map((s) => `${s.name} ${s.bonus}${s.proficient ? '✓' : ''}`).join(', '))
  }
  const levels = Object.keys(c.spellSlotsByLevel).map(Number).sort((a, b) => a - b)
  if (levels.length > 0) {
    lines.push('Spell slots: ' + levels
      .map((lv) => `${ordinal(lv)} ${c.spellSlotsByLevel[lv].total - c.spellSlotsByLevel[lv].used}/${c.spellSlotsByLevel[lv].total}`)
      .join(', '))
  }
  if (c.currency) lines.push(`💰 ${c.currency}`)
  if (c.warnings.length > 0) lines.push('⚠ ' + c.warnings.join(' '))
  return lines.join('\n')
}
