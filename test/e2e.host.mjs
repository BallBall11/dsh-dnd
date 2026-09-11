// e2e.host.mjs — MANUAL, throwaway-campaign-only regression of the Host modules.
//
// REQUIRES a scratch campaign at D:/DND/campaigns/host-test/characters/alice.md.
// It temporarily points the active-campaign marker there (backing up/restoring
// the real marker) so the real campaigns are never written. Not part of the
// normal `npm test` run; run with `npm run test:e2e` when the scratch campaign
// exists.
import { readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const MARKER = 'D:/DND/.runtime/active-campaign.json'
const ORIG_MARKER = 'D:/DND/.runtime/active-campaign.orig.json'
const PREFIX = 'file:///D:/DND/dsh-dnd-bundle/lib/host/'

// ---- mock fs (matches the shape the modules expect) -----------------------
const fs = {
  async resolve(p) { return p.replace(/\\/g, '/') },
  async stat(p) { try { const s = await stat(p.replace(/\//g, path.sep)); return { type: s.isDirectory() ? 'directory' : 'file' } } catch { return undefined } },
  async readText(p) { return readFile(p.replace(/\//g, path.sep), 'utf8') },
  async writeText(p, s) { return writeFile(p.replace(/\//g, path.sep), s, 'utf8') },
  async listDir(p) {
    const d = p.replace(/\//g, path.sep)
    const out = []
    for (const name of await readdir(d)) { out.push({ name, target: (p.endsWith('/') ? p : p + '/') + name, type: 'file' }) }
    return out
  },
}
const registered = []
const tools = { register(t) { registered.push(t); return () => { } } }
const ctx = { get: (n) => (n === 'fs' ? fs : n === 'tools' ? tools : undefined) }

async function load(mod) {
  const m = await import(PREFIX + mod)
  const disposer = m.apply(ctx)
  return { ...m, disposer }
}

async function call(plugin, toolName, args) {
  const tool = registered.find((t) => t.name === toolName)
  if (!tool) return `[${toolName} NOT REGISTERED]`
  const out = await tool.execute(args)
  return typeof out === 'string' ? out : JSON.stringify(out)
}

async function main() {
  // Point at the throwaway campaign, remembering the real marker.
  const realMarker = await readFile(MARKER.replace(/\//g, path.sep), 'utf8')
  await writeFile(ORIG_MARKER.replace(/\//g, path.sep), realMarker, 'utf8')
  await writeFile(MARKER.replace(/\//g, path.sep), JSON.stringify({ name: 'host-test' }), 'utf8')

  const plugins = {
    core: await load('dnd-core.mjs'),
    mechanics: await load('dnd-mechanics.mjs'),
    sheet: await load('dnd-sheet.mjs'),
    xp: await load('dnd-xp.mjs'),
    track: await load('dnd-track.mjs'),
  }
  const toolsRegistered = registered.map((t) => t.name)
  console.log('== registered tools ==', toolsRegistered.join(', '))

  console.log('\n== dnd_character_get (host-test alice) ==')
  console.log(await call('sheet', 'dnd_character_get', { character: 'alice', asMarkdown: true }))

  console.log('\n== dnd_campaign_state ==')
  console.log((await call('core', 'dnd_campaign_state', {})).split(/\n/).slice(0, 6).join('\n'))

  console.log('\n== dnd_check ==')
  console.log(await call('mechanics', 'dnd_check', { mod: 5, dc: 12, label: 'Arcana', advantage: true }))
  console.log('\n== dnd_attack (Shocking Grasp +5 vs AC 15 goblin) ==')
  console.log(await call('mechanics', 'dnd_attack', { toHit: 5, ac: 15, damage: '1d8', label: '电爪' }))
  console.log('\n== dnd_roll ==')
  console.log(await call('core', 'dnd_roll', { spec: '2d6+3' }))

  console.log('\n== dnd_xp_add (dry run first) ==')
  console.log(await call('xp', 'dnd_xp_add', { monsters: 'goblin:1/4:2', characters: 'alice', note: 'test', dryRun: true }))
  const before = await readFile('D:/DND/campaigns/host-test/characters/alice.md'.replace(/\//g, path.sep), 'utf8')
  const beforeXp = before.match(/\*\*XP:\*\*\s*([\d,]+)/)[1]
  console.log('\n== dnd_xp_add (real write) ==')
  console.log(await call('xp', 'dnd_xp_add', { monsters: 'goblin:1/4:1', characters: 'alice', note: 'test' }))
  const after = await readFile('D:/DND/campaigns/host-test/characters/alice.md'.replace(/\//g, path.sep), 'utf8')
  const afterXp = after.match(/\*\*XP:\*\*\s*([\d,]+)/)[1]
  console.log(`XP before=${beforeXp} after=${afterXp}`)

  console.log('\n== dnd_track (damage 3, heal 1, temp 4, deathsave f, inspire on) ==')
  console.log(await call('track', 'dnd_track', { character: 'alice', action: 'damage', value: '3' }))
  console.log(await call('track', 'dnd_track', { character: 'alice', action: 'temp', value: '4' }))
  console.log(await call('track', 'dnd_track', { character: 'alice', action: 'heal', value: '1' }))
  console.log(await call('track', 'dnd_track', { character: 'alice', action: 'deathsave', value: 'f' }))
  console.log(await call('track', 'dnd_track', { character: 'alice', action: 'inspire', value: 'on' }))
  const tracked = await readFile('D:/DND/campaigns/host-test/characters/alice.md'.replace(/\//g, path.sep), 'utf8')
  console.log('Combat Stats after:'); console.log(tracked.split('## Combat Stats')[1].split('##')[0].trim())

  for (const p of Object.values(plugins)) { if (p.disposer) try { p.disposer() } catch {} }
  console.log('\nE2E OK')
}

main()
  .catch((e) => { console.error('E2E FAILED', e); process.exitCode = 1 })
  .finally(async () => {
    try {
      const orig = await readFile(ORIG_MARKER.replace(/\//g, path.sep), 'utf8')
      await writeFile(MARKER.replace(/\//g, path.sep), orig, 'utf8')
      console.log('\n[restored active-campaign marker]')
    } catch { /* ignore */ }
  })
