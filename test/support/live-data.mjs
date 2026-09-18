/**
 * test/support/live-data.mjs — the ownership rules, made mechanical.
 *
 * A suite may touch two very different kinds of input, and confusing them is
 * how this project lost five suites at once:
 *
 *   PARSER TEST      "does the code read this format correctly?"
 *                    -> MUST own its input. Read a frozen fixture under
 *                       test/fixtures/. Never a campaign file.
 *
 *   INVARIANT TEST   "does the code keep a promise, whatever the data is?"
 *                    -> MAY read live data, because the promise must hold for
 *                       every possible shape. It must assert a PROPERTY
 *                       (bytes unchanged / shape holds), never a snapshot of
 *                       one campaign's current contents.
 *
 * The five suites that went red were parser-shaped tests pointed at a live
 * file. The plugin then migrated that character — a legal change — and the
 * tests failed while the code was perfect. The input had changed shape.
 *
 * See docs/harness/TEST-DATA-OWNERSHIP.md for the full rationale, and
 * `npm run test:ownership` for the audit that enforces it.
 *
 * Nothing here writes to live data. `hashLivePath` and `liveBytes` are
 * read-only by construction.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

/** Normalize a `/`-separated path to the platform separator. */
export const nodePath = (p) => String(p).replace(/\//g, path.sep)

/** The data root the plugin itself uses. Campaigns are read-only in tests. */
export const LIVE_ROOT = 'D:/DND'

/** Read a file's bytes, or null when it does not exist. Never throws. */
export function liveBytes(p) {
  try {
    return readFileSync(nodePath(p))
  } catch {
    return null
  }
}

/**
 * sha256 of a live path, or null when it is absent.
 *
 * Prefer this over comparing file *contents*: a hash says "these bytes did not
 * move" without the test ever holding a copy of campaign data, so it cannot
 * accidentally grow an assertion about what that data says.
 */
export function hashLivePath(p) {
  const bytes = liveBytes(p)
  return bytes === null ? null : createHash('sha256').update(bytes).digest('hex')
}

/** Whether a live path exists. */
export function liveExists(p) {
  return existsSync(nodePath(p))
}

/**
 * A read-only snapshot of ONE live directory tree: relative path -> sha256.
 *
 * This is the invariant-tester's tool. It answers "did anything under here
 * change?" for whatever the directory happens to contain, so adding,
 * migrating, or renaming a character is invisible to it. That is the whole
 * point: the snapshot records that THIS RUN wrote nothing, not that the
 * campaign looks a particular way.
 *
 * Directories are included by their listing, so creating or deleting a
 * subdirectory also registers as a change.
 *
 * @param dir - absolute directory to snapshot.
 * @returns a Map of relative path -> sha256 ('' when unreadable).
 */
export function snapshotTree(dir) {
  const out = new Map()
  const base = nodePath(dir)
  if (!existsSync(base)) return out

  const walk = (abs, rel) => {
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      const childAbs = path.join(abs, entry.name)
      if (entry.isDirectory()) {
        out.set(childRel + '/', 'directory')
        walk(childAbs, childRel)
        continue
      }
      try {
        out.set(childRel, createHash('sha256').update(readFileSync(childAbs)).digest('hex'))
      } catch {
        out.set(childRel, '')
      }
    }
  }

  walk(base, '')
  return out
}

/**
 * Assert that a tree snapshot did not move, and report exactly what did.
 *
 * A bare `assert.deepEqual` on two Maps prints the whole tree, which buries
 * the one path that changed. This names the change.
 *
 * @param before - snapshot taken before the action.
 * @param after - snapshot taken after.
 * @returns array of human-readable differences (empty when clean).
 */
export function diffTree(before, after) {
  const changes = []
  for (const [rel, hash] of before) {
    if (!after.has(rel)) changes.push(`deleted: ${rel}`)
    else if (after.get(rel) !== hash) changes.push(`modified: ${rel}`)
  }
  for (const rel of after.keys()) {
    if (!before.has(rel)) changes.push(`created: ${rel}`)
  }
  return changes.sort()
}

/**
 * A live path plus its hash, for the "did this run touch it?" pattern.
 *
 * Returns an object with `assertUnchanged()`, so an invariant test reads as
 * one sentence and cannot forget half the comparison.
 *
 * @param p - live path.
 * @param label - name to use in failure messages.
 */
export function liveWitness(p, label = p) {
  const before = hashLivePath(p)
  return {
    path: p,
    label,
    existedBefore: before !== null,
    hash: before,
    /** Throw when the file appeared, vanished, or changed bytes. */
    assertUnchanged() {
      const after = hashLivePath(p)
      if (before === null) {
        if (after !== null) {
          throw new Error(`${label} did not exist before this run and does now — a read-only path was written`)
        }
        return
      }
      if (after === null) {
        throw new Error(`${label} existed before this run and is gone now — a read-only path was deleted`)
      }
      if (after !== before) {
        throw new Error(`${label} changed: ${before.slice(0, 12)}… -> ${after.slice(0, 12)}…`)
      }
    },
  }
}

/**
 * The live campaign every invariant test uses, expressed as observable facts
 * rather than expectations.
 *
 * `characters/` is the directory the plugin itself rewrites when a character
 * is migrated or a number changes, so it is the honest witness for "this run
 * wrote nothing". Tests must NOT assert what is in it.
 */
export const LIVE_CAMPAIGN = `${LIVE_ROOT}/campaigns/morgansfort`

/** The live active-campaign marker, a favourite target of accidental writes. */
export const LIVE_MARKER = `${LIVE_ROOT}/.runtime/active-campaign.json`

/** Byte-for-byte equality helper that tolerates absence on both sides. */
export function sameBytes(a, b) {
  if (a === null || b === null) return a === b
  return a.equals(b)
}

/** A frozen fixture path, resolved against the calling module. */
export function fixtureUrl(name, importMetaUrl) {
  return new URL(`../fixtures/${name}`, importMetaUrl).pathname
    .replace(/^\/([A-Za-z]:)/, '$1') // Windows: strip the leading slash from /D:/...
}

/** True when a path is a regular file. */
export function isFile(p) {
  try {
    return statSync(nodePath(p)).isFile()
  } catch {
    return false
  }
}
