/**
 * tools/levelup.mjs — dnd_level_up, the advancement step the DM rules on.
 *
 * dnd_xp_add deliberately does not level a character: advancement changes
 * HP, slots and proficiencies, which is a rules decision. This tool makes
 * that decision CHEAP without making it silent — one call lays out exactly
 * what level N+1 means for this sheet (HP, proficiency bonus, spell slots,
 * new features), and only `confirm: true` writes any of it.
 *
 * ## What the tool decides vs what it reports
 *
 * The class table decides the arithmetic: hit die, proficiency bonus, slot
 * progression, the features the level grants — all from the ruleset dataset
 * the campaign declares, never recalled from memory. What the table CANNOT
 * decide is the player's part: an ASI (levels 4/8/12/16/19) and spell
 * preparation are reported as open choices, and the tool touches neither.
 * XP gating follows dnd_xp_add's message: below the threshold the apply is
 * refused, and only `force: true` — an explicit DM ruling — advances anyway.
 *
 * ## Why the class row is fetched before the lock
 *
 * The mutation must be synchronous (track.mjs's read-modify-write), but the
 * class table lives behind an async dataset read. The row is therefore
 * fetched from a pre-lock read of the sheet, and the mutation re-checks that
 * the class and level it planned from are still the ones on disk — a sheet
 * that changed underneath is refused rather than advanced with a stale plan.
 */

import { activeCampaignDir, readCampaignRuleset, DATA_ROOT, readTextOrUndefined, parseJsonLoose } from './shared.mjs'
import { locateAndApply } from './track.mjs'
import { readCharacter, listCharacters } from './state-io.mjs'
import { sessionOf, writePolicyFor } from './session-scope.mjs'
import { abilityMod } from './rest-rules.mjs'

export const name = 'dnd-levelup'

/** XP required to REACH each level (standard advancement, both rulesets). */
const LEVEL_XP = {
  2: 300, 3: 900, 4: 2700, 5: 6500, 6: 14000, 7: 23000, 8: 34000, 9: 48000,
  10: 64000, 11: 85000, 12: 100000, 13: 120000, 14: 140000, 15: 165000,
  16: 195000, 17: 225000, 18: 265000, 19: 305000, 20: 355000,
}

/** The classic Ability Score Improvement levels — reported, never applied. */
const ASI_LEVELS = [4, 8, 12, 16, 19]

/**
 * Load one class's table row for a level, out of the ruleset dataset.
 * @returns `{ row, hitDie, className }`, or `{ error }` when the class,
 *   dataset or level row is unusable.
 */
export async function classRowFor(fs, ruleset, className, level) {
  if (className === null || className === undefined || String(className).trim() === '') {
    return { error: 'the sheet has no class (identity.class); which class table would the level follow?' }
  }
  try {
    const file = ruleset === '2024' ? 'srd-2024.json' : 'srd-2014.json'
    const text = await readTextOrUndefined(fs, `${DATA_ROOT}/${file}`)
    if (text === undefined) return { error: `the ${ruleset} dataset is missing from this install` }
    const data = parseJsonLoose(text)
    const wanted = String(className).trim().toLowerCase()
    const row = (data?.classes ?? []).find((c) => String(c?.name ?? '').toLowerCase() === wanted)
    if (row === undefined) return { error: `"${className}" is not in the ${ruleset} dataset` }
    const levelRow = (row.table ?? []).find((r) => r.level === level)
    if (levelRow === undefined) return { error: `the ${row.name} table has no level ${level} row` }
    return { row: levelRow, hitDie: typeof row.hitDie === 'string' ? row.hitDie : 'd8', className: row.name }
  } catch (error) {
    return { error: `the ${ruleset} dataset could not be read: ${error.message}` }
  }
}

/**
 * Plan one level-up. Pure: state in, plan out, no writes.
 * @param state - the normalized state.
 * @param nextLevel - the level being gained.
 * @param row - the class table row for `nextLevel`.
 * @param hitDie - e.g. "d10".
 * @param hpGainMode - "avg" (deterministic, the default) or "roll" via rollDie.
 * @param rollDie - `(sides) => 1..sides`, only read for "roll".
 */
