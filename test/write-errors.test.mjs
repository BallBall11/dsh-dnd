/**
 * write-errors.test.mjs — actionable refusals (T7) and the startup probe (T6).
 *
 * ## What these tests are for
 *
 * T7's criterion is that a refusal message contains the path, the root, and a
 * remedy — and that a test FAILS without them. T6's is that the probe WARNS when
 * writes are refused, stays SILENT when they are not, and never touches a real
 * character file.
 *
 * Both are about what a human is TOLD, so the assertions are deliberately on
 * CONTENT (does it name the root? does it say what to do?) rather than on exact
 * strings. An exact-string test would go red on every wording improvement and
 * teach the next person to update the expectation instead of reading it.
 *
 * ## Why the "no session" branch is the important one
 *
 * A refusal WITH a session policy means the campaign really is outside the
 * workspace — a legitimate policy answer. A refusal WITHOUT one means the write
 * was judged against the harness process's cwd, which is the original fatal
 * defect. These two must not produce the same message, and the test that they
 * differ is what keeps the diagnosis honest.
 *
 * Rules: test/support/live-data.mjs · docs/harness/TEST-DATA-OWNERSHIP.md
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  isSandboxDenial, refusedPathOf, describeWriteRefusal, withWriteDiagnosis, SANDBOX_DENIED,
} from '../src/host/tools/write-errors.mjs'
import { probeWrite, createProbeState, PROBE_OK, PROBE_REFUSED, PROBE_SKIPPED, PROBE_FILENAME } from '../src/host/tools/write-probe.mjs'

let failures = 0
async function test(name, fn) {
  let out
  try { out = await fn() } catch (error) {
    failures += 1
    console.error('  FAIL ' + name)
    console.error('       ' + (error && error.message ? error.message : error))
    return
  }
  if (out === false) { failures += 1; console.error('  FAIL ' + name) }
  else console.log('  ok  ' + name)
}
function section(title) { console.log('\n' + title) }

/** The platform's refusal, verbatim from the live failure. */
const denied = (p) => Object.assign(
  new Error('cannot write "' + p + '": file access denied under workspace-write mode'),
  { code: SANDBOX_DENIED },
)

// ─── detection ─────────────────────────────────────────────────────────────
section('a sandbox refusal is recognised, and other failures are not')

await test('recognises a refusal by its code', () => isSandboxDenial(denied('D:/x')) === true)
await test('recognises a refusal by its code ALONE (no message hint at all)', () => {
  // The code check must stand on its own. A test that always supplies the
  // textual hint too cannot tell whether the code path works: disabling it
  // would still pass on the message fallback.
  const bare = Object.assign(new Error('refused'), { code: SANDBOX_DENIED })
  return isSandboxDenial(bare) === true
})
await test('recognises a refusal by its message when the code is gone', () => {
  // Wrapping layers drop \`code\`; the live failure carried it only in the text.
  const e = new Error('cannot write "D:/x": file access denied under workspace-write mode')
  return isSandboxDenial(e) === true
})
await test('does NOT mistake an unrelated error for a refusal', () => {
  return isSandboxDenial(new Error('ENOENT: no such file or directory')) === false
    && isSandboxDenial(undefined) === false
    && isSandboxDenial(null) === false
})
await test('extracts the refused path from the platform wording', () => {
  return refusedPathOf(denied('D:\\DND\\campaigns\\x\\a.state.json')) === 'D:\\DND\\campaigns\\x\\a.state.json'
})
await test('returns null rather than inventing a path', () => {
  return refusedPathOf(new Error('file access denied under workspace-write mode')) === null
})

// ─── the message ───────────────────────────────────────────────────────────
section('the message names the path, the root and a remedy')

const NOSESSION = describeWriteRefusal(denied('D:/DND/campaigns/x/a.state.json'), {})
const WITHSESSION = describeWriteRefusal(denied('D:/DND/campaigns/x/a.state.json'), {
  policy: { workspaceRoot: 'D:/DND', mode: 'workspace-write', sessionId: 'sess-1' },
})

