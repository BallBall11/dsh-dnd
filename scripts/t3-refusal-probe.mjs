/**
 * t3-refusal-probe.mjs — evidence for docs/harness/T3-CHARACTER-TARGET-RESOLUTION.md §5.1.
 *
 * Not part of npm run check; run by hand:
 *
 *     node scripts/t3-refusal-probe.mjs
 *
 * ## What it shows
 *
 * Bug report 2b concluded that "an explicit `character` is ignored and the write
 * targets the active campaign's character". The T2-era refusal is the likely
 * source of that reading, and this probe reproduces it in a form that is
 * READABLE: the fs mock's writeText throws the same FS_SANDBOX_DENIED the
 * shipped defect produced, and the probe then prints WHICH FILE each spelling
 * tried to write.
 *
 * The point is that the answers differ per spelling:
 *
 *   "alice" / "ALICE" / "ali"  -> all try alice.state.json
 *   "bob"                      -> tries bob.state.json          (a DIFFERENT file)
 *   "nobody" / omitted         -> never reach the write at all
 *
 * An ignored `character` cannot produce that spread, so the refusal must be
 * happening AFTER resolution. That is T2's defect, not a target-resolution one.
 *
 * ## Safety
 *
 * Writes go to a mkdtemp tree with `D:/DND` remapped inside the mock, and the
 * mock refuses every write anyway. The live campaign and the live
 * active-campaign marker are never touched.
 */

import { readFileSync, writeFileSync, statSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildTools } from '../src/host/tools/track.mjs'

const root = mkdtempSync(path.join(tmpdir(), 't3-refusal-'))
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }) } catch { /* gone */ } })
const cd = path.join(root, 'campaigns', 'refcamp', 'characters')
mkdirSync(cd, { recursive: true })
mkdirSync(path.join(root, '.runtime'), { recursive: true })
writeFileSync(path.join(root, '.runtime', 'active-campaign.json'), JSON.stringify({ name: 'refcamp' }))

for (const stem of ['alice', 'bob']) {
  const st = { schema: 1, name: stem, identity: { xp: 0 }, abilities: {}, combat: { hp: { current: 5, max: 8 }, tempHp: 0 }, skills: {}, equipment: {}, spellSlots: {}, currency: 0 }
  writeFileSync(path.join(cd, stem + '.state.json'), JSON.stringify(st, null, 2) + '\n', 'utf8')
  writeFileSync(path.join(cd, stem + '.md'), '---\ncampaign: refcamp\n---\n# ' + stem + '\n', 'utf8')
}

const remap = (p) => String(p)
  .replace(/^D:\/DND\/campaigns/i, root.replace(/\\/g, '/') + '/campaigns')
  .replace(/^D:\/DND\/\.runtime/i, root.replace(/\\/g, '/') + '/.runtime')
const t = (p) => ({ targetKey: String(p).toLowerCase(), displayPath: String(p).replace(/\\/g, '/') })
const nodePath = (p) => String(p).replace(/\//g, path.sep)

// The fs mock models the T2-era sandbox: every write is REFUSED with exactly the
// error the shipped defect produced, because no session policy can reach it.
const DENIED = 'FS_SANDBOX_DENIED: cannot write "STATE": file access denied under workspace-write mode'
const fsService = {
  async resolve(p) { return t(remap(p)) },
  async stat(x) { try { const s = statSync(nodePath(x.displayPath)); return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs } } catch { return undefined } },
  async readText(x) { return readFileSync(nodePath(x.displayPath), 'utf8') },
  async writeText(x) { throw new Error(DENIED.replace('STATE', x.displayPath)) },
  async listDir(x) {
    const b = String(x.displayPath).replace(/\/$/, '')
    return readdirSync(nodePath(x.displayPath), { withFileTypes: true }).map((e) => ({ name: e.name, target: t(b + '/' + e.name), type: e.isDirectory() ? 'directory' : 'file' }))
  },
}
const byName = Object.fromEntries(buildTools({ get: (n) => (n === 'fs' ? fsService : undefined) }).map((x) => [x.name, x]))
const sha = (stem) => createHash('sha256').update(readFileSync(path.join(cd, stem + '.state.json'))).digest('hex').slice(0, 12)

console.log('T2-era write refusal, across DIFFERENT character arguments')
console.log('(a "target ignored" defect must treat these differently)')
console.log('')
for (const [label, args] of [
  ['character="alice"', { character: 'alice', hp: '-1' }],
  ['character="ALICE"', { character: 'ALICE', hp: '-1' }],
  ['character="ali"',   { character: 'ali', hp: '-1' }],
  ['character omitted', { hp: '-1' }],
  ['character="bob"',   { character: 'bob', hp: '-1' }],
  ['character="nobody"',{ character: 'nobody', hp: '-1' }],
]) {
  const before = sha('alice') + '/' + sha('bob')
  let out
  try { out = String(await byName.dnd_track.execute(args)) } catch (e) { out = 'THREW: ' + e.message }
  const after = sha('alice') + '/' + sha('bob')
  const first = out.split('\n')[0].slice(0, 96)
  console.log(label.padEnd(20) + ' -> ' + first)
  console.log(''.padEnd(20) + '    files moved: ' + (before === after ? 'NONE' : 'YES'))
}
console.log('')
console.log('The refusal is target-INDEPENDENT: "alice"/"ALICE"/"ali" all reach alice.state.json,')
console.log('"bob" reaches a DIFFERENT file, and "nobody"/omitted never reach the write at all.')
console.log('An ignored `character` cannot produce that spread.')
process.exit(0)