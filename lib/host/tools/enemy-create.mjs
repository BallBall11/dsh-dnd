/**
 * tools/enemy-create.mjs — dnd_enemy_create, hostile cards straight from SRD.
 *
 * ## Why a separate tool from dnd_character_create
 *
 * Data model: SHARED. An enemy card IS a character card — same directory, same
 * state schema, same write path, `kind: 'enemy'` tag — so tracking, the panel,
 * a rest and an initiative all work on it with zero extra wiring. Tool
 * surface: SEPARATE, because the two cards are filled in from opposite
 * directions. A PC derives from a CLASS (hit die, saves, spell table); a
 * monster arrives as a STATBLOCK — AC, HP, six scores, CR, a wall of attack
 * prose — and none of the class machinery applies. One parameter schema trying
 * to serve both grows twenty mutually exclusive fields and a description no
 * model reads correctly.
 *
 * The statblock's numbers land in `state.json`; the attack prose
 * (Multiattack, per-weapon damage) is narrative and lives in the `.md`, which
 * the sheet model preserves verbatim. The schema does not grow for either.
 *
 * The delegation: this module resolves the SRD entry, then calls
 * dnd_character_create's execute with fully computed arguments — one write
 * path, one sheet renderer, one validation, and no second implementation to
 * drift.
 */

import { activeCampaignDir, readCampaignRuleset, DATA_ROOT, readTextOrUndefined, parseJsonLoose } from './shared.mjs'
import { sessionOf } from './session-scope.mjs'
import { parseDiceChain, rollDiceChain } from './roll.mjs'
import { buildTools as buildCharacterCreate } from './character-create.mjs'

export const name = 'dnd-enemy-create'

/**
 * Load the monsters array out of the ruleset's dataset.
 * @param fs - the host fs service.
 * @param ruleset - "2014" or "2024".
 * @returns the monsters array, or null when the dataset is unreachable.
 */
async function loadMonsters(fs, ruleset) {
  try {
    const file = ruleset === '2024' ? 'srd-2024.json' : 'srd-2014.json'
    const text = await readTextOrUndefined(fs, `${DATA_ROOT}/${file}`)
    if (text === undefined) return null
    const data = parseJsonLoose(text)
    return Array.isArray(data?.monsters) ? data.monsters : null
  } catch {
    return null
  }
}

/**
 * Find a monster by name or index, tolerating case and partial input.
 * A miss returns the closest candidates so the caller can name what IS
 * available instead of leaving the DM to guess the spelling.
 */
function findMonster(monsters, query) {
  const wanted = String(query).trim().toLowerCase()
  const byIndex = monsters.find((m) => String(m.index ?? '').toLowerCase() === wanted)
  if (byIndex !== undefined) return { found: byIndex }
  const byName = monsters.find((m) => String(m.name ?? '').toLowerCase() === wanted)
  if (byName !== undefined) return { found: byName }
  const partial = monsters.filter((m) => String(m.name ?? '').toLowerCase().includes(wanted)
    || String(m.index ?? '').toLowerCase().includes(wanted))
  // A one-letter typo defeats substring matching ("gobln"); a shared prefix is
  // the cheapest honest second chance. Still nothing: name the head of the
  // index rather than answering with a bare no.
  if (partial.length === 0) {
    const stem = wanted.slice(0, 2)
    const prefixHits = monsters.filter((m) => String(m.name ?? '').toLowerCase().startsWith(stem))
    const sample = (prefixHits.length > 0 ? prefixHits : monsters).slice(0, 10).map((m) => m.name)
    return { candidates: sample }
  }
  if (partial.length === 1) return { found: partial[0] }
  return { candidates: partial.slice(0, 10).map((m) => m.name) }
}

/**
 * HP override: a bare integer, or a dice expression the tool rolls (the SRD
 * "average" is the expression's expected value; a DM who wants variance rolls).
 * @returns the HP number, or null when unreadable.
 */
function resolveHp(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return Math.floor(n)
  const chain = parseDiceChain(String(raw))
  if (chain === null) return null
  const rolled = rollDiceChain(chain)
  return rolled.total > 0 ? rolled.total : null
}

/**
 * Build this module's tools.
 * @param ctx - host context.
 * @returns an array of tool definitions.
 */
