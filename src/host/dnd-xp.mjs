/**
 * dnd-xp.mjs — Host tool plugin: progression (one mutating write).
 *
 *   - dnd_xp_add : award character experience for slain monsters / encounters:
 *                  CR -> XP, apply a party-size multiplier, split per character,
 *                  and write the new XP total back into each character sheet's
 *                  `**XP:** N / N` line. Mirrors the skill's xp.py CR/level math;
 *                  xp.py remains the authoritative fallback for full bookkeeping.
 *
 * CR -> XP and level thresholds are stable public 5e data embedded here so the
 * tool stays self-contained and always-on.
 */

export const name = 'dnd-xp'
export const inject = ['fs', 'tools']

const DND_ROOT = 'D:/DND'
const ACTIVE_MARKER = DND_ROOT + '/.runtime/active-campaign.json'

// CR (as string key) -> XP value. Covers 0..30 plus fractional CRs.
const CR_XP = {
  '0': 10, '1/8': 25, '1/4': 50, '1/2': 100, '1': 200, '2': 450, '3': 700,
  '4': 1100, '5': 1800, '6': 2300, '7': 2900, '8': 3900, '9': 5000, '10': 5900,
  '11': 7200, '12': 8400, '13': 10000, '14': 11500, '15': 13000, '16': 15000,
  '17': 18000, '18': 20000, '19': 22000, '20': 25000, '21': 33000, '22': 41000,
  '23': 50000, '24': 62000, '25': 75000, '26': 90000, '27': 105000, '28': 120000,
  '29': 135000, '30': 155000,
}
// XP needed to REACH a given level (index 0 unused). levelFrom(xp) returns the level.
const LEVEL_THRESHOLDS = [0, 0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000,
  85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000]

function levelFrom(xp) {
  let level = 1
  for (let i = 2; i < LEVEL_THRESHOLDS.length; i++) {
    if (xp >= LEVEL_THRESHOLDS[i]) level = i
    else break
  }
  return level
}
function xpForCr(cr) { return CR_XP[String(cr)] }
function parseCr(raw) {
  const s = String(raw).trim().toLowerCase()
  if (CR_XP[s] !== undefined) return s
  // accept "1/4" vs "1/4" etc; also numeric
  return s
}
function parseMonsterSpec(spec) {
  // "goblin:1/4:2" -> {name, cr, count}
  const parts = String(spec).split(':')
  const name = (parts[0] || '').trim()
  const cr = (parts[1] || '0').trim()
  const count = parts[2] ? parseInt(parts[2], 10) : 1
  return { name, cr, count: Number.isFinite(count) && count > 0 ? count : 1 }
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
async function listCharFiles(fs, dir) {
  const out = []
  try {
    const d = await fs.resolve(dir)
    const st = await fs.stat(d)
    if (st === undefined || st.type !== 'directory') return out
    for (const e of await fs.listDir(d)) if (e.type === 'file' && /\.md$/i.test(e.name)) out.push(e)
  } catch { /* ignore */ }
  return out
}

export function apply(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('tools service unavailable')
  const fs = ctx.get('fs')
  const renderText = function (_args, value) { return [{ type: 'text', text: String(value) }] }

  const xpTool = {
    name: 'dnd_xp_add',
    description: 'Award character experience for defeated monsters. `monsters` is a comma list of "name:cr[:count]" (e.g. "goblin:1/4:1, wolf:1/4:2"). Computes CR-based XP, applies a party-size pool multiplier, splits it per listed character, and writes each sheet\'s `**XP:** ` line. Use `dryRun` to preview without writing.',
    parameters: {
      type: 'object',
      properties: {
        monsters: { type: 'string', description: 'Comma-separated monsters as "name:cr[:count]", e.g. "goblin:1/4:1, wolf:1/4:2".', required: true },
        characters: { type: 'string', description: 'Field(s) that took the reward. Omit to auto-detect from each character sheet. When omitted, per-character split is reported but NOT written unless `characters` names a file.', required: true },
        multiplier: { type: 'number', description: 'Party-size pool multiplier (default 1.0).', minimum: 0.5, maximum: 4 },
        note: { type: 'string', description: 'Free-text note describing the award.' },
        dryRun: { type: 'boolean', description: 'When true, only print the calculation, do not write.' },
      },
      required: ['monsters', 'characters'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      if (fs === undefined) return 'fs service unavailable'
      try {
        const campaign = await readActiveCampaign(fs)
        if (!campaign) return 'No active campaign set.'
        const specs = String(args.monsters).split(',').map(parseMonsterSpec).filter((s) => s.name)
        if (specs.length === 0) return 'No valid monster specs.'
        let raw = 0
        const rows = []
        let unknownCr = false
        for (const s of specs) {
          const xp = xpForCr(s.cr)
          if (xp === undefined) { unknownCr = true; continue }
          const batch = xp * s.count
          raw += batch
          rows.push(`  ${s.count}× ${s.name} (CR ${s.cr}): ${batch} XP`)
        }
        const mult = Number(args.multiplier) >= 0.5 ? Number(args.multiplier) : 1.0
        const adjusted = Math.round(raw * mult)
        const names = String(args.characters).split(',').map((s) => s.trim()).filter(Boolean)
        const per = names.length > 0 ? Math.round(adjusted / names.length) : 0
        const head = 'Combat — CR-based  [' + specs.length + ' monster' + (specs.length > 1 ? 's' : '') + ', ×' + mult + ' multiplier]'
        const lines = [head].concat(rows, [`Raw ${raw} × ${mult} = Adjusted ${adjusted}` + (unknownCr ? '  (⚠ one or more CR unknown, skipped)' : '')])
        if (names.length > 0) lines.push(`Split ${per} XP among ` + names.length + ' character(s)')
        if (args.note) lines.push('Note: ' + args.note)
        if (args.dryRun) return [campaign + ' (dry run — not written)'].concat(lines).join('\n')

        if (names.length === 0) {
          lines.push('No character files named; specify `characters` (basename without .md) to write.')
          return lines.join('\n')
        }
        const charDir = DND_ROOT + '/campaigns/' + campaign + '/characters'
        const report = []
        for (const nm of names) {
          const key = nm.replace(/\.md$/i, '')
          const target = await fs.resolve(charDir + '/' + key + '.md')
          if ((await fs.stat(target)) === undefined) { report.push('  ✗ ' + nm + ': not found'); continue }
          const text = await fs.readText(target)
          const res = { current: 0, next: 0, newXp: 0, newLevel: 1 }
          const xpRe = /\*\*XP:\*\*\s*([\d,]+)\s*\/\s*([\d,]+)/
          const m = text.match(xpRe)
          res.current = m ? parseInt(m[1].replace(/,/g, ''), 10) : 0
          res.next = m ? parseInt(m[2].replace(/,/g, ''), 10) : 0
          res.newXp = res.current + per
          res.newLevel = levelFrom(res.newXp)
          const newText = m ? text.replace(xpRe, `**XP:** ${res.newXp} / ${res.next}`) : text
          await fs.writeText(target, newText)
          report.push(`  ✓ ${key}: ${res.current} → ${res.newXp} / ${res.next}  (Lv ${res.newLevel}, ${res.next - res.newXp} to next)`)
        }
        return [campaign].concat(lines, ['Wrote:', ...report]).join('\n')
      } catch (error) {
        return 'XP award failed: ' + String(error && error.message ? error.message : error)
      }
    },
  }

  const disposers = [xpTool].map((tool) => tools.register(tool))
  return {
    dispose() { for (const d of disposers) if (typeof d === 'function') d() },
  }
}
