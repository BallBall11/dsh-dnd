/**
 * Refusal path: a spend the character cannot afford must be refused, not
 * written as a debt.
 *
 * Drives the same API as the scenario, with a purse too small for the price.
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

const before = readFileSync(nodePath(`${DIR}/alice.state.json`), 'utf8')
const c = await readCharacter(fs, DIR, 'alice')

// A purse of 5 cp, and a 1 gp price.
const poor = { ...c.state, currency: 5 }
const spend = spendCurrency(poor.currency, 100)

console.log('=== AFFORDABILITY ===')
console.log('  purse      :', formatCurrency(poor.currency), `(${poor.currency} cp)`)
console.log('  price      :', formatCurrency(100))
console.log('  affordable :', spend.affordable)
console.log('  short by   :', spend.shortfallText)

// The caller refuses. It does not write a debt.
if (!spend.affordable) {
  console.log('')
  console.log('  -> refusing the purchase; nothing is written')
} else {
  poor.currency = spend.total
}

// Now attempt to write a state that is invalid for a different reason:
// more slots expended than exist. The write must be refused too.
const broken = { ...c.state, spellSlots: { 1: { total: 2, used: 5 } } }
const calendar = await readCalendar(fs, CAMPAIGN)
const result = await writeCharacter(fs, DIR, 'alice', {
  state: broken,
  narrative: c.narrative,
  title: c.title,
  campaign: c.metadata.campaign,
  player: c.metadata.player,
  calendar,
})

console.log('')
console.log('=== INVALID STATE WRITE ===')
console.log('  refused    :', result.refused)
console.log('  reason     :', result.reason)

const after = readFileSync(nodePath(`${DIR}/alice.state.json`), 'utf8')
console.log('')
console.log('=== FILE UNCHANGED? ===')
console.log('  ', before === after ? 'yes — the refused write touched nothing' : 'NO — the file was modified!')
