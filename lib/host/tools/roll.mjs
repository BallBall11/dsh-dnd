/**
 * tools/roll.mjs — dice, table resolution, and 2024 weapon mastery.
 *
 * Pure computation: no fs, no state writes, no campaign reads. These are the
 * tools worth having as natives, because each one replaces a shell round-trip
 * to a Python script whose stdout would then have to be parsed.
 *
 *   dnd_roll     NdM±X with advantage/disadvantage and kh/kl keep-highest
 *   dnd_check    d20 + mod vs DC
 *   dnd_attack   d20 + toHit vs AC, damage on a hit, doubled dice on a crit
 *   dnd_save     d20 + mod vs DC
 *   dnd_mastery  2024 weapon mastery property reference
 *   dnd_dc       common DC ladder / passive score
 *
 * The skill's dice.py remains authoritative for the physical-dice ritual and
 * --player routing; these are for table math the DM resolves directly.
 */

export const name = 'dnd-roll'

/** Roll one die. */
function rollDie(sides) {
  return Math.floor(Math.random() * sides) + 1
}

/**
 * Parse a dice expression.
 * Supports `NdM`, `dM`, `NdM±X`, and keep-highest/lowest `NdMkhK` / `NdMklK`.
 * @param spec - e.g. "2d6+3", "d20", "4d6kh3".
 * @returns a parsed expression, or null when unparseable.
 */
export function parseDice(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') return null
  const match = spec.replace(/\s+/g, '').match(/^(\d*)d(\d+)(kh\d+|kl\d+)?([+-]\d+)?$/i)
  if (match === null) return null
  const count = match[1] === '' ? 1 : parseInt(match[1], 10)
  const sides = parseInt(match[2], 10)
  if (!Number.isInteger(count) || !Number.isInteger(sides)) return null
  if (count < 1 || count > 100 || sides < 2 || sides > 1000) return null
  const keep = match[3] === undefined ? null : parseInt(match[3].slice(2), 10)
  const keepHigh = match[3] !== undefined && match[3].toLowerCase().startsWith('kh')
  const mod = match[4] === undefined ? 0 : parseInt(match[4], 10)
  if (keep !== null && (keep < 1 || keep > count)) return null
  return { count, sides, mod, keep, keepHigh }
}

/**
 * Roll a parsed expression.
 * @param expr - a parseDice result.
 * @returns `{ rolls, kept, total, text }`.
 */
export function rollParsed(expr) {
  const rolls = []
  for (let i = 0; i < expr.count; i += 1) rolls.push(rollDie(expr.sides))
  let kept = rolls
  if (expr.keep !== null) {
    const sorted = [...rolls].sort((a, b) => (expr.keepHigh ? b - a : a - b))
    kept = sorted.slice(0, expr.keep)
  }
  const sum = kept.reduce((acc, v) => acc + v, 0)
  const total = sum + expr.mod
  let text = `${expr.count}d${expr.sides}`
  if (expr.keep !== null) text += (expr.keepHigh ? 'kh' : 'kl') + expr.keep
  if (expr.mod !== 0) text += (expr.mod > 0 ? '+' : '') + expr.mod
  text += ` = [${rolls.join(', ')}]`
  if (expr.keep !== null) text += ` keep [${kept.join(', ')}]`
  if (expr.mod !== 0) text += ` ${expr.mod > 0 ? '+' : ''}${expr.mod}`
  text += ` = **${total}**`
  return { rolls, kept, total, text }
}

/**
 * Roll a d20 with optional advantage/disadvantage.
 * @returns `{ rolls, natural, total, isNat20, isNat1, ad }`.
 */
export function rollD20(mod, advantage, disadvantage) {
  const both = Boolean(advantage) || Boolean(disadvantage)
  const first = rollDie(20)
  const second = rollDie(20)
  const natural = both ? (disadvantage ? Math.min(first, second) : Math.max(first, second)) : first
  return {
    rolls: both ? [first, second] : [first],
    natural,
    total: natural + mod,
    isNat20: natural === 20,
    isNat1: natural === 1,
    ad: advantage ? 'advantage' : (disadvantage ? 'disadvantage' : ''),
  }
}

/** Format the shared `d20+MOD = TOTAL` head of a roll line. */
function rollHead(label, roll, mod) {
  const ad = roll.ad !== '' ? ` (${roll.ad})` : ''
  const sign = mod !== 0 ? (mod > 0 ? `+${mod}` : `${mod}`) : ''
  const crit = roll.isNat20 ? ' (NATURAL 20)' : (roll.isNat1 ? ' (NATURAL 1)' : '')
  return `${label !== undefined && label !== '' ? `${label} — ` : ''}d20${ad}${sign} = ${roll.total}${crit}`
}