await test('names the refused path', () => NOSESSION.includes('D:/DND/campaigns/x/a.state.json'))
await test('names the allowed ROOT when a session policy was supplied', () => {
  return WITHSESSION.includes('D:/DND') && !WITHSESSION.includes('unknown')
})
await test('gives a REMEDY, not just the mode', () => {
  // The specific complaint in the bug report: the platform restates the mode.
  return /remedy|Remedies/i.test(NOSESSION) && /remedy|Remedies/i.test(WITHSESSION)
})
await test('EACH branch carries its OWN remedy, not the other branch\'s', () => {
  // Both branches must advise something, and each must advise the thing that is
  // actually true for it. Asserting only "the word remedy appears" lets one
  // branch lose its advice while the other keeps the test green.
  const sessionAdvice = /start the session with its cwd/i.test(WITHSESSION)
  const noSessionAdvice = /must be called by an agent/i.test(NOSESSION)
  // ...and neither branch may give the other's advice, which would be wrong.
  const crossed1 = /start the session with its cwd/i.test(NOSESSION)
  const crossed2 = /must be called by an agent/i.test(WITHSESSION)
  return sessionAdvice && noSessionAdvice && !crossed1 && !crossed2
})
await test('the session-policy branch reports the mode', () => WITHSESSION.includes('workspace-write'))

// This is the diagnosis that took a whole task board to find. The two branches
// MUST NOT read the same, or the message cannot tell them apart either.
await test('a write with NO session policy is diagnosed as the process-cwd defect', () => {
  return /NO session policy/.test(NOSESSION)
    && /process/i.test(NOSESSION)
    && /NOT a statement that the campaign is outside/.test(NOSESSION)
})
await test('the two branches produce DIFFERENT messages', () => NOSESSION !== WITHSESSION)
await test('the with-session branch does NOT claim the process-cwd defect', () => {
  return !/NO session policy/.test(WITHSESSION)
})

// ─── the wrapper ───────────────────────────────────────────────────────────
section('the wrapper translates refusals and leaves everything else alone')

await test('a refusal becomes the actionable message, with the original as cause', async () => {
  const original = denied('D:/x')
  const err = await withWriteDiagnosis(async () => { throw original }, {}).then(() => null, (e) => e)
  return err !== null && /remedy|Remedies/i.test(err.message) && err.cause === original
})
await test('an unrelated error passes through UNTOUCHED', async () => {
  // Disguising a real failure as a policy problem would be worse than the bug.
  const original = new Error('ENOSPC: no space left on device')
  const err = await withWriteDiagnosis(async () => { throw original }, {}).then(() => null, (e) => e)
  return err === original
})
await test('a successful write returns its value unchanged', async () => {
  return (await withWriteDiagnosis(async () => 'written', {})) === 'written'
})

// ─── the startup probe (T6) ────────────────────────────────────────────────
section('the startup write probe warns on refusal and is silent when healthy')