export function planLevelUp(state, nextLevel, row, hitDie, hpGainMode = 'avg', rollDie = null) {
  const die = parseInt(String(hitDie).replace(/^d/i, ''), 10)
  const conMod = abilityMod(state.abilities?.CON)
  let hpGain
  if (hpGainMode === 'roll' && typeof rollDie === 'function' && Number.isInteger(die)) {
    hpGain = rollDie(die) + conMod
  } else {
    hpGain = (Number.isInteger(die) ? Math.floor(die / 2) + 1 : 4) + conMod
  }
  // A negative CON can drag the gain to zero or below; the rules floor a
  // level's HP gain at 1.
  hpGain = Math.max(1, hpGain)

  const profAfter = numFromBonus(row.profBonus)

  // The new slot totals apply in full; what was already EXPENDED carries
  // over, clamped to the new total — a free reset would erase the cost of
  // spells cast that morning.
  const slots = {}
  for (const [lvl, total] of Object.entries(row.spellSlots ?? {})) {
    const used = state.spellSlots?.[lvl]?.used ?? 0
    slots[lvl] = { total: Number(total), used: Math.min(used, Number(total)) }
  }

  const notes = []
  const features = row.features ?? []
  const featureList = Array.isArray(features)
    ? features
    : String(features).split(',').map((s) => s.trim()).filter((s) => s !== '' && s !== '-')
  if (featureList.length > 0) notes.push(`新特性（${nextLevel} 级）：${featureList.join('、')}`)
  if (ASI_LEVELS.includes(nextLevel)) {
    notes.push(`${nextLevel} 级有属性值提升（+2 或 2×+1）——由玩家决定，本工具不代改 abilities`)
  }
  if (Object.keys(row.spellSlots ?? {}).length > 0) {
    notes.push('已准备/已知法术是否增加由玩家选择；本工具只更新法术位总量')
  }

  return { hpGain, profBefore: 2 + Math.floor((nextLevel - 2) / 4), profAfter, slots, notes, die, conMod }
}

function numFromBonus(value) {
  const n = parseInt(String(value ?? '').replace('+', ''), 10)
  return Number.isFinite(n) ? n : 2
}

/**
 * Build this module's tools.
 * @param ctx - host context.
 * @returns an array of tool definitions.
 */
