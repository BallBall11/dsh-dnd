/**
 * dnd-mechanics.mjs — Host tool plugin: table resolution (pure compute).
 *
 * Deterministic, always-on native tools that resolve a d20 vs a DC/AC and roll
 * damage — no state writes. A lightweight native alternative to dice.py /
 * combat.py for the common table operations (the skill's scripts remain
 * authoritative for full combat state and weapon mastery).
 *
 *   - dnd_check  : ability/skill check vs DC (advantage/disadvantage, nat20/nat1)
 *   - dnd_attack : attack roll vs AC with damage + crit (nat20 doubles dice)
 *   - dnd_save   : saving throw vs DC (incl. death-save framing)
 */

export const name = 'dnd-mechanics'
export const inject = ['tools']

function rollDie(sides) { return Math.floor(Math.random() * sides) + 1 }

/** Roll `count`d`sides`, sum, add mod. Returns {total, rolls, natural, isNat20, isNat1}. */
function rollD20(mod, advantage, disadvantage) {
  const a = rollDie(20)
  const b = rollDie(20)
  const natural = advantage || disadvantage
    ? (disadvantage ? Math.min(a, b) : Math.max(a, b))
    : a
  return {
    rolls: advantage || disadvantage ? [a, b] : [a],
    natural,
    total: natural + mod,
    isNat20: natural === 20,
    isNat1: natural === 1,
    ad: advantage ? 'advantage' : (disadvantage ? 'disadvantage' : ''),
  }
}
function rollDamage(spec) {
  const m = String(spec).replace(/\s+/g, '').match(/^(\d*)d(\d+)([+-]\d+)?$/i)
  if (!m) return { total: 0, rolls: [], expr: spec || '' }
  const count = m[1] === '' ? 1 : parseInt(m[1], 10)
  const sides = parseInt(m[2], 10)
  const mod = m[3] === undefined ? 0 : parseInt(m[3], 10)
  const rolls = []
  let sum = 0
  const limit = Math.min(count, 50)
  for (let i = 0; i < limit; i += 1) { const v = rollDie(sides); rolls.push(v); sum += v }
  const total = sum + mod
  return { total, rolls, expr: `${count}d${sides}${mod !== 0 ? (mod > 0 ? '+' : '') + mod : ''}` }
}
function failureText(success, verb) { return success ? 'SUCCESS ✓' : 'FAILURE ✗' }

