/**
 * dnd-track.mjs — Host tool plugin: session state (mutating writes, first cut).
 *
 *   - dnd_track : apply a small tracked state change to a character sheet in
 *                 the active campaign (writes the standard markdown fields):
 *                     damage  <n>    reduce HP (temp HP absorbs first)
 *                     heal    <n>    restore HP (up to max)
 *                     temp    <n>    set temp HP
 *                     inspire on|off toggle [[Inspiration]]
 *                     deathsave s|f  record a death-save success/failure (0-3)
 *
 * A deliberately minimal, safe first cut: it only ever edits the active
 * campaign's character copy and only touches the known fields. Deeper
 * time/condition/concentration tracking stays with the skill's tracker.py /
 * calendar.py (authoritative). Both `dryRun` and the write use the SAME final
 * text, so reporting never drifts from what is written.
 */

export const name = 'dnd-track'
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

// Parse the Combat Stats block's HP, Temp HP and Death Saves lines.
function parseCombat(text) {
  const out = { hp: null, max: null, temp: 0, ds: { success: 0, fail: 0 } }
  const hpRe = /\*\*HP:\*\*\s*(\d+)\s*\/\s*(\d+)/
  const m = text.match(hpRe)
  if (m) { out.hp = parseInt(m[1], 10); out.max = parseInt(m[2], 10) }
  const tm = text.match(/\*\*Temp HP:\*\*\s*(\d+)/)
  if (tm) out.temp = parseInt(tm[1], 10)
  if (isFinite(out.temp) === false) out.temp = 0
  const ds = text.match(/Successes:\s*(\d+)\s*\|\s*Failures:\s*(\d+)/)
  if (ds) { out.ds.success = parseInt(ds[1], 10); out.ds.fail = parseInt(ds[2], 10) }
  return out
}

// Produce the new file text for a mutation. Returns { text, report }.
function mutate(text, c, action, value) {
  if (action === 'damage' || action === 'heal') {
    const n = parseInt(value, 10)
    if (!Number.isFinite(n)) return null
    let hp = c.hp
    let temp = c.temp
    if (action === 'damage') {
      const absorb = Math.min(temp, n)
      temp -= absorb
      hp = Math.max(0, c.hp - (n - absorb))
    } else {
      hp = Math.min(c.max, c.hp + n)
    }
    const next = replaceFields(text, { hp: `**HP:** ${hp} / ${c.max}`, temp: `**Temp HP:** ${temp}` })
    return { text: next, report: `${action} ${n}: HP ${c.hp}/${c.max} → ${hp}/${c.max}${temp !== c.temp ? ` ; Temp ${c.temp} → ${temp}` : ''}` }
  }
  if (action === 'temp') {
    const n = parseInt(value, 10)
    if (!Number.isFinite(n)) return null
    const v = Math.max(0, n)
    return { text: replaceFields(text, { temp: `**Temp HP:** ${v}` }), report: `Temp HP ${c.temp} → ${v}` }
  }
  if (action === 'inspire') {
    const on = String(value).toLowerCase() === 'on'
    const next = withInspiration(text, on)
    if (next === false) return { text, report: `Inspiration already ${on ? 'ON' : 'OFF'}` }
    return { text: next, report: `Inspiration → ${on ? 'ON' : 'OFF'}` }
  }
  if (action === 'deathsave') {
    const which = String(value).toLowerCase()
    if (which !== 's' && which !== 'f') return null
    const success = which === 's'
    const ds = { success: c.ds.success + (success ? 1 : 0), fail: c.ds.fail + (success ? 0 : 1) }
    const next = replaceFields(text, { ds: `**Death Saves:** Successes: ${ds.success} | Failures: ${ds.fail}` })
    let tag = `${ds.success}/${ds.fail}`
    if (ds.success >= 3) tag += ' (stable)'
    else if (ds.fail >= 3) tag += ' (dying!)'
    return { text: next, report: `Death save ${success ? 'SUCCESS' : 'FAILURE'}: ${c.ds.success}/${c.ds.fail} → ${tag}` }
  }
  return null
}

function replaceFields(text, fields) {
  let out = text
  if (fields.hp && out.includes('**HP:**')) out = out.replace(/\*\*HP:\*\*\s*(\d+)\s*\/\s*(\d+)/, fields.hp)
  if (fields.temp && out.includes('**Temp HP:**')) out = out.replace(/\*\*Temp HP:\*\*\s*(\d+)/, fields.temp)
  if (fields.ds && out.includes('**Death Saves:**')) out = out.replace(/\*\*Death Saves:\*\*\s*Successes:\s*\d+\s*\|\s*Failures:\s*\d+/, fields.ds)
  return out
}
// Return new text with [[Inspiration]] toggled, or `false` if already in the
// requested state (no change needed).
function withInspiration(text, on) {
  const has = /^\s*-\s*\*\*Inspiration:\*\*\s*Yes/m.test(text)
  if (on) {
    if (has) return false
    return text.replace(/^(## Combat Stats)$/m, '$1\n- **Inspiration:** Yes')
  }
  return has ? text.replace(/\n- \*\*Inspiration:\*\*\s*Yes/, '') : false
}

export function apply(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('tools service unavailable')
  const fs = ctx.get('fs')
  const renderText = function (_args, value) { return [{ type: 'text', text: String(value) }] }

  const trackTool = {
    name: 'dnd_track',
    description: 'Apply a small tracked state change to a character sheet in the active campaign (HP damage/heal, temp HP, inspiration, death save). Writes the standard markdown fields; use `dryRun` to preview. The skill\'s tracker.py remains authoritative for time/condition tracking.',
    parameters: {
      type: 'object',
      properties: {
        character: { type: 'string', description: 'Character file name without ".md", e.g. "alice".', required: true },
        action: { type: 'string', description: 'What to change.', enum: ['damage', 'heal', 'temp', 'inspire', 'deathsave'], required: true },
        value: { type: 'string', description: 'damage/heal/temp: a number. inspire: "on"|"off". deathsave: "s"|"f".' },
        dryRun: { type: 'boolean', description: 'Preview the change without writing.' },
      },
      required: ['character', 'action'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      if (fs === undefined) return 'fs service unavailable'
      try {
        const campaign = await readActiveCampaign(fs)
        if (!campaign) return 'No active campaign set.'
        const key = String(args.character).replace(/\.md$/i, '')
        const target = await fs.resolve(DND_ROOT + '/campaigns/' + campaign + '/characters/' + key + '.md')
        if ((await fs.stat(target)) === undefined) return `Character "${key}" not found in campaign ${campaign}.`
        const text = await fs.readText(target)
        const c = parseCombat(text)
        if (c.hp === null) return 'Sheet has no parseable **HP:** line under Combat Stats.'
        const result = mutate(text, c, args.action, args.value)
        if (result === null) return 'Invalid action/value combination.'
        const prefix = `[${campaign} ${key}]`
        if (args.dryRun) return prefix + ' (dry run) ' + result.report
        await fs.writeText(target, result.text)
        return `${prefix} ${result.report}`
      } catch (error) {
        return 'dnd_track failed: ' + String(error && error.message ? error.message : error)
      }
    },
  }

  const disposers = [trackTool].map((tool) => tools.register(tool))
  return {
    dispose() { for (const d of disposers) if (typeof d === 'function') d() },
  }
}
