/**
 * temp-campaign.mjs — a throwaway workspace with a real, active campaign, and
 * the fs double that execute()-level suites share.
 *
 * Why this exists: every write-path suite used to hand-roll the same
 * choreography — temp dir, active-campaign marker, calendar, character seeds,
 * a private fs mock. The choreography was expensive enough that the
 * execute()-level invariants (every write tool stamps both clocks, most
 * recently worldTime surviving dnd_character_update) had exactly zero
 * coverage. One call here replaces the whole setup, so an execute()-level
 * assertion costs the same as a unit assertion.
 *
 * The fs double conforms to the contract as the REAL backend defines it:
 * `resolve()` hands out FsTarget objects, `stat()` returns undefined for a
 * missing path, and every method refuses a path outside the workspace it
 * owns. A mock looser than the real backend cannot fail, and a mock that
 * cannot fail has validated nothing (this project shipped two bugs that way).
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeCharacter } from '../../src/host/tools/state-io.mjs'

const toPosix = (p) => String(p).replace(/\\/g, '/')

/**
 * An fs double over node:fs, confined to `root`.
 * @param root - the workspace root, POSIX form; every call is guarded to it.
 */
export function makeTempFs(root) {
  const rootPosix = toPosix(root)
  const guard = (method, p) => {
    const norm = toPosix(p)
    if (!norm.startsWith(rootPosix)) {
      throw new Error(`LEAK: fs.${method}() outside the temp workspace: ${norm}`)
    }
    return norm
  }
  const target = (p) => ({ targetKey: toPosix(p).toLowerCase(), displayPath: toPosix(p) })
  return {
    async resolve(p) { return target(guard('resolve', p)) },
    async stat(t) {
      const r = guard('stat', t.displayPath)
      try {
        const s = statSync(r)
        return { type: s.isDirectory() ? 'directory' : 'file', mtime: s.mtimeMs }
      } catch {
        return undefined
      }
    },
    async readText(t) { return readFileSync(guard('readText', t.displayPath), 'utf8') },
    async writeText(t, text) {
      const r = guard('writeText', t.displayPath)
      mkdirSync(path.dirname(r), { recursive: true })
      writeFileSync(r, text, 'utf8')
    },
    async listDir(t) {
      const r = guard('listDir', t.displayPath)
      if (!statSync(r, { throwIfNoEntry: false })) return []
      return readdirSync(r, { withFileTypes: true }).map((e) => ({
        name: e.name,
        target: target(guard('listDir', t.displayPath + '/' + e.name)),
        type: e.isDirectory() ? 'directory' : 'file',
      }))
    },
  }
}

/**
 * Create a temp workspace, mark a campaign active in it, and seed characters
 * through the REAL `writeCharacter` — so the fixture exercises the same
 * two-file write the production tools do, frontmatter and both clocks
 * included. Sets `process.env.DND_ROOT` to the workspace (direct `execute()`
 * calls carry no session, so the env root is the explicit configuration);
 * `dispose()` restores it and deletes the tree.
 *
 * @param options - `{ name, calendar, characters }`. `calendar` defaults to a
 *   fixed one whose world time renders as `2 Thawmonth 1247 AR, 08:00`.
 *   `characters` are `{ name, state, narrative? }` seeds.
 */
export async function tempCampaign({ name = 'clocks-camp', calendar, characters = [] } = {}) {
  const previousRoot = process.env.DND_ROOT
  const root = toPosix(mkdtempSync(path.join(tmpdir(), 'dnd-pipeline-')))
  process.env.DND_ROOT = root

  mkdirSync(path.join(root, '.runtime'), { recursive: true })
  writeFileSync(path.join(root, '.runtime', 'active-campaign.json'), JSON.stringify({ name }), 'utf8')

  const cal = calendar ?? { day: 2, month: 3, year: 1247, hour: 8, months: ['Frostfall', 'Deepwinter', 'Thawmonth'] }
  const campaignDir = `${root}/campaigns/${name}`
  const charactersDir = `${campaignDir}/characters`
  mkdirSync(charactersDir, { recursive: true })
  writeFileSync(path.join(campaignDir, 'calendar.json'), JSON.stringify(cal), 'utf8')

  const fs = makeTempFs(root)
  for (const c of characters) {
    await writeCharacter(fs, charactersDir, c.name, {
      state: c.state,
      narrative: c.narrative ?? '',
      calendar: cal,
      campaign: name,
    })
  }

  return {
    root,
    campaign: name,
    campaignDir,
    charactersDir,
    calendar: cal,
    fs,
    dispose() {
      if (previousRoot === undefined) delete process.env.DND_ROOT
      else process.env.DND_ROOT = previousRoot
      try { rmSync(root, { recursive: true, force: true }) } catch { /* already gone */ }
    },
  }
}