export function buildTools(ctx) {
  const getFs = () => ctx.get('fs')
  const renderText = (_args, value) => [{ type: 'text', text: String(value) }]

  const enemyCreate = {
    name: 'dnd_enemy_create',
    description: 'Create one or more hostile (enemy) character cards from an SRD statblock. '
      + 'Pass `fromSrd` with a monster name ("Goblin Warrior", or its index "goblin-warrior") and `count` (default 1) — '
      + 'the tool fills AC, HP, speed, ability scores and CR from the dataset the campaign\'s ruleset declares, '
      + 'names them Prefix-1, Prefix-2…, writes each through the validated character write path, and the panel\'s enemy section shows them. '
      + 'The statblock\'s attack prose lands in the card narrative verbatim. '
      + 'The DM agent still decides WHICH monsters appear and why — this tool only makes the numbers accurate.',
    parameters: {
      type: 'object',
      properties: {
        fromSrd: { type: 'string', description: 'Monster name or index, e.g. "goblin-warrior" or "Goblin Warrior". Required.' },
        count: { type: 'integer', description: 'How many to create (default 1, max 20). They are independent cards, not a group HP pool.' },
        namePrefix: { type: 'string', description: 'Naming prefix. Default: the monster\'s own name, e.g. "Goblin Warrior-1".' },
        hpOverride: { type: 'string', description: 'Replace the SRD average HP: a number ("11") or an expression to roll ("2d6+2").' },
      },
      required: ['fromSrd'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'

      const query = String(args.fromSrd ?? '').trim()
      if (query === '') return 'dnd_enemy_create needs `fromSrd`, e.g. "goblin-warrior". Nothing was written.'

      const count = args.count === undefined ? 1 : Number(args.count)
      if (!Number.isInteger(count) || count < 1 || count > 20) {
        return 'dnd_enemy_create: `count` must be an integer 1-20 (independent cards, not a group pool). Nothing was written.'
      }

      const campaign = await activeCampaignDir(fs, sessionOf(ctx, exec))
      if (campaign === undefined) return 'No active campaign. Load one with /dm:dnd load <campaign> first.'
      const ruleset = await readCampaignRuleset(fs, campaign.dir)
      const monsters = await loadMonsters(fs, ruleset)
      if (monsters === null) {
        return `dnd_enemy_create could not read the SRD monster dataset (${ruleset}); nothing was written.`
      }

      const match = findMonster(monsters, query)
      if (match.candidates !== undefined) {
        const known = match.candidates.join(', ')
        return `No SRD monster matches "${query}"${match.candidates.length > 0 ? `. Closest: ${known}` : ''}. `
          + 'Nothing was written.'
      }
      const monster = match.found

      const hp = resolveHp(args.hpOverride) ?? (Number.isFinite(monster.hp) ? monster.hp : null)
      if (hp === null) {
        return `dnd_enemy_create: the statblock for "${monster.name}" carries no usable HP, and hpOverride was unreadable. Nothing was written.`
      }

      // Hit dice from the statblock's own dice expression ("6d6" -> die d6,
      // 6 dice), so a long rest recovers half of six, not of level 1.
      const hdMatch = typeof monster.hp_dice === 'string' ? monster.hp_dice.match(/^(\d*)d(\d+)$/i) : null
      const hdCount = hdMatch !== null ? parseInt(hdMatch[1] || '1', 10) : 1
      const hdDie = hdMatch !== null ? `d${hdMatch[2]}` : 'd8'

      // Attacks and traits are prose; the sheet model preserves narrative
      // verbatim. CR and XP lead so the DM sees the threat rating first.
      const narrative = [
        `CR ${monster.cr ?? '?'} (${monster.xp ?? '?'} XP) — ${monster.type ?? 'unknown type'}, ${monster.size ?? ''}`.trim(),
        monster.senses !== undefined && monster.senses !== null && monster.senses !== '' ? `Senses: ${monster.senses}` : null,
        monster.languages !== undefined && monster.languages !== null && monster.languages !== '' ? `Languages: ${monster.languages}` : null,
        typeof monster.description === 'string' && monster.description.trim() !== '' ? monster.description.trim() : null,
      ].filter(Boolean).join('\n\n')

      const prefix = String(args.namePrefix ?? '').trim() || monster.name
      // The delegation: one write path, one sheet renderer, one validation.
      // Building the tool from THIS ctx keeps the caller's session scope.
      const create = buildCharacterCreate(ctx).find((t) => t.name === 'dnd_character_create')
      if (create === undefined) return 'dnd_enemy_create: dnd_character_create is not registered; cannot delegate the write.'

      const speed = Number.isFinite(parseInt(monster.speed, 10)) ? parseInt(monster.speed, 10) : undefined
      const lines = []
      for (let i = 1; i <= count; i += 1) {
        const name = count === 1 ? prefix : `${prefix}-${i}`
        const out = await create.execute({
          name,
          kind: 'enemy',
          race: monster.type ?? undefined,
          level: hdCount,
          hitDie: hdDie,
          hp,
          ac: Number.isFinite(monster.ac) ? monster.ac : undefined,
          speed,
          abilities: {
            STR: monster.str, DEX: monster.dex, CON: monster.con,
            INT: monster.int, WIS: monster.wis, CHA: monster.cha,
          },
          narrative,
        }, exec)
        lines.push(`${name}: ` + String(out).split('\n')[0])
      }
      return `Created ${count} x ${monster.name} (CR ${monster.cr}, ${monster.xp} XP, ruleset ${ruleset}) in ${campaign.campaign}:\n`
        + lines.map((l) => '  ' + l).join('\n')
    },
  }

  return [enemyCreate]
}