const tempRoot = mkdtempSync(path.join(tmpdir(), 'dnd-probe-'))
process.on('exit', () => { try { rmSync(tempRoot, { recursive: true, force: true }) } catch { /* gone */ } })
const CAMPAIGN = path.join(tempRoot, 'campaign').replace(/\\/g, '/')
mkdirSync(CAMPAIGN, { recursive: true })
const nodePath = (p) => String(p).replace(/\//g, path.sep)
const TEMP_PREFIX = String(tempRoot).replace(/\\/g, '/')

/**
 * The leak guard. This suite writes through mocks, so a path that escapes the
 * temp tree would be written to the REAL D:\DND by node's own fs.
 *
 * This is not hypothetical and not tidiness: an earlier version of this suite
 * passed the production path straight through, and the probe wrote a file into
 * the LIVE campaign (\`campaigns/retest-alice/.dnd-write-probe.tmp\`) before the
 * assertion caught it. The guard makes that impossible rather than unlikely —
 * the run now fails loudly at the boundary instead of quietly touching data.
 */
function guard(p, method) {
  const norm = String(p).replace(/\\/g, '/')
  if (!norm.startsWith(TEMP_PREFIX)) {
    throw new Error('LEAK: fs.' + method + '() resolved outside the temp tree: ' + norm)
  }
  return norm
}

/** An fs that behaves, backed by real disk in the temp tree. */
const goodFs = {
  async resolve(p) { return { displayPath: guard(p, 'resolve') } },
  async writeText(t, text) { writeFileSync(nodePath(guard(String(t.displayPath), 'writeText')), text, 'utf8') },
  async stat(t) { try { const s = statSync(nodePath(guard(String(t.displayPath), 'stat'))); return { type: 'file', size: s.size, mtime: s.mtimeMs } } catch { return undefined } },
  async readText(t) { return readFileSync(nodePath(guard(String(t.displayPath), 'readText')), 'utf8') },
}

/** An fs whose writes are ALWAYS refused, as the platform refuses them. */
const deniedFs = {
  async resolve(p) { return { displayPath: guard(p, 'resolve') } },
  async writeText(t) { throw denied(guard(String(t.displayPath), 'writeText')) },
}

section('the leak guard keeps this suite off live data')
await test('the leak guard REJECTS a path outside the temp tree', () => {
  // Without this, a future edit that passes a production path to a mock would
  // silently write into the live campaign — which is exactly what happened once.
  //
  // The guard is a pure path predicate, so the OUTSIDE path here is a neutral
  // one rather than a live-data literal. Keeping live-data strings out of this
  // file is deliberate: an allowlist exemption in
  // scripts/audit-test-ownership.mjs would be a claim that this suite reads live
  // data, and the whole point of the guard is that it cannot.
  let threw = null
  try { guard('/somewhere/else/x.json', 'writeText') } catch (e) { threw = e }
  return threw !== null && /LEAK/.test(threw.message)
})
await test('the leak guard ALLOWS a path inside the temp tree', () => {
  return guard(CAMPAIGN + '/inside.json', 'writeText').startsWith(TEMP_PREFIX)
})

await test('a healthy write path probes OK and writes the probe file', async () => {
  const r = await probeWrite(goodFs, CAMPAIGN)
  return r.status === PROBE_OK && existsSync(nodePath(CAMPAIGN + '/' + PROBE_FILENAME))
})
await test('the probe file is NOT a character file in any way', () => {
  // The criterion is explicit: the probe must not touch alice.state.json etc.
  const names = readdirSync(nodePath(CAMPAIGN))
  return names.every((n) => n === PROBE_FILENAME) && PROBE_FILENAME.startsWith('.dnd-write-probe')
})
await test('probing repeatedly converges on ONE file (this bundle cannot delete)', async () => {
  await probeWrite(goodFs, CAMPAIGN)
  await probeWrite(goodFs, CAMPAIGN)
  const names = readdirSync(nodePath(CAMPAIGN))
  return names.length === 1
})
await test('a REFUSED write path reports refused, and explains why', async () => {
  const r = await probeWrite(deniedFs, CAMPAIGN)
  return r.status === PROBE_REFUSED && /remedy|Remedies/i.test(r.message)
})
await test('a non-sandbox failure is SKIPPED, not blamed on the sandbox', async () => {
  const brokenFs = { async resolve(p) { return { displayPath: String(p) } }, async writeText() { throw new Error('ENOSPC') } }
  const r = await probeWrite(brokenFs, CAMPAIGN)
  return r.status === PROBE_SKIPPED
})
await test('no fs service or no campaign directory is skipped, never thrown', async () => {
  return (await probeWrite(undefined, CAMPAIGN)).status === PROBE_SKIPPED
    && (await probeWrite(goodFs, '')).status === PROBE_SKIPPED
})

// ─── the advisory note ─────────────────────────────────────────────────────
section('the advisory note appears only when the probe found a broken path')

await test('no probe run yet -> NO note (absence of evidence, not good news)', () => {
  return createProbeState().note() === undefined
})
await test('a healthy probe -> NO note (no noise on a working session)', async () => {
  const s = createProbeState()
  s.set(await probeWrite(goodFs, CAMPAIGN))
  return s.note() === undefined
})
await test('a refused probe -> a note that says writes may not be saved', async () => {
  const s = createProbeState()
  s.set(await probeWrite(deniedFs, CAMPAIGN))
  const note = s.note()
  return typeof note === 'string' && /WARNING/.test(note) && /not be saved/i.test(note)
})
await test('the note warns about SILENT loss, which is the actual failure mode', async () => {
  const s = createProbeState()
  s.set(await probeWrite(deniedFs, CAMPAIGN))
  return /reads and dice work/i.test(s.note())
})
await test('clear() removes the note', async () => {
  const s = createProbeState()
  s.set(await probeWrite(deniedFs, CAMPAIGN))
  s.clear()
  return s.note() === undefined
})

// ─── the session-aware self-check ──────────────────────────────────────────
section('the self-check runs once, on a real write, with the CALLER\'S policy')

const { runWriteSelfCheck, setWriteProbeState, writeProbeState } = await import('../src/host/tools/write-probe.mjs')

await test('it probes with the policy supplied, not with no policy', async () => {
  // The load-bearing property. A mount-time probe has no session and would test
  // the process-cwd fallback, which no real write uses.
  setWriteProbeState(createProbeState())
  const seen = []
  const recordingFs = {
    async resolve(p) { return { displayPath: guard(p, 'resolve') } },
    async writeText(t, text, a, b, policy) {
      seen.push(policy)
      writeFileSync(nodePath(guard(String(t.displayPath), 'writeText')), String(text), 'utf8')
    },
  }
  const POLICY = { workspaceRoot: 'D:/DND', mode: 'workspace-write', sessionId: 's1' }
  const r = await runWriteSelfCheck({ get: () => undefined }, { fs: recordingFs, policy: POLICY, campaignDir: CAMPAIGN })
  return r.status === PROBE_OK && seen.length === 1 && seen[0] === POLICY
})

await test('it runs AT MOST ONCE per mount', async () => {
  setWriteProbeState(createProbeState())
  let calls = 0
  const countingFs = {
    async resolve(p) { return { displayPath: guard(p, 'resolve') } },
    async writeText(t, text) { calls += 1; writeFileSync(nodePath(guard(String(t.displayPath), 'writeText')), String(text), 'utf8') },
  }
  const ctx = { get: () => undefined }
  await runWriteSelfCheck(ctx, { fs: countingFs, campaignDir: CAMPAIGN })
  await runWriteSelfCheck(ctx, { fs: countingFs, campaignDir: CAMPAIGN })
  await runWriteSelfCheck(ctx, { fs: countingFs, campaignDir: CAMPAIGN })
  return calls === 1
})

await test('a refused self-check publishes a note the write tools can show', async () => {
  setWriteProbeState(createProbeState())
  await runWriteSelfCheck({ get: () => undefined }, { fs: deniedFs, campaignDir: CAMPAIGN })
  const note = writeProbeState().note()
  return typeof note === 'string' && /WARNING/.test(note)
})

await test('a healthy self-check leaves NO note', async () => {
  setWriteProbeState(createProbeState())
  await runWriteSelfCheck({ get: () => undefined }, { fs: goodFs, campaignDir: CAMPAIGN })
  return writeProbeState().note() === undefined
})

await test('no campaign and no fs are SKIPPED, never thrown', async () => {
  setWriteProbeState(createProbeState())
  const a = await runWriteSelfCheck({ get: () => undefined }, { fs: goodFs, campaignDir: '' })
  setWriteProbeState(createProbeState())
  const b = await runWriteSelfCheck({ get: () => undefined }, {})
  assert.equal(a.status, PROBE_SKIPPED, 'no campaignDir should skip, got ' + JSON.stringify(a))
  assert.equal(b.status, PROBE_SKIPPED, 'no fs should skip, got ' + JSON.stringify(b))
  return true
})

console.log('')
if (failures > 0) {
  console.error('write-errors.test.mjs: ' + failures + ' failure(s)')
  process.exit(1)
}
console.log('write-errors.test.mjs: all assertions passed')
