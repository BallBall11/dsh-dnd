/**
 * tools/encounter.mjs — the encounter arithmetic the DM should never do in
 * their head: difficulty budgeting, and the loot roll.
 *
 *   dnd_encounter_difficulty  party levels + enemy CRs -> the four-step
 *                             difficulty verdict (DMG method)
 *   dnd_loot                  a CR-banded coin roll, from data/tables.json
 *
 * Both are pure computation: no writes, no campaign reads beyond the party
 * levels the difficulty tool looks up from the character cards.
 *
 * ## Why the CR/XP ladder lives here and not in data/
 *
 * The thresholds ARE code-adjacent constants of one published method (DMG
 * "Creating Encounters"), fixed across editions this bundle serves — not
 * curated content that grows. The loot BANDS are a house compromise (four
 * bands instead of the DMG's nine individual-treasure rows), so those DO
 * live in data/tables.json with a _meta note, like every other shipped
 * dataset.
 */

import { activeCampaignDir, DATA_ROOT, readTextOrUndefined, parseJsonLoose } from './shared.mjs'
import { readAllCharacters } from './state-io.mjs'
import { sessionOf } from './session-scope.mjs'
import { formatCurrency } from './state-rules.mjs'

export const name = 'dnd-encounter'

/**
 * XP thresholds per character level: [easy, medium, hard, deadly].
 * DMG "Creating Encounters" (identical numbers in both rulesets' guidance).
 */
const XP_THRESHOLDS = {
  1: [25, 50, 75, 100], 2: [50, 100, 150, 200], 3: [75, 150, 225, 400],
  4: [125, 250, 375, 500], 5: [250, 500, 750, 1100], 6: [300, 600, 900, 1400],
  7: [350, 750, 1100, 1700], 8: [450, 900, 1400, 2100], 9: [550, 1100, 1600, 2400],
  10: [600, 1200, 1900, 2800], 11: [800, 1600, 2400, 3600], 12: [1000, 2000, 3000, 4500],
  13: [1100, 2200, 3300, 5100], 14: [1250, 2500, 3800, 5700], 15: [1400, 2800, 4300, 6400],
  16: [1600, 3200, 4800, 7200], 17: [2000, 3900, 5900, 8800], 18: [2100, 4200, 6300, 9500],
  19: [2400, 4900, 7300, 10900], 20: [2800, 5700, 8500, 12700],
}

/** XP awarded per monster, keyed by CR. CR 0 awards 10 (or 0 for trivial groups). */
const CR_XP = {
  '0': 10, '1/8': 25, '1/4': 50, '1/2': 100,
  '1': 200, '2': 450, '3': 700, '4': 1100, '5': 1800, '6': 2300, '7': 2900,
  '8': 3900, '9': 5000, '10': 5900, '11': 7200, '12': 8400, '13': 10000,
  '14': 11500, '15': 13000, '16': 15000, '17': 18000, '18': 20000, '19': 22000,
  '20': 25000, '21': 33000, '22': 41000, '23': 50000, '24': 62000, '25': 75000,
  '26': 90000, '27': 105000, '28': 120000, '29': 135000, '30': 155000,
}

/**
 * The encounter multiplier: more monsters fight smarter than their XP sum,
 * because they bring more actions. DMG table, keyed by monster count.
 */
function multiplier(monsterCount) {
  if (monsterCount <= 1) return 1
  if (monsterCount === 2) return 1.5
  if (monsterCount <= 6) return 2
  if (monsterCount <= 10) return 2.5
  if (monsterCount <= 14) return 3
  return 4
}

/**
 * The DMG difficulty verdict for a pool of characters vs a total of adjusted
 * XP. Returns the label and where the budget sits relative to the bands.
 */
