/**
 * One-off migration driver for the stage2-test campaign.
 *
 * Reads the copied alice.md, writes the split pair, and prints what changed.
 * Run manually; not part of the test suite.
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { readCharacter, writeCharacter, listCharacters } from '../src/host/tools/state-io.mjs'
import { readCalendar } from '../src/host/tools/clock.mjs'

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
      name: e.name,
      target: target(`${base}/${e.name}`),
      type: e.isDirectory() ? 'directory' : 'file',
    }))
  },
}

const CAMPAIGN = 'D:/DND/campaigns/stage2-test'
const DIR = `${CAMPAIGN}/characters`

const before = readFileSync(nodePath(`${DIR}/alice.md`), 'utf8')
const listed = await listCharacters(fs, DIR)
console.log('characters found:', JSON.stringify(listed))

const c = await readCharacter(fs, DIR, 'alice')
console.log('')
console.log('=== 迁移前 ===')
console.log('  hasStateFile  :', c.hasStateFile)
console.log('  needsMigration:', c.needsMigration)
console.log('  state.name    :', c.state?.name)
console.log('  skills        :', Object.keys(c.state?.skills ?? {}).length)
console.log('  saves         :', JSON.stringify(c.state?.saves))
console.log('  spellSlots    :', JSON.stringify(c.state?.spellSlots))
console.log('  narrative len :', c.narrative.length)
console.log('  warnings      :', JSON.stringify(c.warnings))

const calendar = await readCalendar(fs, CAMPAIGN)
console.log('  calendar      :', JSON.stringify(calendar))

const result = await writeCharacter(fs, DIR, 'alice', {
  state: c.state,
  narrative: c.narrative,
  title: c.title,
  campaign: 'stage2-test',
  player: c.metadata?.player ?? '—',
  calendar,
  now: new Date(),
})
console.log('')
console.log('=== 迁移后 ===')
console.log('  metadata:', JSON.stringify(result.metadata))

const after = readFileSync(nodePath(`${DIR}/alice.md`), 'utf8')
const stateText = readFileSync(nodePath(`${DIR}/alice.state.json`), 'utf8')
console.log('  alice.md         :', before.length, '->', after.length, 'bytes')
console.log('  alice.state.json :', stateText.length, 'bytes')
