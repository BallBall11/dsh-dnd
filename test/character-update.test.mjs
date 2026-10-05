/**
 * character-update.test.mjs — dnd_character_update.
 *
 * The tool edits a character's NARRATIVE sections and refuses everything the
 * state file owns. This suite drives the real execute() against a throwaway
 * temp workspace (same pattern as campaign-init.test.mjs): a fixture character
 * born through writeCharacter, then the three ops, the gate refusals, the lock
 * and the byte guarantees.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

process.env.DND_ROOT ??= 'D:/DND' // direct execute() calls have no session; the env root is the explicit config

import { buildTools } from '../src/host/tools/track.mjs'
import { writeCharacter, readCharacter } from '../src/host/tools/state-io.mjs'

const section = (title) => console.log('\n' + title)

const tempRoot = mkdtempSync(path.join(tmpdir(), 'dnd-charupd-')).replace(/\\/g, '/')
process.on('exit', () => { try { rmSync(tempRoot, { recursive: true, force: true }) } catch { /* gone */ } })

const TEMP_CAMPAIGNS = path.join(tempRoot, 'campaigns').replace(/\\/g, '/')
const TEMP_RUNTIME = path.join(tempRoot, '.runtime').replace(/\\/g, '/')
const TEMP_PREFIX = String(tempRoot).replace(/\\/g, '/')
const nodePath = (p) => String(p).replace(/\//g, path.sep)

const remap = (p) => String(p)
  .replace(/^D:\/DND\/campaigns/i, TEMP_CAMPAIGNS)
  .replace(/^D:\/DND\/\.runtime/i, TEMP_RUNTIME)

function guard(mapped, method) {
  const norm = String(mapped).replace(/\\/g, '/')
  if (!norm.startsWith(TEMP_PREFIX)) {
    throw new Error('LEAK: fs.' + method + '() outside the temp tree: ' + norm)
  }
  return norm
}
const makeTarget = (displayPath) => ({ targetKey: String(displayPath).toLowerCase(), displayPath: String(displayPath) })

const writes = []
const fs = {
  async resolve(p) { return makeTarget(guard(remap(p), 'resolve')) },
  async stat(t) {
    const real = nodePath(guard(String(t.displayPath), 'stat'))
    if (!existsSync(real)) return undefined
    const isDir = !real.split(path.sep).pop().includes('.')
    return { type: isDir ? 'directory' : 'file', size: 1, mtime: 0 }
  },
  async readText(t) { return readFileSync(nodePath(guard(String(t.displayPath), 'readText')), 'utf8') },
  async writeText(t, text) {
    const real = nodePath(guard(String(t.displayPath), 'writeText'))
    mkdirSync(path.dirname(real), { recursive: true })
    writeFileSync(real, text, 'utf8')
    writes.push(String(t.displayPath))
  },
  async listDir(t) {
    const real = nodePath(guard(String(t.displayPath), 'listDir'))
    if (!existsSync(real)) return []
    return [{ name: 'alice.state.json', target: makeTarget(guard(String(t.displayPath) + '/alice.state.json', 'listDir')), type: 'file' }]
  },
}

const ctx = { get: (n) => (n === 'fs' ? fs : undefined) }
const update = buildTools(ctx).find((t) => t.name === 'dnd_character_update')
const track = buildTools(ctx).find((t) => t.name === 'dnd_track')

mkdirSync(path.join(nodePath(TEMP_CAMPAIGNS), 'testcamp', 'characters'), { recursive: true })
mkdirSync(nodePath(TEMP_RUNTIME), { recursive: true })
writeFileSync(path.join(nodePath(TEMP_RUNTIME), 'active-campaign.json'), '{"name":"testcamp"}', 'utf8')
writeFileSync(path.join(nodePath(TEMP_CAMPAIGNS), 'testcamp', 'calendar.json'), JSON.stringify({
  day: 2, month: 3, year: 1247, hour: 8, month_length: 30, months: ['A', 'B', 'C'], day_names: [], events: [],
}), 'utf8')

const CHAR_DIR = TEMP_CAMPAIGNS + '/testcamp/characters'
const SHEET = CHAR_DIR + '/alice.md'
const STATE = CHAR_DIR + '/alice.state.json'
const NARRATIVE = 'A tidy wizard in a grey robe, fond of parchment.\n'
const CAL = JSON.parse(readFileSync(path.join(nodePath(TEMP_CAMPAIGNS), 'testcamp', 'calendar.json'), 'utf8'))

// Fresh fixture before each case, so order cannot decide results.
const reset = async () => {
  rmSync(nodePath(CHAR_DIR), { recursive: true, force: true })
  mkdirSync(nodePath(CHAR_DIR), { recursive: true })
  const { refused, reason } = await writeCharacter(fs, CHAR_DIR, 'alice', {
    state: {
      name: 'Alice',
      identity: { level: 1, xp: 0, xpNext: 300 },
      combat: { hp: { current: 8, max: 8 }, tempHp: 0 },
      currency: 785,
      spellSlots: { 1: { total: 2, used: 0 } },
      spells: { cantrips: ['Light'], spellbook: ['Detect Magic'], prepared: ['Mage Armor'] },
    },
    narrative: [
      '## Character Pillar',
      '',
      'Curiosity over caution.',
      '',
      '## Features & Traits',
      '',
      '**Mage Hand** — a cantrip she uses for everything but its purpose.',
      '',
      '## Backstory & Notes',
      '',
      NARRATIVE,
    ].join('\n'),
    player: 'test',
    campaign: 'testcamp',
    calendar: CAL,
  })
  assert.equal(refused, false, 'fixture refused: ' + reason)
  writes.length = 0
}
const sheet = () => readFileSync(nodePath(SHEET), 'utf8')

// ─── the three ops ──────────────────────────────────────────────────────────
section('the three ops')

await test('set-section replaces a narrative section body verbatim', async () => {
  await reset()
  const out = await update.execute({ op: 'set-section', section: 'Character Pillar', body: 'Bravery over curiosity. Full stop.' })
  assert.match(out, /Character Pillar.*replaced|replaced/i)
  return sheet().includes('Bravery over curiosity. Full stop.')
    && !sheet().includes('Curiosity over caution')
})

await test('append adds lines at the end of a section', async () => {
  await reset()
  await update.execute({ op: 'append', section: 'Backstory & Notes', text: 'She counts her coins twice.' })
  const s = sheet()
  const at = s.indexOf('## Backstory & Notes')
  return s.includes('She counts her coins twice.', at) && s.indexOf('She counts', at) > s.indexOf('fond of parchment', at)
})

await test('remove drops only the matching lines', async () => {
  await reset()
  const out = await update.execute({ op: 'remove', section: 'Backstory & Notes', match: 'fond of parchment' })
  assert.match(out, /Removed 1 line/)
  return !sheet().includes('fond of parchment') && sheet().includes('## Backstory & Notes')
})

// ─── the gate ───────────────────────────────────────────────────────────────
section('the gate')

await test('a STRUCTURED section is refused with directions, zero writes', async () => {
  await reset()
  const before = sheet()
  const out = await update.execute({ op: 'set-section', section: 'Combat Stats', body: 'HP 1' })
  assert.match(out, /REFUSED/)
  assert.match(out, /dnd_track/)
  return sheet() === before && writes.length === 0
})

await test('a structured near-miss (spell slots) names the track route', async () => {
  await reset()
  const out = await update.execute({ op: 'set-section', section: 'Spell Slots', body: 'x' })
  return /REFUSED/.test(out) && /dnd_track/.test(out) && writes.length === 0
})

await test('an unknown section is refused and lists the narrative headings', async () => {
  await reset()
  const out = await update.execute({ op: 'append', section: 'Diary', text: 'day one' })
  assert.match(out, /No section "Diary"/)
  assert.match(out, /Features & Traits/)
  return writes.length === 0
})

await test('create:true adds a brand-new narrative section', async () => {
  await reset()
  const out = await update.execute({ op: 'set-section', section: 'Diary', body: 'Day one: rain.', create: true })
  assert.match(out, /Created section/)
  return sheet().includes('## Diary') && sheet().includes('Day one: rain.')
})

await test('bad op and missing body are diagnosed before any IO', async () => {
  await reset()
  const a = await update.execute({ op: 'delete', section: 'X' })
  const b = await update.execute({ op: 'set-section', section: 'X' })
  const c = await update.execute({ op: 'append', section: 'X' })
  const d = await update.execute({ op: 'remove', section: 'X' })
  return /needs `op`/.test(a) && /needs `body`/.test(b) && /needs `text`/.test(c) && /needs `match`/.test(d) && writes.length === 0
})

// ─── the invariants ────────────────────────────────────────────────────────
section('the invariants')

await test('an untouched narrative section stays byte-identical; state numbers unchanged', async () => {
  await reset()
  const before = sheet()
  await update.execute({ op: 'set-section', section: 'Character Pillar', body: 'New pillar.' })
  const s = sheet()
  const beforeB = before.slice(before.indexOf('## Backstory & Notes'))
  const afterB = s.slice(s.indexOf('## Backstory & Notes'))
  const c = await readCharacter(fs, CHAR_DIR, 'alice')
  return beforeB === afterB
    && c.state.combat.hp.current === 8
    && c.state.spells.spellbook.includes('Detect Magic')
})

await test('exactly one generated block survives, and the state file is untouched', async () => {
  await reset()
  const stateBefore = readFileSync(nodePath(STATE), 'utf8')
  await update.execute({ op: 'append', section: 'Features & Traits', text: '**Shield** — reaction, +2 AC.' })
  const s = sheet()
  return (s.match(/<!-- dsh-dnd:generated -->/g) ?? []).length === 1
    && readFileSync(nodePath(STATE), 'utf8') === stateBefore
})

await test('a narrative edit composes with a concurrent dnd_track write', async () => {
  await reset()
  const [a, b] = await Promise.all([
    update.execute({ op: 'append', section: 'Backstory & Notes', text: 'Line A.' }),
    track.execute({ hp: '-3' }),
  ])
  const c = await readCharacter(fs, CHAR_DIR, 'alice')
  return !/REFUSED/.test(a) && !/REFUSED/.test(b)
    && c.state.combat.hp.current === 5
    && sheet().includes('Line A.')
})

await test('no resolvable root answers ROOT_ERROR and writes nothing', async () => {
  await reset()
  const savedDnd = process.env.DND_ROOT
  const savedDsh = process.env.DSH_CWD
  delete process.env.DND_ROOT
  delete process.env.DSH_CWD
  try {
    const out = await update.execute({ op: 'set-section', section: 'Character Pillar', body: 'x' })
    assert.match(out, /无法解析数据根/)
    return writes.length === 0
  } finally {
    if (savedDnd !== undefined) process.env.DND_ROOT = savedDnd
    if (savedDsh !== undefined) process.env.DSH_CWD = savedDsh
  }
})

// The write-contract regression from the 0.4.1 field report: dnd_character_update
// used to drop the session's sandbox policy, so the REAL backend refused every
// write ("file access denied under workspace-write mode") while dnd_track on
// the same file succeeded. The mock cannot reproduce the refusal, so the
// contract is asserted at the fs boundary: BOTH tools must hand writeText the
// calling session's resolved policy as its 5th argument.
await test('write contract: character_update and dnd_track both carry the session policy', async () => {
  await reset()
  let lastPolicy = 'NOT-CALLED'
  const ctxWithPolicy = {
    get: (n) => {
      if (n === 'fs') return { ...fs, writeText: async (t, text, a, b, policy) => { lastPolicy = policy; return fs.writeText(t, text) } }
      if (n === 'sessions') return { get: () => ({ header: { cwd: 'D:/DND' } }) }
      if (n === 'sandboxPolicy') return { resolve: ({ session }) => ({ workspaceRoot: session.header.cwd, mode: 'workspace-write', sessionId: 'session-1' }) }
      return undefined
    },
  }
  const exec = { agent: { id: 'session-1' } }
  const tools = buildTools(ctxWithPolicy)
  const upd = tools.find((t) => t.name === 'dnd_character_update')

  lastPolicy = 'NOT-CALLED'
  await upd.execute({ op: 'set-section', section: 'Character Pillar', body: 'Policy check.' }, exec)
  assert.ok(lastPolicy !== 'NOT-CALLED', 'character_update must call writeText')
  assert.equal(lastPolicy.workspaceRoot, 'D:/DND', 'character_update must thread the SESSION policy')
  assert.equal(lastPolicy.sessionId, 'session-1')

  lastPolicy = 'NOT-CALLED'
  const trk = tools.find((t) => t.name === 'dnd_track')
  await trk.execute({ hp: '-1' }, exec)
  assert.ok(lastPolicy !== 'NOT-CALLED', 'track must call writeText')
  assert.equal(lastPolicy.workspaceRoot, 'D:/DND', 'track must thread the SAME policy shape')
  return lastPolicy.sessionId === 'session-1'
})
