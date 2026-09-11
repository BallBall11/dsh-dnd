/**
 * dnd-core.mjs — Host tool plugin: bootstrap / reference.
 *
 * Registers the session-bootstrap read/query tools:
 *   - dnd_roll            : deterministic dice roller
 *   - dnd_srd_lookup      : bundled 5e SRD lookup (2014/2024)
 *   - dnd_campaign_state  : read active campaign's state.md key sections
 *
 * This is the original `dsh-dnd-plugin/dnd-host.mjs` three tools, kept intact
 * here as the "core" of the split family. Mounted as a Host row in a bundle
 * via `cordis.patch.yml`; injects the **host** `fs` service (never a realm).
 */

export const name = 'dnd-core'
export const inject = ['fs', 'tools']

const DND_ROOT = 'D:/DND'
const SRD_2014 = DND_ROOT + '/.agents/skills/dnd/data/dnd5e_srd.json'
const SRD_2024 = DND_ROOT + '/.agents/skills/dnd/data/dnd5e_srd_2024.json'
const ACTIVE_MARKER = DND_ROOT + '/.runtime/active-campaign.json'

/** Minimal deterministic d20-style parser for "NdM±X", "dM", "N" specs. */
function parseDice(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') return null
  const match = String(spec).replace(/\s+/g, '').match(/^(\d*)d(\d+)([+-]\d+)?$/i)
  if (match === null) return null
  const count = match[1] === '' ? 1 : parseInt(match[1], 10)
  const sides = parseInt(match[2], 10)
  if (!Number.isInteger(count) || !Number.isInteger(sides) || count < 1 || count > 100 || sides < 2) return null
  const mod = match[3] === undefined ? 0 : parseInt(match[3], 10)
  return { count, sides, mod }
}
function rollDie(sides) { return Math.floor(Math.random() * sides) + 1 }
function rollParsed(expr) {
  const rolls = []
  let sum = 0
  for (let i = 0; i < expr.count; i += 1) { const v = rollDie(expr.sides); rolls.push(v); sum += v }
  const total = sum + expr.mod
  let text = `${expr.count}d${expr.sides}`
  if (expr.mod !== 0) text += (expr.mod > 0 ? '+' : '') + expr.mod
  text += ` = [${rolls.join(', ')}]${expr.mod !== 0 ? ` → ${sum}${expr.mod > 0 ? '+' : ''}${expr.mod}` : ''} = **${total}**`
  return { rolls, total, text }
}

async function readActiveCampaign(fs) {
  try {
    if (!fs) return undefined
    const t = await fs.resolve(ACTIVE_MARKER)
    if ((await fs.stat(t)) === undefined) return undefined
    const parsed = JSON.parse(await fs.readText(t))
    return typeof parsed.name === 'string' && parsed.name ? parsed.name : undefined
  } catch { return undefined }
}
async function detectRuleset(fs) {
  try {
    const campaign = await readActiveCampaign(fs)
    if (!campaign) return '2014'
    const target = await fs.resolve(DND_ROOT + '/campaigns/' + campaign + '/state.md')
    if ((await fs.stat(target)) === undefined) return '2014'
    const m = (await fs.readText(target)).match(/\*\*Ruleset:\*\*\s*(\d{4})/)
    return m && m[1] === '2024' ? '2024' : '2014'
  } catch { return '2014' }
}
function splitSections(text) {
  const sections = {}
  let current = '(preamble)'
  sections[current] = ''
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^##\s+(.+)$/)
    if (m) { current = m[1].trim(); sections[current] = sections[current] ?? ''; continue }
    sections[current] = (sections[current] ?? '') + raw + '\n'
  }
  return sections
}
function formatEntry(entry, categoryOverride) {
  const name = entry.name ?? '(unnamed)'
  const category = categoryOverride ?? entry.category ?? entry.type ?? entry.meta_type ?? ''
  const description = entry.description ?? entry.text ?? ''
  let extra = ''
  if (typeof entry.hit_points === 'number') extra += ` | HP ${entry.hit_points}`
  if (typeof entry.armor_class === 'number') extra += ` | AC ${entry.armor_class}`
  if (typeof entry.level === 'number') extra += ` | Level ${entry.level}`
  const desc = typeof description === 'string' ? description : JSON.stringify(description)
  const trimmed = desc.length > 2500 ? desc.slice(0, 2500) + '…' : desc
  return `### ${name}${category ? ` (${category})` : ''}${extra}\n${trimmed}`
}