/** Double a damage expression's dice: "1d8" -> "2d8", "1d6+2" -> "2d6+2". */
function doubleDice(spec) {
  const match = String(spec).replace(/\s+/g, '').match(/^(\d*)d(\d+)(.*)$/)
  if (match === null) return spec
  const count = match[1] === '' ? 1 : parseInt(match[1], 10)
  return `${count * 2}d${match[2]}${match[3] ?? ''}`
}

/**
 * The eight 2024 weapon mastery properties (SRD 5.2), condensed to the
 * mechanical effect a DM needs at the table.
 */
export const MASTERY = {
  cleave: {
    name: 'Cleave',
    text: 'If you hit a creature with a melee weapon attack, you can attack a second creature within 5 ft of the first that is also within your reach. On a hit, the second takes the weapon\'s damage (no ability modifier added) — once per turn.',
    weapons: 'Greataxe, Halberd',
  },
  graze: {
    name: 'Graze',
    text: 'If your attack roll misses, the target still takes damage equal to your ability modifier for the attack (minimum 0). No other damage dice are added.',
    weapons: 'Glaive, Greatsword',
  },
  nick: {
    name: 'Nick',
    text: 'When you make the extra attack of the Light property, you can make it as part of the Attack action instead of a Bonus Action. Once per turn.',
    weapons: 'Dagger, Light Hammer, Sickle, Scimitar',
  },
  push: {
    name: 'Push',
    text: 'If you hit a creature with a weapon attack, you can push it up to 10 ft straight away from you if it is Large or smaller.',
    weapons: 'Greatclub, Pike, Warhammer, Heavy Crossbow',
  },
  sap: {
    name: 'Sap',
    text: 'If you hit a creature with a weapon attack, that creature has Disadvantage on its next attack roll before the start of your next turn.',
    weapons: 'Mace, Spear, Flail, Longsword',
  },
  slow: {
    name: 'Slow',
    text: 'If you hit a creature with a weapon attack and deal damage, you can reduce its Speed by 10 ft until the start of your next turn. It can be slowed only once per turn.',
    weapons: 'Club, Javelin, Light Crossbow, Sling, Whip, Musket',
  },
  topple: {
    name: 'Topple',
    text: 'If you hit a creature with a weapon attack, you can force it to make a CON save (DC 8 + your proficiency bonus + the ability modifier used). On a failure it has the Prone condition.',
    weapons: 'Quarterstaff, Battleaxe, Maul, Trident',
  },
  vex: {
    name: 'Vex',
    text: 'If you hit a creature with a weapon attack and deal damage, you have Advantage on your next attack roll against that creature before the end of your next turn.',
    weapons: 'Handaxe, Shortbow, Rapier, Hand Crossbow, Blowgun, Dart',
  },
}

/**
 * The standard DC ladder, so a DM can pick a number instead of inventing one.
 */
export const DC_LADDER = [
  { dc: 5, label: 'Very easy', text: 'Anyone can do this almost always.' },
  { dc: 10, label: 'Easy', text: 'A competent person succeeds most of the time.' },
  { dc: 15, label: 'Medium', text: 'A trained person succeeds about half the time.' },
  { dc: 20, label: 'Hard', text: 'Only a specialist reliably succeeds.' },
  { dc: 25, label: 'Very hard', text: 'Needs expertise, luck, or both.' },
  { dc: 30, label: 'Nearly impossible', text: 'The stuff of legend.' },
]

/**
 * Build this module's tools.
 * @param _ctx - host context; this module is pure computation and needs none.
 * @returns an array of tool definitions.
 */