export function difficultyFor(levels, enemies) {
  // Party thresholds SUM: the DMG bands are per character, added across the
  // group. A level missing from the table (or absent from the sheet) is
  // reported, not silently dropped — a dropped fighter is a TPK waiting.
  const thresholds = [0, 0, 0, 0]
  const unknownLevels = []
  for (const level of levels) {
    const row = XP_THRESHOLDS[level]
    if (row === undefined) { unknownLevels.push(level); continue }
    for (let i = 0; i < 4; i += 1) thresholds[i] += row[i]
  }

  let rawXP = 0
  const unknownCRs = []
  let monsterCount = 0
  for (const enemy of enemies) {
    const xp = CR_XP[String(enemy.cr)]
    if (xp === undefined) { unknownCRs.push(enemy.cr); continue }
    rawXP += xp * Math.max(1, Math.floor(enemy.count ?? 1))
    monsterCount += Math.max(1, Math.floor(enemy.count ?? 1))
  }
  const adjustedXP = Math.round(rawXP * multiplier(monsterCount))

  const bands = ['简单', '中等', '困难', '致命']
  // A budget at or above the deadly threshold is deadly; below each rung the
  // band falls one step. Below the easy rung it is trivial.
  let verdict = '低于「简单」——多半是一次无趣的遭遇'
  let bandIndex = -1
  for (let i = 3; i >= 0; i -= 1) {
    if (thresholds[i] > 0 && adjustedXP >= thresholds[i]) { bandIndex = i; break }
  }
  if (bandIndex >= 0) verdict = bands[bandIndex]

  return {
    verdict,
    bandIndex,
    rawXP,
    adjustedXP,
    multiplier: multiplier(monsterCount),
    monsterCount,
    thresholds,
    unknownLevels,
    unknownCRs,
  }
}

/**
 * CR text to a number. The fractional CRs are WRITTEN as fractions in the
 * SRD and in dnd_encounter_difficulty's own parameter docs, so dnd_loot
 * accepting only "0.25" made one concept two formats across sibling tools.
 * Bare numbers still pass through.
 * @returns the numeric CR, or null when unreadable.
 */