export function apply(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('tools service unavailable')
  const fs = ctx.get('fs')
  const renderText = function (_args, value) { return [{ type: 'text', text: String(value) }] }

  const diceTool = {
    name: 'dnd_roll',
    description: 'Roll dice for a D&D session (deterministic table math). Spec like "2d6+3", "d20", "3d8". Optional advantage/disadvantage for a d20. Lightweight native alternative to the skill\'s dice.py.',
    parameters: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'Dice expression, e.g. "2d6+3" or "d20".' },
        disadvantage: { type: 'boolean', description: 'Roll two and take the lower (use for d20 with disadvantage).' },
        advantage: { type: 'boolean', description: 'Roll two and take the higher (use for d20 with advantage).' },
        silent: { type: 'boolean', description: 'Return only the numeric total (for hidden/private rolls).' },
      },
      required: ['spec'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      const parsed = parseDice(args.spec)
      if (parsed === null) return `Invalid dice spec: "${args.spec}". Use NdM±X, e.g. "2d6+3" or "d20".`
      const adv = Boolean(args.advantage)
      const dis = Boolean(args.disadvantage)
      const result = rollParsed(parsed)
      if (adv || dis) {
        const second = rollParsed(parsed)
        const label = dis ? 'disadvantage' : 'advantage'
        const best = dis ? Math.min(result.total, second.total) : Math.max(result.total, second.total)
        const text = `${parsed.count}d${parsed.sides} (${label}): ${result.text} | ${second.text} → pick ${dis ? 'lower' : 'higher'} = **${best}**`
        return args.silent ? String(best) : text
      }
      return args.silent ? String(result.total) : result.text
    },
  }

  const CAT_KEYS = {
    spell: 'spells', monster: 'monsters', item: 'equipment', equipment: 'equipment',
    condition: 'conditions', 'magic-item': 'magic_items', 'class-feature': 'features',
    weapon: 'equipment', armor: 'equipment',
  }
  const lookupTool = {
    name: 'dnd_srd_lookup',
    description: 'Look up an entry in the bundled 5e SRD dataset (2014 or 2024 ruleset) by name or partial name and category. Returns a compact entry. Uses the campaign\'s ruleset unless overridden.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or partial name to search, e.g. "fireball", "goblin", "longsword", "poisoned".' },
        category: { type: 'string', description: 'Optional filter: spell, monster, item, equipment, condition, magic-item, class-feature, weapon, armor, etc.', enum: ['spell', 'monster', 'item', 'equipment', 'condition', 'magic-item', 'class-feature', 'weapon', 'armor'] },
        ruleset: { type: 'string', description: 'Override the dataset: "2014" or "2024". Defaults to auto-detect from the active campaign.', enum: ['2014', '2024'] },
      },
      required: ['query'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      if (fs === undefined) return 'fs service unavailable'
      try {
        const ruleset = args.ruleset === undefined ? await detectRuleset(fs) : args.ruleset
        const srdPath = ruleset === '2024' ? SRD_2024 : SRD_2014
        const target = await fs.resolve(srdPath)
        const stat = await fs.stat(target)
        if (stat === undefined) return `SRD dataset not found for ruleset "${ruleset}": ${srdPath}`
        const data = JSON.parse(await fs.readText(target))
        const q = String(args.query).toLowerCase().trim()
        const cat = args.category
        const flat = []
        if (data && typeof data === 'object') {
          const wantedKey = cat !== undefined ? CAT_KEYS[String(cat).toLowerCase()] : undefined
          const keys = wantedKey !== undefined ? [wantedKey] : Object.keys(data).filter((k) => Array.isArray(data[k]))
          for (const key of keys) {
            const arr = data[key]
            if (!Array.isArray(arr)) continue
            for (const entry of arr) {
              if (typeof entry !== 'object' || entry === null) continue
              if (!String(entry.name ?? '').toLowerCase().includes(q)) continue
              const entryCat = key === 'magic_items' ? 'magic-item' : key
              flat.push({ entry, category: entryCat })
              if (flat.length >= 8) break
            }
            if (flat.length >= 8) break
          }
        }
        if (flat.length === 0) return `No SRD entry matches "${args.query}"${cat ? ` in category ${cat}` : ''} (ruleset ${ruleset}).`
        const lines = flat.map((item) => formatEntry(item.entry, item.category))
        return `[ruleset ${ruleset}] ${flat.length} match${flat.length > 1 ? 'es' : ''}:\n\n` + lines.join('\n\n---\n\n')
      } catch (error) {
        return 'Lookup failed: ' + String(error && error.message ? error.message : error)
      }
    },
  }

  const stateTool = {
    name: 'dnd_campaign_state',
    description: 'Read the active campaign\'s state.md and return the key gameplay sections (situation, quests, live state flags). Use at session start / before a recap instead of reading the whole file.',
    parameters: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Optional: return only one section by its heading keyword, e.g. "party", "location", "situation", "quests", "flags". Omit to return the compact overview.' },
      },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      if (fs === undefined) return 'fs service unavailable'
      try {
        const campaign = await readActiveCampaign(fs)
        if (!campaign) return 'No active campaign set. Expected marker at ' + ACTIVE_MARKER
        const statePath = DND_ROOT + '/campaigns/' + campaign + '/state.md'
        const target = await fs.resolve(statePath)
        const stat = await fs.stat(target)
        if (stat === undefined) return 'state.md not found for campaign ' + campaign
        const text = await fs.readText(target)
        const wanted = args.section ? String(args.section).toLowerCase() : null
        const sections = splitSections(text)
        if (wanted !== null) {
          const key = Object.keys(sections).find((h) => h.toLowerCase().includes(wanted))
          if (key === undefined) return `No section matching "${args.section}". Available: ${Object.keys(sections).join(', ')}`
          return `# ${key}\n${sections[key].trim()}`
        }
        const keys = ['Current Situation', 'Active Quests', 'Live State Flags', 'World State', 'Recent Events']
        const blocks = keys.filter((k) => sections[k] && sections[k].trim() !== '').map((k) => `## ${k}\n${sections[k].trim()}`)
        return `**Campaign:** ${campaign}\n\n` + blocks.join('\n\n')
      } catch (error) {
        return 'Failed to read campaign state: ' + String(error && error.message ? error.message : error)
      }
    },
  }

  const disposers = [diceTool, lookupTool, stateTool].map((tool) => tools.register(tool))
  return {
    dispose() { for (const d of disposers) if (typeof d === 'function') d() },
  }
}