export function buildTools(_ctx) {
  const renderText = (_args, value) => [{ type: 'text', text: String(value) }]

  const dice = {
    name: 'dnd_roll',
    description: 'Roll dice. Spec like "2d6+3", "d20", "4d6kh3" (keep highest 3), "d20+3 kl1". Optional advantage/disadvantage rerolls a d20. Deterministic table math; the skill\'s dice.py remains authoritative for the physical-dice ritual and --player routing.',
    parameters: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'Dice expression, e.g. "2d6+3", "d20", "4d6kh3".', required: true },
        advantage: { type: 'boolean', description: 'For a d20: roll twice and take the higher.' },
        disadvantage: { type: 'boolean', description: 'For a d20: roll twice and take the lower.' },
        silent: { type: 'boolean', description: 'Return only the numeric total (for hidden rolls).' },
      },
      required: ['spec'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      const expr = parseDice(args.spec)
      if (expr === null) return `Invalid dice spec: "${args.spec}". Use NdM±X or NdMkhK, e.g. "2d6+3" or "4d6kh3".`
      const first = rollParsed(expr)
      if (expr.sides === 20 && (args.advantage || args.disadvantage)) {
        const second = rollParsed(expr)
        const useLower = Boolean(args.disadvantage)
        const picked = useLower
          ? Math.min(first.total, second.total)
          : Math.max(first.total, second.total)
        const label = useLower ? 'disadvantage' : 'advantage'
        if (args.silent) return String(picked)
        return `${expr.count}d${expr.sides} (${label}): ${first.text} | ${second.text} → pick ${useLower ? 'lower' : 'higher'} = **${picked}**`
      }
      return args.silent ? String(first.total) : first.text
    },
  }

  const check = {
    name: 'dnd_check',
    description: 'Resolve an ability or skill check: d20 + modifier vs a DC. Handles advantage/disadvantage and flags natural 20/1.',
    parameters: {
      type: 'object',
      properties: {
        mod: { type: 'integer', description: 'Total modifier added to the d20 (ability + proficiency).', required: true },
        dc: { type: 'integer', description: 'Difficulty class. Omit to just report the roll.' },
        advantage: { type: 'boolean', description: 'Roll twice, take the higher.' },
        disadvantage: { type: 'boolean', description: 'Roll twice, take the lower.' },
        label: { type: 'string', description: 'Short label, e.g. "Perception".' },
      },
      required: ['mod'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      const mod = Number(args.mod)
      if (!Number.isFinite(mod)) return '`mod` must be a number.'
      const roll = rollD20(mod, args.advantage, args.disadvantage)
      const head = rollHead(args.label, roll, mod)
      if (args.dc === undefined) return head
      const meets = roll.total >= Number(args.dc)
      const success = roll.isNat20 || (meets && !roll.isNat1)
      const note = roll.isNat1 && meets ? ' (nat 1 still fails)' : ''
      return `${head} vs DC ${args.dc} → ${success ? 'SUCCESS ✓' : 'FAILURE ✗'}${note}`
    },
  }

  const attack = {
    name: 'dnd_attack',
    description: 'Resolve an attack: d20 + toHit vs AC; on a hit roll the damage dice. A natural 20 is a critical hit and doubles the damage DICE (not the modifier).',
    parameters: {
      type: 'object',
      properties: {
        toHit: { type: 'integer', description: 'Attack roll modifier, e.g. +5.', required: true },
        ac: { type: 'integer', description: 'Target Armor Class.', required: true },
        damage: { type: 'string', description: 'Damage dice expression, e.g. "1d8" or "1d6+2".' },
        advantage: { type: 'boolean', description: 'Roll the d20 twice, take the higher.' },
        disadvantage: { type: 'boolean', description: 'Roll the d20 twice, take the lower.' },
        label: { type: 'string', description: 'Short label, e.g. "Shocking Grasp".' },
      },
      required: ['toHit', 'ac'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      const toHit = Number(args.toHit)
      const ac = Number(args.ac)
      if (!Number.isFinite(toHit) || !Number.isFinite(ac)) return '`toHit` and `ac` must be numbers.'
      const roll = rollD20(toHit, args.advantage, args.disadvantage)
      const critical = roll.isNat20
      const hit = (roll.total >= ac || critical) && !roll.isNat1
      let out = `${rollHead(args.label, roll, toHit)} vs AC ${ac} → ${hit ? (critical ? 'CRITICAL HIT!' : 'HIT') : 'MISS'}`
      if (critical && roll.total < ac) out += ' (nat 20 always hits)'
      if (!hit || !args.damage) return out
      const expr = parseDice(critical ? doubleDice(args.damage) : args.damage)
      if (expr === null) return `${out}\n(unparseable damage expression: "${args.damage}")`
      const damage = rollParsed(expr)
      out += `\nDamage ${damage.text}${critical ? ' (crit: dice doubled)' : ''}`
      return out
    },
  }

  const save = {
    name: 'dnd_save',
    description: 'Resolve a saving throw: d20 + modifier vs DC. Handles advantage/disadvantage and flags natural 20/1. Also usable for a death save (mod 0, dc 10).',
    parameters: {
      type: 'object',
      properties: {
        mod: { type: 'integer', description: 'Save modifier, e.g. +2.', required: true },
        dc: { type: 'integer', description: 'Save DC.', required: true },
        advantage: { type: 'boolean', description: 'Roll twice, take the higher.' },
        disadvantage: { type: 'boolean', description: 'Roll twice, take the lower.' },
        label: { type: 'string', description: 'Short label, e.g. "CON save".' },
      },
      required: ['mod', 'dc'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      const mod = Number(args.mod)
      const dc = Number(args.dc)
      if (!Number.isFinite(mod) || !Number.isFinite(dc)) return '`mod` and `dc` must be numbers.'
      const roll = rollD20(mod, args.advantage, args.disadvantage)
      const meets = roll.total >= dc
      const success = roll.isNat20 || (meets && !roll.isNat1)
      const note = roll.isNat1 && meets ? ' (nat 1 still fails)' : ''
      return `${rollHead(args.label, roll, mod)} vs DC ${dc} → ${success ? 'SUCCESS ✓' : 'FAILURE ✗'}${note}`
    },
  }

  const mastery = {
    name: 'dnd_mastery',
    description: 'Look up a 2024 weapon mastery property (Cleave, Graze, Nick, Push, Sap, Slow, Topple, Vex), or list them all. 2024-ruleset campaigns only; a 2014 campaign has no weapon mastery. This surfaces the rule — applying it (e.g. starting a Sap/Slow effect) is the DM\'s call via the skill\'s tracker.',
    parameters: {
      type: 'object',
      properties: {
        property: { type: 'string', description: 'Property name, e.g. "topple". Omit to list all eight.', enum: ['cleave', 'graze', 'nick', 'push', 'sap', 'slow', 'topple', 'vex'] },
      },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      if (args.property === undefined) {
        return 'Weapon mastery properties (2024 / SRD 5.2):\n\n'
          + Object.entries(MASTERY)
            .map(([key, m]) => `**${m.name}** (\`${key}\`) — ${m.text}\n  Weapons: ${m.weapons}`)
            .join('\n\n')
      }
      const key = String(args.property).toLowerCase()
      const found = MASTERY[key]
      if (found === undefined) {
        return `Unknown mastery property "${args.property}". Known: ${Object.keys(MASTERY).join(', ')}.`
      }
      return `**${found.name}**\n${found.text}\nWeapons with this property: ${found.weapons}`
    },
  }

  const dc = {
    name: 'dnd_dc',
    description: 'Reference for setting or recalling a DC: the standard difficulty ladder, or a passive score (10 + modifier, ±5 for advantage/disadvantage).',
    parameters: {
      type: 'object',
      properties: {
        mod: { type: 'integer', description: 'Modifier, to compute a passive score (10 + mod).' },
        advantage: { type: 'boolean', description: 'With mod: passive score gets +5.' },
        disadvantage: { type: 'boolean', description: 'With mod: passive score gets -5.' },
        difficulty: { type: 'string', description: 'Look up one rung of the ladder.', enum: ['very easy', 'easy', 'medium', 'hard', 'very hard', 'nearly impossible'] },
      },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      const lines = []
      if (args.difficulty !== undefined) {
        const wanted = String(args.difficulty).toLowerCase()
        const rung = DC_LADDER.find((r) => r.label.toLowerCase() === wanted)
        if (rung === undefined) return `Unknown difficulty "${args.difficulty}". Known: ${DC_LADDER.map((r) => r.label).join(', ')}.`
        lines.push(`**${rung.label} — DC ${rung.dc}**: ${rung.text}`)
      }
      if (args.mod !== undefined) {
        const mod = Number(args.mod)
        if (!Number.isFinite(mod)) return '`mod` must be a number.'
        let bonus = 0
        let note = ''
        if (args.advantage) { bonus = 5; note = ' (advantage +5)' }
        else if (args.disadvantage) { bonus = -5; note = ' (disadvantage -5)' }
        lines.push(`**Passive score: ${10 + mod + bonus}**${note}  (10 + ${mod}${bonus !== 0 ? (bonus > 0 ? ` + ${bonus}` : ` - ${Math.abs(bonus)}`) : ''})`)
      }
      if (lines.length === 0) {
        lines.push('Standard DC ladder:')
        for (const rung of DC_LADDER) lines.push(`  DC ${String(rung.dc).padStart(2)} — ${rung.label}: ${rung.text}`)
        lines.push('')
        lines.push('Passive score = 10 + modifier (±5 for advantage/disadvantage). Pass `mod` to compute one.')
      }
      return lines.join('\n')
    },
  }

  return [dice, check, attack, save, mastery, dc]
}