export function apply(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('tools service unavailable')
  const renderText = function (_args, value) { return [{ type: 'text', text: String(value) }] }

  const checkTool = {
    name: 'dnd_check',
    description: 'Resolve an ability or skill check: roll a d20 + modifier against a DC (or report raw). Accounts for advantage/disadvantage and flags nat20/nat1.',
    parameters: {
      type: 'object',
      properties: {
        mod: { type: 'integer', description: 'Total modifier to add to the d20 (ability + proficiency), e.g. 5.' },
        dc: { type: 'integer', description: 'Difficulty class to beat. Omit to just report the roll.' },
        advantage: { type: 'boolean', description: 'Roll twice, take the higher.' },
        disadvantage: { type: 'boolean', description: 'Roll twice, take the lower.' },
        label: { type: 'string', description: 'Short label for the check, e.g. "Perception".' },
      },
      required: ['mod'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      const mod = Number(args.mod)
      const isNumeric = Number.isFinite(mod)
      if (!isNumeric) return '`mod` must be a number.'
      const r = rollD20(mod, args.advantage, args.disadvantage)
      const crit = r.isNat20 ? ' (NATURAL 20)' : (r.isNat1 ? ' (NATURAL 1)' : '')
      let head = `${args.label ? args.label + ' — ' : ''}d20${r.ad ? ' (' + r.ad + ')' : ''}${mod !== 0 ? (mod > 0 ? '+' : '') + mod : ''} = ${r.total}${crit}`
      if (args.dc === undefined) return head
      const success = r.total >= args.dc || r.isNat20
      const autoFail = !success && r.isNat1
      return `${head} vs DC ${args.dc} → ${failureText(success && !autoFail, 'check')}${autoFail ? ' (nat 1 always fails)' : ''}`
    },
  }

  const attackTool = {
    name: 'dnd_attack',
    description: 'Resolve an attack: roll d20 + toHit against AC; on a hit roll the damage dice (a natural 20 doubles the damage dice). Reports hit/miss.',
    parameters: {
      type: 'object',
      properties: {
        toHit: { type: 'integer', description: 'Attack roll modifier (e.g. +5).', required: true },
        ac: { type: 'integer', description: 'Target Armor Class.', required: true },
        damage: { type: 'string', description: 'Damage dice expression, e.g. "1d8" or "1d6+2".' },
        advantage: { type: 'boolean', description: 'Roll the d20 twice, take higher.' },
        disadvantage: { type: 'boolean', description: 'Roll the d20 twice, take lower.' },
        label: { type: 'string', description: 'Short label, e.g. "电爪 Shocking Grasp".' },
      },
      required: ['toHit', 'ac'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      const hit = Number(args.toHit)
      const ac = Number(args.ac)
      if (!Number.isFinite(hit) || !Number.isFinite(ac)) return '`toHit` and `ac` must be numbers.'
      const r = rollD20(hit, args.advantage, args.disadvantage)
      const crit = r.isNat20
      const missOnOne = r.isNat1
      const landed = (r.total >= ac) && !missOnOne
      // Double dice expression for a crit: "1d8" -> "2d8", "1d6+2" -> "2d6+2".
      const doubleDiceExpr = (spec) => {
        const m2 = String(spec).replace(/\s+/g, '').match(/^(\d*)d(\d+)([+-]\d+)?$/)
        if (!m2) return spec
        const count = m2[1] === '' ? 1 : parseInt(m2[1], 10)
        return `${count * 2}d${m2[2]}${m2[3] || ''}`
      }
      let out = `${args.label ? args.label + ' — ' : ''}d20${r.ad ? ' (' + r.ad + ')' : ''}${hit !== 0 ? (hit > 0 ? '+' : '') + hit : ''} = ${r.total} vs AC ${ac} → ${landed ? (crit ? 'CRITICAL HIT!' : 'HIT') : 'MISS'}`
      if (!landed || !args.damage) return out
      const d = rollDamage(crit ? doubleDiceExpr(args.damage) : args.damage)
      out += `\nDamage ${d.expr}: ${d.rolls.join(' + ')} = **${d.total}**${crit ? ' (crit: doubled dice)' : ''}`
      return out
    },
  }

  const saveTool = {
    name: 'dnd_save',
    description: 'Resolve a saving throw: roll d20 + modifier vs DC. Supports advantage/disadvantage and flags nat20/nat1.',
    parameters: {
      type: 'object',
      properties: {
        mod: { type: 'integer', description: 'Save modifier, e.g. +2.', required: true },
        dc: { type: 'integer', description: 'Save DC.', required: true },
        advantage: { type: 'boolean', description: 'Roll twice, take higher.' },
        disadvantage: { type: 'boolean', description: 'Roll twice, take lower.' },
        label: { type: 'string', description: 'Short label, e.g. "CON save".' },
      },
      required: ['mod', 'dc'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      const mod = Number(args.mod)
      const dc = Number(args.dc)
      if (!Number.isFinite(mod) || !Number.isFinite(dc)) return '`mod` and `dc` must be numbers.'
      const r = rollD20(mod, args.advantage, args.disadvantage)
      const success = (r.total >= dc) || r.isNat20
      const autoFail = !success && r.isNat1
      const crit = r.isNat20 ? ' (NATURAL 20)' : (r.isNat1 ? ' (NATURAL 1)' : '')
      return `${args.label ? args.label + ' — ' : ''}d20${r.ad ? ' (' + r.ad + ')' : ''}${mod !== 0 ? (mod > 0 ? '+' : '') + mod : ''} = ${r.total}${crit} vs DC ${dc} → ${failureText(success && !autoFail, 'save')}${autoFail ? ' (nat 1 always fails)' : ''}`
    },
  }

  const disposers = [checkTool, attackTool, saveTool].map((tool) => tools.register(tool))
  return {
    dispose() { for (const d of disposers) if (typeof d === 'function') d() },
  }
}
