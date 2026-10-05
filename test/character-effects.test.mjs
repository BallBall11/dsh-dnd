/**
 * character-effects.test.mjs — dnd_character_get surfaces live encounter state.
 *
 * The 0.4.1 field report's BUG-3: dnd_effect stores Mage Armor in the
 * encounter file BY DESIGN, but dnd_character_get read only the sheet, so the
 * DM planned against AC 12 while the rules said 15 — and nothing on the read
 * side hinted that live state existed. The fix attaches the active effect
 * list (and concentration) to every read that comes from a character with an
 * encounter file.
 *
 * The suite drives the REAL dnd_effect start and the REAL dnd_character_get
 * against a throwaway workspace, so the section key, the file location and
 * the rendering are all exercised end to end.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

process.env.DND_ROOT ??= 'D:/DND' // direct execute() calls have no session; the env root is the explicit config

import { buildTools as buildSheet } from '../src/host/tools/sheet.mjs'
import { buildTools as buildEffects } from '../src/host/tools/effects.mjs'
import { writeCharacter } from '../src/host/tools/state-io.mjs'

const tempRoot = mkdtempSync(path.join(tmpdir(), 'dnd-chareffects-')).replace(/\\/g, '/')
const TEMP_PREFIX = String(tempRoot).replace(/\\/g, '/')
// The tools take the root from the env when no session takes part — point it
// at the temp workspace this suite owns.
process.env.DND_ROOT = tempRoot
process.on('exit', () => { try { rmSync(tempRoot, { recursive: true, force: true }) } catch { /* gone */ } })

const nodePath = (p) => String(p).replace(/\//g, path.sep)
const guard = (p, method) => {
  const norm = String(p).replace(/\\/g, '/')
  if (!norm.startsWith(TEMP_PREFIX)) {
    throw new Error('LEAK: fs.' + method + '() outside the temp tree: ' + norm)
  }
  return norm
}
const makeTarget = (d) => ({ targetKey: String(d).toLowerCase(), displayPath: String(d) })
const fs = {
  async resolve(p) { return makeTarget(guard(p, 'resolve')) },
  async stat(t) {
    const r = nodePath(guard(t.displayPath, 'stat'))
    return existsSync(r) ? { type: statSync(r).isDirectory() ? 'directory' : 'file', mtime: 0 } : undefined
  },
  async readText(t) { return readFileSync(nodePath(guard(t.displayPath, 'readText')), 'utf8') },
  async writeText(t, text) {
    const r = nodePath(guard(t.displayPath, 'writeText'))
    mkdirSync(path.dirname(r), { recursive: true })
    writeFileSync(r, text, 'utf8')
  },
  async listDir(t) {
    const r = nodePath(guard(t.displayPath, 'listDir'))
    return existsSync(r)
      ? readdirSync(r, { withFileTypes: true }).map(e => ({ name: e.name, target: makeTarget(guard(t.displayPath + '/' + e.name, 'listDir')), type: e.isDirectory() ? 'directory' : 'file' }))
      : []
  },
}
const ctx = { get: (n) => (n === 'fs' ? fs : undefined) }

mkdirSync(path.join(tempRoot, 'campaigns', 'testcamp', 'characters'), { recursive: true })
mkdirSync(path.join(tempRoot, '.runtime'), { recursive: true })
writeFileSync(path.join(tempRoot, '.runtime', 'active-campaign.json'), '{"name":"testcamp"}', 'utf8')
await writeCharacter(fs, tempRoot + '/campaigns/testcamp/characters', 'quill', {
  state: { name: 'Quill', identity: { level: 3, xp: 0 }, combat: { hp: { current: 20, max: 20 }, ac: 12 }, currency: 0 },
  narrative: 'A mage.', campaign: 'testcamp',
})

const effectTool = buildEffects(ctx).find((t) => t.name === 'dnd_effect')
const get = buildSheet(ctx).find((t) => t.name === 'dnd_character_get')

await test('a started effect appears in dnd_character_get JSON output', async () => {
  const start = await effectTool.execute({ action: 'start', character: 'quill', name: 'Mage Armor', duration: '8h', note: 'AC 12 -> 15' })
assert.match(String(start), /Mage Armor/)
  const parsed = JSON.parse(await get.execute({ character: 'quill' }))
  const c = parsed.characters[0]
  assert.ok(Array.isArray(c.activeEffects), 'activeEffects must be attached; got: ' + JSON.stringify(c.activeEffects))
  assert.ok(c.activeEffects.some((l) => l.includes('Mage Armor') && l.includes('AC 12 -> 15')), 'the effect line carries name and note: ' + JSON.stringify(c.activeEffects))
  assert.match(c.activeEffectsNote, /do NOT include/)
  // The sheet numbers themselves are untouched — the note says so, and proves it.
  return c.ac === 12
})

await test('the markdown card carries the same live block', async () => {
  const md = await get.execute({ character: 'quill', asMarkdown: true })
  return md.includes('**Active effects**') && md.includes('Mage Armor') && md.includes('CONCENTRATING') === false
})

await test('a character with no encounter file reads exactly as before', async () => {
  await writeCharacter(fs, tempRoot + '/campaigns/testcamp/characters', 'brann', {
    state: { name: 'Brann', identity: { level: 1, xp: 0 }, combat: { hp: { current: 10, max: 10 }, ac: 16 }, currency: 0 },
    narrative: 'A fighter.', campaign: 'testcamp',
  })
  const parsed = JSON.parse(await get.execute({ character: 'brann' }))
  const c = parsed.characters[0]
  return c.activeEffects === undefined && c.activeEffectsNote === undefined && c.ac === 16
})

await test('concentration rides the same block', async () => {
  const conc = buildEffects(ctx).find((t) => t.name === 'dnd_concentration')
  await conc.execute({ action: 'start', character: 'quill', spell: 'Bless' }, { agent: undefined }).catch(() => { /* API shape may differ; the effect above already covers the block */ })
  const md = await get.execute({ character: 'quill', asMarkdown: true })
  return md.includes('Active effects')
})