export function buildTools(ctx) {
  const getFs = () => ctx.get('fs')
  const renderText = (_args, value) => [{ type: 'text', text: String(value) }]
  const rollDie = (sides) => Math.floor(Math.random() * sides) + 1

  const levelUp = {
    name: 'dnd_level_up',
    description: 'Plan a character\'s next level and, with confirm:true, apply it. '
      + 'The plan reads the class table from the campaign\'s ruleset dataset: HP gain (average, or roll with hpGainMode "roll"), proficiency bonus, full spell-slot totals (expended counts carry over), and the level\'s features. '
      + 'Ability score improvements and spell preparation are reported as the player\'s choices, never applied. '
      + 'Applying requires the XP to have reached the threshold, or force:true as an explicit DM ruling. Pass key to make a retry safe.',
    parameters: {
      type: 'object',
      properties: {
        character: { type: 'string', description: 'Character name or stem. Omit when the campaign has exactly one.' },
        confirm: { type: 'boolean', description: 'false (default): show the plan and write nothing. true: apply it.' },
        hpGainMode: { type: 'string', description: '"avg" (default, deterministic) or "roll" — the hit die rolled with the tool\'s own dice.', enum: ['avg', 'roll'] },
        force: { type: 'boolean', description: 'Advance even when XP has not reached the threshold. A DM ruling; the report says so.' },
        key: { type: 'string', description: 'Idempotency key for the applied level-up. A retry with the same key changes nothing.' },
      },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'
      const confirm = args.confirm === true

      const campaign = await activeCampaignDir(fs, sessionOf(ctx, exec))
      if (campaign === undefined) return 'No active campaign. Load one with /dm:dnd load <campaign> first.'
      const ruleset = await readCampaignRuleset(fs, campaign.dir)
      const dir = `${campaign.dir}/characters`

      // Resolve the character ONCE outside the lock, purely to fetch the
      // class row the plan needs (read-only). The lock re-locates and the
      // mutation verifies the class/level still match before applying.
      const listed = await listCharacters(fs, dir)
      if (listed.length === 0) return `No characters in campaign ${campaign.campaign}.`
      let name = null
      if (args.character !== undefined && String(args.character).trim() !== '') {
        const wanted = String(args.character).toLowerCase().trim()
        const match = listed.find((c) => c.name.toLowerCase() === wanted)
          ?? listed.find((c) => c.name.toLowerCase().includes(wanted))
        if (match === undefined) {
          return `Character "${args.character}" not found in ${campaign.campaign}. Available: ${listed.map((c) => c.name).join(', ')}`
        }
        name = match.name
      } else if (listed.length === 1) {
        name = listed[0].name
      } else {
        return `Which character? ${campaign.campaign} has ${listed.length}: ${listed.map((c) => c.name).join(', ')}`
      }

      const preview = await readCharacter(fs, dir, name)
      if (preview.state === null) {
        return `Could not read state for "${name}": ${preview.warnings.join('; ')}`
      }
      const currentLevel = preview.state.identity?.level
      if (!Number.isInteger(currentLevel) || currentLevel < 1) {
        return 'dnd_level_up: the sheet has no usable identity.level to advance from. Nothing was written.'
      }
      if (currentLevel >= 20) {
        return 'dnd_level_up: the character is already level 20; the standard tables end there. Nothing was written.'
      }
      const nextLevel = currentLevel + 1
      const sheet = await classRowFor(fs, ruleset, preview.state.identity?.class, nextLevel)
      if (sheet.error !== undefined) {
        return `dnd_level_up: ${sheet.error}. Nothing was written.`
      }

      // ── plan-only mode ──────────────────────────────────────────────────
      // The write path has no "report without writing" mode, by design: a
      // mutate that declines must refuse. So planning reads the sheet and
      // returns; ONLY confirm reaches locateAndApply.
      if (!confirm) {
        const plan = planLevelUp(preview.state, nextLevel, sheet.row, sheet.hitDie, args.hpGainMode, rollDie)
        const maxBefore = preview.state.combat?.hp?.max
        const xp = preview.state.identity?.xp
        const xpNext = preview.state.identity?.xpNext ?? LEVEL_XP[nextLevel]
        const lines = [
          `升级计划：${preview.state.name ?? name} ${currentLevel} -> ${nextLevel} 级（${sheet.className}，ruleset ${ruleset}）——未写入`,
          `  HP 上限 +${plan.hpGain}（1${plan.die}${plan.conMod >= 0 ? '+' : ''}${plan.conMod}）${maxBefore != null ? `：${maxBefore} -> ${maxBefore + plan.hpGain}` : '（表无上限，应用时同加当前 HP）'}`,
          `  熟练加成：+${plan.profBefore} -> +${plan.profAfter}`,
        ]
        for (const [lvl, s] of Object.entries(plan.slots)) {
          lines.push(`  ${lvl} 环法术位总量 -> ${s.total}${s.used > 0 ? `（已耗 ${s.used} 保留）` : ''}`)
        }
        for (const note of plan.notes) lines.push('  ' + note)
        if (xp != null && xpNext != null && xp < xpNext) {
          lines.push(`  XP 不足：${xp} / ${xpNext}——应用时会被拒绝，除非 force:true`)
        }
        lines.push('  confirm:true 应用本计划。')
        return lines.join('\n')
      }

      const captured = []
      const outcome = await locateAndApply(fs, name, (located, state) => {
        // The plan was built from a pre-lock read. If the sheet's class or
        // level moved since, the plan is stale — refuse rather than advance
        // on numbers nobody saw.
        if (state.identity?.class !== preview.state.identity.class
          || state.identity?.level !== currentLevel) {
          return { refuse: 'dnd_level_up: the sheet changed while the plan was being built; call again. Nothing was written.' }
        }
        const xp = typeof state.identity?.xp === 'number' ? state.identity.xp : null
        const xpNext = typeof state.identity?.xpNext === 'number' ? state.identity.xpNext : LEVEL_XP[nextLevel]
        if (confirm && xp !== null && xpNext !== null && xp < xpNext && args.force !== true) {
          return { refuse: `REFUSED: ${located.name} has ${xp} XP; level ${nextLevel} needs ${xpNext}. `
            + 'Advance XP with dnd_xp_add, or pass force:true to rule otherwise. Nothing was written.' }
        }

        const plan = planLevelUp(state, nextLevel, sheet.row, sheet.hitDie, args.hpGainMode, rollDie)
        const hp = state.combat?.hp ?? {}
        const maxBefore = typeof hp.max === 'number' ? hp.max : null

        state.identity = { ...state.identity, level: nextLevel, xpNext: nextLevel >= 20 ? null : LEVEL_XP[nextLevel + 1] ?? null }
        state.combat = {
          ...state.combat,
          hitDice: { ...state.combat?.hitDice, remaining: (state.combat?.hitDice?.remaining ?? 0) + 1 },
          hp: maxBefore === null ? hp : { ...hp, max: maxBefore + plan.hpGain, current: (hp.current ?? 0) + plan.hpGain },
        }
        if (Object.keys(plan.slots).length > 0) state.spellSlots = plan.slots

        captured.push(`${located.name} 升到 ${nextLevel} 级（${sheet.className}，ruleset ${ruleset}）`)
        captured.push(`HP 上限 +${plan.hpGain}（1${plan.die}${plan.conMod >= 0 ? '+' : ''}${plan.conMod}）：${maxBefore === null ? '无上限，未改' : `${maxBefore} -> ${maxBefore + plan.hpGain}`}，当前 HP 同加`)
        captured.push(`熟练加成：+${plan.profBefore} -> +${plan.profAfter}`)
        for (const [lvl, s] of Object.entries(plan.slots)) {
          captured.push(`${lvl} 环法术位总量：${s.total}${s.used > 0 ? `（已耗 ${s.used} 保留）` : ''}`)
        }
        captured.push(...plan.notes)
        if (args.force === true && xp !== null && xpNext !== null && xp < xpNext) {
          captured.push(`FORCE：XP ${xp} 未达 ${xpNext}，按 DM 裁定提前升级`)
        }
        return undefined
      }, {
        key: args.key,
        sandboxPolicy: writePolicyFor(ctx, exec),
        session: sessionOf(ctx, exec),
        describe: () => captured.join('\n'),
      })

      if (outcome.error !== undefined) return outcome.error
      return outcome.result.text
    },
  }

  return [levelUp]
}
