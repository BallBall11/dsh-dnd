/**
 * dnd-sheet.mjs — Host tool plugin: character sheet + campaign corpus (read-only).
 *
 *   - dnd_character_get  : parse the active campaign's character sheet(s) into
 *                          compact JSON (HP/AC/abilities/skills/attacks/spell
 *                          slots/currency/XP). This is the same parser the
 *                          character-panel Client consumes.
 *   - dnd_campaign_search : full-text substring search over the campaign's
 *                           markdown corpus (state.md, world.md, npcs.md, ...).
 *
 * Both are read-only. The parser here is the canonical `parseCharacterSheet`
 * (also validated by test/parse.test.mjs).
 */

export const name = 'dnd-sheet'
export const inject = ['fs', 'tools']

const DND_ROOT = 'D:/DND'
const ACTIVE_MARKER = DND_ROOT + '/.runtime/active-campaign.json'

async function readActiveCampaign(fs) {
  try {
    if (!fs) return undefined
    const t = await fs.resolve(ACTIVE_MARKER)
    if ((await fs.stat(t)) === undefined) return undefined
    const parsed = JSON.parse(await fs.readText(t))
    return typeof parsed.name === 'string' && parsed.name ? parsed.name : undefined
  } catch { return undefined }
}
async function campaignDir(fs) {
  const campaign = await readActiveCampaign(fs)
  if (!campaign) return null
  return { campaign, dir: DND_ROOT + '/campaigns/' + campaign }
}

