/**
 * Scenario driver: one in-world day of play against the stage2-test Alice.
 *
 *   - casts a spell, expending one 1st-level slot
 *   - is hit for 3 damage
 *   - spends 15 cp
 *   - the world clock advances to the next day
 *
 * Uses only the public state-io API, so it exercises the same path the DM
 * tools will. Money goes through state-rules: the spend is arithmetic on a
 * single copper total, never an edit to one denomination.
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { readCharacter, writeCharacter } from '../src/host/tools/state-io.mjs'
import { readCalendar } from '../src/host/tools/clock.mjs'
import { spendCurrency, formatCurrency, formatCurrencyShort } from '../src/host/tools/state-rules.mjs'

const nodePath = (p) => String(p).replace(/\//g, path.sep)
const target = (p) => ({ targetKey: String(p).toLowerCase(), displayPath: String(p).replace(/\\/g, '/') })

const fs = {
  async resolve(p) { return target(p) },
  async stat(t) {
    try {
      const s = statSync(nodePath(t.displayPath))
      return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs }
    } catch { return undefined }
  },
  async readText(t) { return readFileSync(nodePath(t.displayPath), 'utf8') },
  async writeText(t, text) { writeFileSync(nodePath(t.displayPath), text, 'utf8') },
  async listDir(t) {
    const { readdirSync } = await import('node:fs')
    const base = String(t.displayPath).replace(/\/$/, '')
    return readdirSync(nodePath(t.displayPath), { withFileTypes: true }).map((e) => ({
      name: e.name, target: target(`${base}/${e.name}`),
      type: e.isDirectory() ? 'directory' : 'file',
    }))
  },
}

const CAMPAIGN = 'D:/DND/campaigns/stage2-test'
const DIR = `${CAMPAIGN}/characters`

const c = await readCharacter(fs, DIR, 'alice')
console.log('=== BEFORE ===')
console.log('  HP         :', `${c.state.combat.hp.current}/${c.state.combat.hp.max}`)
console.log('  slots 1    :', JSON.stringify(c.state.spellSlots['1']))
console.log('  money      :', formatCurrency(c.state.currency), `(${c.state.currency} cp)`)
console.log('  worldTime  :', c.metadata.worldTime)
console.log('  updated    :', c.metadata.updated)

const next = structuredClone(c.state)

// 1. Cast a spell: expend one 1st-level slot.
const slot = next.spellSlots['1']
next.spellSlots = { ...next.spellSlots, 1: { total: slot.total, used: slot.used + 1 } }

// 2. Take 3 damage.
next.combat = { ...next.combat, hp: { current: next.combat.hp.current - 3, max: next.combat.hp.max } }

// 3. Spend 15 cp — arithmetic on the total, not on a denomination.
const spend = spendCurrency(next.currency, 15)
console.log('')
console.log('=== SPEND ===')
console.log('  had        :', formatCurrency(next.currency), `(${next.currency} cp)`)
console.log('  spent      :', formatCurrencyShort(15))
console.log('  affordable :', spend.affordable)
if (!spend.affordable) {
  console.log('  SHORT BY   :', spend.shortfallText)
} else {
  next.currency = spend.total
  console.log('  left       :', formatCurrency(next.currency), `(${next.currency} cp)`)
}

// 4. Advance the world clock one day.
const calendar = await readCalendar(fs, CAMPAIGN)
const advanced = { ...calendar, day: calendar.day + 1, hour: 8 }

const result = await writeCharacter(fs, DIR, 'alice', {
  state: next,
  narrative: c.narrative,
  title: c.title,
  campaign: c.metadata.campaign,
  player: c.metadata.player,
  calendar: advanced,
})

console.log('')
console.log('=== WRITE ===')
console.log('  refused    :', result.refused)
if (result.refused) console.log('  reason     :', result.reason)
if (result.findings !== undefined && result.findings.length > 0) {
  console.log('  findings   :')
  for (const f of result.findings) console.log(`    ${f.level} ${f.field}: ${f.message}`)
} else {
  console.log('  findings   : none')
}

const after = await readCharacter(fs, DIR, 'alice')
console.log('')
console.log('=== AFTER (re-read from disk) ===')
console.log('  HP         :', `${after.state.combat.hp.current}/${after.state.combat.hp.max}`)
console.log('  slots 1    :', JSON.stringify(after.state.spellSlots['1']))
console.log('  money      :', formatCurrency(after.state.currency), `(${after.state.currency} cp)`)
console.log('  worldTime  :', after.metadata.worldTime)
console.log('  updated    :', after.metadata.updated)
console.log('  narrative  :', after.narrative === c.narrative ? 'unchanged' : 'MODIFIED')