export function parseCr(cr) {
  const s = String(cr ?? '').trim()
  if (s === '') return null
  const fraction = { '1/8': 0.125, '1/6': 1 / 6, '1/4': 0.25, '1/3': 1 / 3, '1/2': 0.5 }[s.toLowerCase()]
  if (fraction !== undefined) return fraction
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * The loot band for a CR, from data/tables.json.
 * @returns `{ band }`, or `{ error }` when CR or file is unusable.
 */
async function lootBand(fs, cr) {
  const text = await readTextOrUndefined(fs, `${DATA_ROOT}/tables.json`)
  if (text === undefined) return { error: 'the loot table (data/tables.json) is missing from this install' }
  let bands
  try { bands = parseJsonLoose(text)?.loot?.bands } catch { bands = null }
  if (!Array.isArray(bands) || bands.length === 0) return { error: 'data/tables.json has no loot.bands' }
  const n = parseCr(cr)
  if (n === null) return { error: `CR "${cr}" is not a number >= 0 (fractions like "1/4" are accepted)` }
  const band = bands.find((b) => Array.isArray(b.cr) && n >= b.cr[0] && n <= b.cr[1])
  if (band === undefined) return { error: `CR ${n} falls outside every loot band (0-${bands[bands.length - 1].cr[1]})` }
  return { band }
}

/**
 * Build this module's tools.
 * @param ctx - host context; `fs` is optional (loot needs no campaign).
 * @returns an array of tool definitions.
 */
export function buildTools(ctx) {
  const renderText = (_args, value) => [{ type: 'text', text: String(value) }]

  const difficulty = {
    name: 'dnd_encounter_difficulty',
    description: 'Rate an encounter\'s difficulty before playing it: pass the enemy list by CR (name optional) and the party is read from the active campaign\'s PCs. '
      + 'Returns the DMG verdict — 简单/中等/困难/致命 (easy/medium/hard/deadly) — with the raw and action-adjusted XP and the party\'s thresholds. '
      + 'Read-only math; the DM decides what "deadly" means for THEIR table.',
    parameters: {
      type: 'object',
      properties: {
        enemies: {
          type: 'array',
          description: 'The opposing force, e.g. [{ "cr": "1/4", "name": "Goblin Warrior", "count": 4 }]. CR is required; count defaults to 1.',
          items: {
            type: 'object',
            properties: {
              cr: { type: 'string', description: 'Challenge Rating, e.g. "1/4", "2".' },
              name: { type: 'string', description: 'Monster name, for the report only.' },
              count: { type: 'integer', description: 'How many of this statblock (default 1).' },
            },
            required: ['cr'],
          },
        },
        partyLevels: { type: 'array', description: 'Explicit PC levels to rate instead of reading the campaign, e.g. [3, 3, 4]. Items are numbers.', items: { type: 'integer' } },
      },
      required: ['enemies'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      const enemies = Array.isArray(args.enemies) ? args.enemies : []
      if (enemies.length === 0) return 'dnd_encounter_difficulty needs `enemies`, e.g. [{ "cr": "1/4", "count": 4 }].'

      let levels = Array.isArray(args.partyLevels) ? args.partyLevels.map(Number) : null
      let partySource = 'explicit partyLevels argument'
      if (levels === null || levels.length === 0) {
        const fs = ctx.get('fs')
        if (fs === undefined) return 'fs service unavailable — pass `partyLevels` explicitly to rate without a campaign.'
        const campaign = await activeCampaignDir(fs, sessionOf(ctx, exec))
        if (campaign === undefined) return 'No active campaign. Pass `partyLevels` explicitly, or load a campaign.'
        const { characters } = await readAllCharacters(fs, `${campaign.dir}/characters`)
        const pcs = characters.filter((c) => (c.metadata?.tags ?? []).some((t) => String(t).toLowerCase() === 'pc'))
        levels = pcs.map((c) => c.state?.identity?.level).filter((l) => typeof l === 'number' && Number.isInteger(l) && l >= 1)
        partySource = `${campaign.campaign}'s ${pcs.length} PC sheet(s)`
      }

      const result = difficultyFor(levels, enemies)
      const lines = [`Encounter difficulty: **${result.verdict}**`,
        `  Party: ${levels.length} member(s), levels ${levels.join(', ') || '—'} (from ${partySource}).`,
        `  Monsters: ${result.monsterCount} — raw XP ${result.rawXP} x ${result.multiplier} (count multiplier) = adjusted ${result.adjustedXP}.`,
        `  Party thresholds (easy/medium/hard/deadly): ${result.thresholds.join(' / ')}.`]
      if (result.unknownLevels.length > 0) {
        lines.push(`  WARNING: unreadable levels ignored — ${result.unknownLevels.join(', ')}. Fix the sheet(s) or pass partyLevels.`)
      }
      if (result.unknownCRs.length > 0) {
        lines.push(`  WARNING: unknown CRs ignored — ${result.unknownCRs.join(', ')}. Use "0", "1/8", "1/4", "1/2" or "1"-"30".`)
      }
      if (result.monsterCount === 0) lines.push('  No monsters counted — nothing to rate.')
      return lines.join('\n')
    },
  }

  const loot = {
    name: 'dnd_loot',
    description: 'Roll coin for a defeated enemy or encounter, by CR band (data/tables.json). Returns the per-creature rolls and the copper total to hand out with dnd_track or dnd_spend. '
      + 'A DM who wants magic items or art objects invents them — this is the coin floor, not the treasure ceiling.',
    parameters: {
      type: 'object',
      properties: {
        cr: { type: 'string', description: 'The defeated monster\'s CR, e.g. "1" or "0.5". Required.' },
        count: { type: 'integer', description: 'How many creatures of that CR fell (default 1).' },
      },
      required: ['cr'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      const fs = ctx.get('fs')
      if (fs === undefined) return 'fs service unavailable'
      const count = args.count === undefined ? 1 : Number(args.count)
      if (!Number.isInteger(count) || count < 1 || count > 50) {
        return 'dnd_loot: `count` must be an integer 1-50.'
      }
      const band = await lootBand(fs, args.cr)
      if (band.error !== undefined) return `dnd_loot: ${band.error}. Nothing was rolled.`
      const [min, max] = band.band.gp
      const rolls = []
      let totalGp = 0
      for (let i = 0; i < count; i += 1) {
        const gp = min + Math.floor(Math.random() * (max - min + 1))
        rolls.push(gp)
        totalGp += gp
      }
      const copper = totalGp * 100
      return `Loot for ${count} x CR ${args.cr} (${band.band.label}): `        + `${count === 1 ? String(rolls[0]) : rolls.join(' + ')} gp = ${totalGp} gp total `
        + `(${formatCurrency(copper)}). `
        + 'Hand it out with dnd_track or dnd_spend.'
    },
  }

  return [difficulty, loot]
}