function grab(text, re) { const m = text.match(re); return m && m[1] !== undefined ? m[1].trim() : '' }
function grabInt(text, re) { const m = text.match(re); if (!m) return null; const v = parseInt(m[1], 10); return Number.isFinite(v) ? v : null }
const isSep = (cells) => cells.join('|').replace(/[:\-|]/g, '').trim() === ''
function sectionOf(text, key) {
  const lines = text.split(/\r?\n/)
  let grabArr = false
  const out = []
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/)
    if (m) {
      if (grabArr && out.length > 0) break
      if (new RegExp('^' + key, 'i').test(m[1].trim())) { grabArr = true; continue }
      continue
    }
    if (grabArr) out.push(line)
  }
  return out.join('\n')
}
function tableCells(text, headerRe, minCells) {
  const lines = text.split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (!headerRe.test(lines[i])) continue
    for (let j = i + 1; j < lines.length; j++) {
      const row = lines[j]
      if (!row.trim().startsWith('|')) break
      const cells = row.split('|').map((c) => c.trim()).filter(Boolean)
      if (cells.length < minCells || isSep(cells)) continue
      out.push(cells)
    }
    break
  }
  return out
}
function abilityScores(text) {
  const rows = tableCells(text, /STR.*DEX.*CON.*INT.*WIS.*CHA/i, 6)
  if (rows.length === 0) return {}
  const names = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']
  const acc = {}
  for (let k = 0; k < 6; k++) acc[names[k]] = rows[0][k]
  return acc
}
function skillRows(text) {
  const out = []
  for (const cells of tableCells(text, /^##\s*\/?Skills/i, 4)) {
    if (/^Skill$/i.test(cells[0])) continue
    out.push({ name: cells[0], ability: cells[1], bonus: cells[2], proficient: cells[3].includes('✓') })
  }
  return out
}
function attackRows(text) {
  const out = []
  for (const cells of tableCells(text, /^##\s*\/?Attacks/i, 1)) {
    if (/^Name$/i.test(cells[0])) continue
    out.push({ name: cells[0], bonus: cells[1] || '', damage: cells[2] || '', type: cells[3] || '' })
  }
  return out
}

/** Parse one character sheet markdown into a compact plain-JSON object. */
export function parseCharacterSheet(text) {
  const combat = sectionOf(text, 'Combat Stats')
  const identityLine = String(text).split(/\r?\n/).find((l) => l.includes('**Class:**') && l.includes('**Race:**')) || ''
  function identity(key) {
    const m = identityLine.match(new RegExp('\\*\\*' + key + ':\\*\\*\\s*([^|\\n]+)'))
    return m ? m[1].trim() : undefined
  }
  const hpM = combat.match(/\*\*HP:\*\*\s*(\d+)\s*\/\s*(\d+)/)
  const acM = combat.match(/\*\*AC:\*\*\s*(\d+)/)
  const iniM = combat.match(/\*\*Initiative:\*\*\s*([+-]?\d+)/)
  const spdM = combat.match(/\*\*Speed:\*\*\s*(\d+)/)
  const hdM = combat.match(/\*\*Hit Dice:\*\*\s*([^\n|]+)/)
  const dsM = combat.match(/Successes:\s*(\d+)\s*\|\s*Failures:\s*(\d+)/)
  const xpM = text.match(/\*\*XP:\*\*\s*([\d,]+)\s*\/\s*([\d,]+)/)
  const slotsM = text.match(/\|\s*([0-9]+)st\s*\|\s*(\d+)\s*\|\s*(\d+)/)
  const spells = sectionOf(text, 'Known Spells')
  const dcM = spells.match(/\*\*Spell save DC:\*\*\s*(\d+)/)
  const atkM = spells.match(/\*\*Spell attack:\*\*\s*([+-]?\d+)/)
  return {
    name: grab(text, /^#\s+(.+)$/m),
    race: identity('Race'),
    klass: identity('Class'),
    level: (() => { const v = identity('Level'); return v !== undefined ? parseInt(v, 10) : null })(),
    background: identity('Background'),
    xp: xpM ? xpM[1].replace(/,/g, '') : null,
    xpNext: xpM ? xpM[2].replace(/,/g, '') : null,
    hitPoints: hpM ? { current: parseInt(hpM[1], 10), max: parseInt(hpM[2], 10) } : null,
    tempHp: grabInt(combat, /\*\*Temp HP:\*\*\s*(\d+)/),
    ac: acM ? parseInt(acM[1], 10) : null,
    mageArmorAc: grabInt(combat, /\(Mage Armor:\s*(\d+)\)/),
    initiative: iniM ? iniM[1] : null,
    speed: spdM ? parseInt(spdM[1], 10) : null,
    hitDice: hdM ? hdM[1].trim() : null,
    deathSaves: dsM ? { success: parseInt(dsM[1], 10), fail: parseInt(dsM[2], 10) } : { success: null, fail: null },
    abilityScores: abilityScores(text),
    skills: skillRows(text),
    attacks: attackRows(text),
    spellSaveDC: dcM ? parseInt(dcM[1], 10) : null,
    spellAttack: atkM ? atkM[1] : null,
    spellSlots: slotsM ? { level: parseInt(slotsM[1], 10), total: parseInt(slotsM[2], 10), used: parseInt(slotsM[3], 10) } : null,
    cantrips: grab(text, /\*\*Cantrips[^:]*:\*\*\s*(.+)$/m),
    prepared: grab(text, /\*\*Prepared[^:]*:\*\*\s*(.+)$/m),
    currency: grab(text, /\*\*Currency:\*\*\s*([^\n]+)/),
  }
}

/** Render one parsed character as a compact human-readable card string. */
function formatCharacter(c) {
  const hp = c.hitPoints ? `${c.hitPoints.current}/${c.hitPoints.max}` : '—'
  const attrs = c.abilityScores || {}
  const abLine = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'].map((k) => `${k} ${attrs[k] || '—'}`).join(' ')
  const lines = [
    `# ${c.name || '(unnamed)'}${c.klass ? ` — ${c.race ? c.race.split(' (')[0] + ' ' : ''}${c.klass}` : ''}${c.level ? ` Lv${c.level}` : ''}`,
    `HP ${hp}${c.tempHp ? ` (+${c.tempHp} temp)` : ''} · AC ${c.ac ?? '—'}${c.mageArmorAc ? ` (Mage Armor ${c.mageArmorAc})` : ''} · Init ${c.initiative ?? '—'} · Speed ${c.speed ?? '—'}`,
    `XP ${c.xp ?? '0'}/${c.xpNext ?? '?'}${c.spellSaveDC ? ` · DC ${c.spellSaveDC}` : ''}${c.spellAttack ? ` · Spell atk ${c.spellAttack}` : ''}`,
    abLine,
  ]
  if (c.skills && c.skills.length) lines.push('Skills: ' + c.skills.map((s) => `${s.name} ${s.bonus}${s.proficient ? '✓' : ''}`).join(', '))
  if (c.attacks && c.attacks.length) lines.push('Attacks: ' + c.attacks.map((a) => `${a.name} ${a.bonus}${a.damage ? ' (' + a.damage + ')' : ''}`).join(' | '))
  if (c.spellSlots && c.spellSlots.total) lines.push(`Spell slots Lv${c.spellSlots.level}: ${c.spellSlots.total - c.spellSlots.used}/${c.spellSlots.total}`)
  if (c.currency) lines.push(`💰 ${c.currency}`)
  return lines.join('\n')
}

async function listCampaignMd(fs, dir) {
  const out = []
  try {
    const d = await fs.resolve(dir)
    const st = await fs.stat(d)
    if (st === undefined || st.type !== 'directory') return out
    for (const e of await fs.listDir(d)) {
      if (e.type === 'file' && /\.md$/i.test(e.name)) out.push(e)
    }
  } catch { /* ignore */ }
  return out
}

export function apply(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('tools service unavailable')
  const fs = ctx.get('fs')
  const renderText = function (_args, value) { return [{ type: 'text', text: String(value) }] }

  const getTool = {
    name: 'dnd_character_get',
    description: 'Parse the active campaign\'s character sheet(s) into compact JSON. Reads campaigns/<name>/characters/*.md (falls back to the shared characters/ root). By character name (basename without .md) or returns all.',
    parameters: {
      type: 'object',
      properties: {
        character: { type: 'string', description: 'Optional character file name without ".md" (e.g. "alice"). Omit to list all.' },
        asMarkdown: { type: 'boolean', description: 'When true, render each character as a readable markdown card instead of JSON.' },
      },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      if (fs === undefined) return 'fs service unavailable'
      try {
        const found = await campaignDir(fs)
        if (!found) return 'No active campaign set.'
        const { campaign, dir } = found
        const charDir = dir + '/characters'
        const fallback = DND_ROOT + '/characters'
        const files = []
        const seen = new Set()
        for (const base of [charDir, fallback]) {
          for (const e of await listCampaignMd(fs, base)) {
            if (seen.has(e.name)) continue
            seen.add(e.name)
            files.push({ name: e.name, target: e.target })
          }
        }
        let wanted = files
        if (args.character) {
          const key = String(args.character).toLowerCase().replace(/\.md$/i, '')
          wanted = files.filter((f) => f.name.toLowerCase().replace(/\.md$/i, '') === key)
          if (wanted.length === 0) return `No character "${args.character}" in campaign ${campaign}. Available: ${files.map((f) => f.name.replace(/\.md$/i, '')).join(', ')}`
        }
        const parsed = []
        for (const f of wanted) {
          try { parsed.push({ file: f.name, ...parseCharacterSheet(await fs.readText(f.target)) }) } catch { /* skip */ }
        }
        if (parsed.length === 0) return 'No character sheets found.'
        if (args.asMarkdown) return parsed.map(formatCharacter).join('\n\n---\n\n')
        return JSON.stringify({ campaign, characters: parsed }, null, 2)
      } catch (error) {
        return 'Failed to read characters: ' + String(error && error.message ? error.message : error)
      }
    },
  }

  const CANDIDATE_FILES = ['state.md', 'world.md', 'world-nodes.md', 'arc.md', 'npcs.md', 'npcs-full.md', 'session-log.md', 'session-logs.md']
  const searchTool = {
    name: 'dnd_campaign_search',
    description: 'Full-text substring search over the active campaign\'s markdown corpus (state/world/npcs/session logs). Returns up to N matching lines with their source file and section. A lightweight alternative to campaign_search.py.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring or regex to search (case-insensitive).', required: true },
        file: { type: 'string', description: 'Optional: restrict to one file name (e.g. "world.md", "npcs.md").' },
        max: { type: 'integer', description: 'Max matching lines to return (default 12).' },
        regex: { type: 'boolean', description: 'Treat query as a regular expression.' },
      },
      required: ['query'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      if (fs === undefined) return 'fs service unavailable'
      try {
        const found = await campaignDir(fs)
        if (!found) return 'No active campaign set.'
        const { campaign, dir } = found
        const files = []
        for (const name of CANDIDATE_FILES) {
          if (args.file && String(args.file).toLowerCase() !== name) continue
          const target = await fs.resolve(dir + '/' + name)
          if ((await fs.stat(target)) === undefined) continue
          files.push(name)
        }
        if (files.length === 0) return `No campaign files to search in "${campaign}".`
        let re
        try { re = new RegExp(args.regex ? args.query : escapeRegExp(String(args.query)), 'i') } catch (e) { return 'Invalid search: ' + String(e.message) }
        const max = Number(args.max) > 0 ? Number(args.max) : 12
        const out = []
        let section = ''
        for (const name of files) {
          const text = await fs.readText(await fs.resolve(dir + '/' + name))
          for (const line of text.split(/\r?\n/)) {
            const h = line.match(/^#{1,3}\s+(.+)$/)
            if (h) section = h[1].trim()
            if (re.test(line) && line.trim() !== '') {
              out.push({ file: name, section, line: line.trim() })
              if (out.length >= max) break
            }
          }
          if (out.length >= max) break
        }
        if (out.length === 0) return `No match for "${args.query}" in campaign ${campaign}.`
        return [`**Search** "${args.query}" in ${campaign}: ${out.length} match${out.length > 1 ? 'es' : ''}`]
          .concat(out.map((m) => `[${m.file} §${m.section}] ${m.line.slice(0, 220)}`)).join('\n')
      } catch (error) {
        return 'Search failed: ' + String(error && error.message ? error.message : error)
      }
    },
  }
  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

  const disposers = [getTool, searchTool].map((tool) => tools.register(tool))

  // Client panel feed (best-effort). The browser character panel calls
  // `host.call('dnd.characters')`; in the dynamic/`harness` context this is the
  // Package-private RPC. In bundle contexts where `harness` is not exposed this
  // is skipped and the panel's data channel must be wired via the host's RPC
  // service instead (see install/verify notes).
  if (typeof harness !== 'undefined' && harness.handle) {
    const handler = harness.handle('dnd.characters', async () => {
      if (fs === undefined) return { error: 'fs unavailable' }
      const found = await campaignDir(fs)
      if (!found) return { error: 'No active campaign set.' }
      const { campaign, dir } = found
      const charDir = dir + '/characters'
      const fallback = DND_ROOT + '/characters'
      const files = []
      const seen = new Set()
      for (const base of [charDir, fallback]) {
        for (const e of await listCampaignMd(fs, base)) {
          if (seen.has(e.name)) continue
          seen.add(e.name)
          files.push({ name: e.name, target: e.target })
        }
      }
      const characters = []
      for (const f of files) {
        try { characters.push({ file: f.name, ...parseCharacterSheet(await fs.readText(f.target)) }) } catch { /* skip */ }
      }
      let situation = null
      try {
        const st = await fs.stat(await fs.resolve(dir + '/state.md'))
        if (st !== undefined) {
          const sections = {}
          let current = '(preamble)'
          for (const raw of (await fs.readText(await fs.resolve(dir + '/state.md'))).split(/\r?\n/)) {
            const m = raw.match(/^##\s+(.+)$/)
            if (m) { current = m[1].trim(); sections[current] = sections[current] ?? ''; continue }
            sections[current] = (sections[current] ?? '') + raw + '\n'
          }
          const sit = (sections['Current Situation'] || '').trim()
          const locM = sit.match(/- \*\*Location:\*\*\s*(.+)$/m)
          const dateM = sit.match(/- \*\*In-world date\/time:\*\*\s*(.+)$/m)
          const partyM = sit.match(/- \*\*Party:\*\*\s*(.+)$/m)
          situation = { location: locM ? locM[1].trim() : null, date: dateM ? dateM[1].trim() : null, party: partyM ? partyM[1].trim() : null }
        }
      } catch { /* ignore */ }
      return { campaign, situation, characters }
    })
    disposers.push(() => { if (typeof handler === 'function') handler() })
  }

  return {
    dispose() { for (const d of disposers) if (typeof d === 'function') d() },
  }
}
