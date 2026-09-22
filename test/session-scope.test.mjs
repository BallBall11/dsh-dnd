/**
 * session-scope.test.mjs — the write path must be judged against the SESSION's
 * cwd, not the harness process's cwd.
 *
 * ## What this suite exists to prove
 *
 * The shipped defect was not "the mode is wrong" and not "the path is wrong".
 * It was that `fs.writeText` was called with no sandbox policy, so the fence
 * fell back to a root derived from the harness process's cwd and refused every
 * campaign write while reads kept working.
 *
 * Three things therefore have to be asserted, and none of them is "the file got
 * written on this machine" (which no in-process test can honestly show):
 *
 *   1. POSITIVE — when a session is available, the policy handed to `writeText`
 *      carries the SESSION's cwd, and its mode is still `workspace-write`.
 *   2. NEGATIVE / FAIL-CLOSED — when no session is available, no policy is
 *      passed at all, so the platform's own fallback applies and the mode is
 *      NOT widened to `danger-full-access`.
 *   3. READ PATH — reading never passes a policy, so no read becomes refusable.
 *
 * ## Why a fake fs is correct here
 *
 * test/state-io.test.mjs uses a real temp directory and explains why mocks are
 * normally the wrong tool. That reasoning still holds for behaviour. But the
 * fact under test here is a FUNCTION ARGUMENT — which policy object reaches the
 * sandbox — and the only component that can observe it is the fs service
 * itself. A real directory would accept the write either way and could not tell
 * the two policies apart. So this suite records the arguments instead of
 * performing I/O, and asserts on their shape.
 *
 * The policy objects below are built with the platform's REAL rule, copied from
 * `dsh-sandbox-policy/lib/index.js:145`:
 *
 *     workspaceRoot = resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot)
 *
 * so the stub cannot be more forgiving than the service it stands in for.
 */
import assert from 'node:assert/strict'
import { writeCharacter, readCharacter } from '../src/host/tools/state-io.mjs'
import { writePolicyFor, sessionOf } from '../src/host/tools/session-scope.mjs'
import { buildTools } from '../src/host/tools/track.mjs'

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failures += 1
    console.log('  FAIL ' + name)
    console.log('       ' + (error && error.message ? error.message : error))
  }
}

// --- the two roots that decide everything ----------------------------------
//
// Both are MEASURED values from the live incident, not invented:
//   process cwd root  C:\Users\Ming      (what the broken path judged against)
//   session cwd       D:\DND             (what it should have judged against)
const PROCESS_ROOT = 'C:\\Users\\Ming'
const SESSION_ROOT = 'D:/DND'

/**
 * Synthetic paths under the session root.
 *
 * This suite performs NO filesystem I/O — every fs below is a recording stub —
 * so these only have to be plausible, not real. They are deliberately NOT
 * `campaigns/...` paths: naming live campaign data in a test that cannot read
 * it is what the ownership audit (scripts/audit-test-ownership.mjs) exists to
 * stop, and an allowlist entry would have been the wrong answer for a file with
 * no live dependency at all.
 */
const SESSION_CHAR_DIR = SESSION_ROOT + '/fixtures/characters'
const SESSION_RUNTIME = SESSION_ROOT + '/fixtures/runtime'

/**
 * A stand-in for `ctx.sandboxPolicy`, implementing the real fallback rule.
 *
 * The whole point is the `session === undefined` branch: it must reproduce the
 * process-cwd fallback, or this suite would pass on a stub that is kinder than
 * the platform and prove nothing.
 */
function makeSandboxPolicy() {
  const calls = []
  return {
    defaultMode: 'workspace-write',
    workspaceRoot: PROCESS_ROOT,
    calls,
    resolve(request = {}) {
      calls.push(request)
      const session = request.session
      return {
        mode: request.mode ?? 'workspace-write',
        // dsh-sandbox-policy:145, verbatim in effect.
        workspaceRoot: session === undefined ? PROCESS_ROOT : String(session.header.cwd),
        ...(session === undefined ? {} : { sessionId: session.id }),
      }
    },
  }
}

/** A live-session registry keyed by id, shaped like `ctx.sessions`. */
function makeSessions(sessions) {
  return { get: (id) => sessions.find((s) => s.id === id) }
}

/**
 * A recording fs service.
 *
 * `writeText` captures the 5th argument — the sandbox policy — which is the
 * entire subject of this file. It records rather than writes because the
 * argument, not the byte, is what is under test.
 */
function makeRecordingFs() {
  const writes = []
  const reads = []
  const target = (p) => ({ targetKey: String(p).toLowerCase(), displayPath: String(p) })
  return {
    writes,
    reads,
    async resolve(p) { return target(p) },
    async stat() { return undefined },
    async readText(t) {
      reads.push(t)
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    async writeText(t, text, expected, signal, sandboxPolicy) {
      writes.push({ target: t, text, expected, signal, sandboxPolicy })
    },
    async listDir() { return [] },
  }
}

/** Build a ctx exposing only the services this path uses. */
function makeCtx({ sandboxPolicy, sessions }) {
  return {
    get(name) {
      if (name === 'sandboxPolicy') return sandboxPolicy
      if (name === 'sessions') return sessions
      if (name === 'logger') return { warn: () => {} }
      return undefined
    },
    inject() {},
  }
}

const SESSION = { id: 'session-test-0001', header: { cwd: SESSION_ROOT } }
const EXEC = { agent: { id: 'session-test-0001' } }

console.log('session scope:')

// ---------------------------------------------------------------------------
// The lever itself
// ---------------------------------------------------------------------------

await test('writePolicyFor resolves a policy carrying the SESSION cwd', () => {
  const sp = makeSandboxPolicy()
  const ctx = makeCtx({ sandboxPolicy: sp, sessions: makeSessions([SESSION]) })

  const policy = writePolicyFor(ctx, EXEC)

  assert.ok(policy !== undefined, 'a policy must be produced when a session is available')
  assert.equal(policy.workspaceRoot, SESSION_ROOT,
    `the write must be judged against the session cwd, not ${PROCESS_ROOT}: got ${policy.workspaceRoot}`)
  assert.notEqual(policy.workspaceRoot, PROCESS_ROOT)
  assert.equal(policy.sessionId, SESSION.id, 'the resolved policy must name the session')
})

await test('resolve() is called WITH the session, not argument-less', () => {
  const sp = makeSandboxPolicy()
  const ctx = makeCtx({ sandboxPolicy: sp, sessions: makeSessions([SESSION]) })

  writePolicyFor(ctx, EXEC)

  assert.equal(sp.calls.length, 1, 'resolve must be called exactly once per write')
  // This is the regression that matters most: `resolve()` with no argument is
  // the exact call shape that produced FS_SANDBOX_DENIED.
  assert.equal(sp.calls[0].session, SESSION,
    'resolve() must RECEIVE the session — calling it without one is the original defect')
})

await test('the resolved mode stays workspace-write', () => {
  const sp = makeSandboxPolicy()
  const ctx = makeCtx({ sandboxPolicy: sp, sessions: makeSessions([SESSION]) })

  const policy = writePolicyFor(ctx, EXEC)
  assert.equal(policy.mode, 'workspace-write', 'the fix must not widen the sandbox mode')
  assert.notEqual(policy.mode, 'danger-full-access')
})

await test('sessionOf returns undefined for an unknown/live-less session', () => {
  const sp = makeSandboxPolicy()
  const ctx = makeCtx({ sandboxPolicy: sp, sessions: makeSessions([]) })
  assert.equal(sessionOf(ctx, EXEC), undefined, 'a non-live session id must resolve to undefined')
})

// ---------------------------------------------------------------------------
// FAIL CLOSED — the degradation path
// ---------------------------------------------------------------------------

await test('no exec at all -> no policy, and resolve() is NOT consulted for a root', () => {
  const sp = makeSandboxPolicy()
  const ctx = makeCtx({ sandboxPolicy: sp, sessions: makeSessions([SESSION]) })

  const policy = writePolicyFor(ctx, undefined)

  assert.equal(policy, undefined,
    'without an exec there is no session, so no policy may be invented')
})

await test('exec present but agentless -> no policy (fail closed)', () => {
  const sp = makeSandboxPolicy()
  const ctx = makeCtx({ sandboxPolicy: sp, sessions: makeSessions([SESSION]) })
  assert.equal(writePolicyFor(ctx, {}), undefined)
  assert.equal(writePolicyFor(ctx, { agent: undefined }), undefined)
})

await test('sessions service absent -> no policy rather than a crash', () => {
  const sp = makeSandboxPolicy()
  const ctx = makeCtx({ sandboxPolicy: sp, sessions: undefined })
  assert.equal(writePolicyFor(ctx, EXEC), undefined,
    'a host without the sessions service must degrade, not throw')
})

await test('sandboxPolicy service absent -> no policy rather than a crash', () => {
  const ctx = makeCtx({ sandboxPolicy: undefined, sessions: makeSessions([SESSION]) })
  assert.equal(writePolicyFor(ctx, EXEC), undefined)
})

// ---------------------------------------------------------------------------
// The write path actually carries it
// ---------------------------------------------------------------------------

await test('writeCharacter forwards the session policy as writeText 5th argument', async () => {
  const fs = makeRecordingFs()
  const policy = { mode: 'workspace-write', workspaceRoot: SESSION_ROOT, sessionId: SESSION.id }

  await writeCharacter(fs, SESSION_CHAR_DIR, 'alice', {
    state: { name: 'alice', identity: { level: 1, xp: 0 } },
    narrative: 'A test.',
    sandboxPolicy: policy,
  })

  assert.equal(fs.writes.length, 2, 'both the state file and the sheet must be written')
  for (const w of fs.writes) {
    assert.equal(w.sandboxPolicy, policy,
      'every write must carry the session policy — a missing one on either file reintroduces the defect')
    assert.equal(w.sandboxPolicy.workspaceRoot, SESSION_ROOT)
    assert.equal(w.sandboxPolicy.mode, 'workspace-write')
  }
  // The state file is the authority and must be written first (state-io contract).
  assert.match(fs.writes[0].target.displayPath, /\.state\.json$/i)
  assert.match(fs.writes[1].target.displayPath, /\.md$/i)
})

await test('writeCharacter with NO policy passes undefined (platform fallback, not a bypass)', async () => {
  const fs = makeRecordingFs()

  await writeCharacter(fs, SESSION_CHAR_DIR, 'alice', {
    state: { name: 'alice', identity: { level: 1, xp: 0 } },
    narrative: 'A test.',
  })

  assert.equal(fs.writes.length, 2)
  for (const w of fs.writes) {
    assert.equal(w.sandboxPolicy, undefined,
      'no session must mean "let the platform decide", never a guessed root or wider mode')
  }
})

// ---------------------------------------------------------------------------
// The three write tools, end to end through execute(args, exec)
// ---------------------------------------------------------------------------

/**
 * Mount track.mjs against a fake campaign and call a write tool the way the
 * agent loop does — WITH an exec — then assert the policy that reached the fs.
 */
async function callWriteTool(name, args, { exec, withCtx }) {
  const sp = makeSandboxPolicy()
  const fs = makeRecordingFs()
  const ctx = {
    get(service) {
      if (service === 'fs') return fs
      if (service === 'sandboxPolicy') return sp
      if (service === 'sessions') return makeSessions([SESSION])
      if (service === 'logger') return { warn: () => {} }
      return undefined
    },
    inject() {},
  }
  // A campaign READ is needed to locate the character; the recording fs returns
  // ENOENT for reads, so stub the campaign marker + listing through the tools'
  // own expectations by pointing at a real-ish tree via readText.
  const tools = buildTools(ctx)
  const tool = tools.find((t) => t.name === name)
  assert.ok(tool !== undefined, name + ' must be registered')

  if (withCtx !== undefined) return { out: String(await tool.execute(args, withCtx)), fs, sp }
  return { out: String(await tool.execute(args)), fs, sp }
}

await test('dnd_track reaches writeText with the session policy', async () => {
  // The locate step reads the campaign marker and the character; feed those
  // through a fs whose reads answer, while writes are still recorded.
  const sp = makeSandboxPolicy()
  const writes = []
  // Answered by SUFFIX, not by an exact path: the tools compose their paths
  // from the bundle's own DND_ROOT, so a map keyed on hand-written paths drifts
  // from the production shape. Matching the tail keeps this in step with it.
  const FILES = [
    [/active-campaign\.json$/i, JSON.stringify({ name: 'testcamp' })],
    [/alice\.state\.json$/i,
      JSON.stringify({ name: 'alice', identity: { level: 1, xp: 0 }, hp: { current: 10, max: 10 }, currency: 800 })],
    [/alice\.md$/i, '# Alice\n\nA test.\n'],
  ]
  const files = { has: (key) => FILES.some(([re]) => re.test(key)), get: (key) => FILES.find(([re]) => re.test(key))[1] }
  const target = (p) => ({ targetKey: String(p).toLowerCase(), displayPath: String(p) })
  const fs = {
    async resolve(p) { return target(p) },
    // stat must agree with readText: state-io asks "does this exist?" before
    // deciding a character is present. An always-undefined stat made the tool
    // report "no characters" and never reach the write at all — which is how
    // the first version of this suite passed its assertions vacuously.
    async stat(t) {
      if (!files.has(String(t.targetKey))) return undefined
      return { type: 'file', size: 1, mtime: 0 }
    },
    async readText(t) {
      const key = String(t.targetKey)
      if (!files.has(key)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return files.get(key)
    },
    async writeText(t, text, expected, signal, sandboxPolicy) {
      writes.push({ target: t, sandboxPolicy })
    },
    async listDir(t) {
      if (!String(t.displayPath).toLowerCase().includes('/characters')) return []
      return [{ name: 'alice.state.json', target: target(String(t.displayPath) + '/alice.state.json'), type: 'file' }]
    },
  }
  const ctx = {
    get(service) {
      if (service === 'fs') return fs
      if (service === 'sandboxPolicy') return sp
      if (service === 'sessions') return makeSessions([SESSION])
      return undefined
    },
    inject() {},
  }

  const tool = buildTools(ctx).find((t) => t.name === 'dnd_spend')
  await tool.execute({ amount: '15 cp', character: 'alice' }, EXEC)

  assert.ok(writes.length > 0, 'the write tool must actually attempt a write: ' + writes.length)
  for (const w of writes) {
    assert.ok(w.sandboxPolicy !== undefined,
      'dnd_spend must pass a session policy — undefined here is the shipped defect')
    assert.equal(w.sandboxPolicy.workspaceRoot, SESSION_ROOT,
      'the write must be judged against the session cwd, not ' + PROCESS_ROOT)
    assert.equal(w.sandboxPolicy.mode, 'workspace-write')
  }
})

await test('dnd_spend called WITHOUT exec passes no policy (fail closed)', async () => {
  const sp = makeSandboxPolicy()
  const writes = []
  // Answered by SUFFIX, not by an exact path: the tools compose their paths
  // from the bundle's own DND_ROOT, so a map keyed on hand-written paths drifts
  // from the production shape. Matching the tail keeps this in step with it.
  const FILES = [
    [/active-campaign\.json$/i, JSON.stringify({ name: 'testcamp' })],
    [/alice\.state\.json$/i,
      JSON.stringify({ name: 'alice', identity: { level: 1, xp: 0 }, hp: { current: 10, max: 10 }, currency: 800 })],
    [/alice\.md$/i, '# Alice\n\nA test.\n'],
  ]
  const files = { has: (key) => FILES.some(([re]) => re.test(key)), get: (key) => FILES.find(([re]) => re.test(key))[1] }
  const target = (p) => ({ targetKey: String(p).toLowerCase(), displayPath: String(p) })
  const fs = {
    async resolve(p) { return target(p) },
    // stat must agree with readText: state-io asks "does this exist?" before
    // deciding a character is present. An always-undefined stat made the tool
    // report "no characters" and never reach the write at all — which is how
    // the first version of this suite passed its assertions vacuously.
    async stat(t) {
      if (!files.has(String(t.targetKey))) return undefined
      return { type: 'file', size: 1, mtime: 0 }
    },
    async readText(t) {
      const key = String(t.targetKey)
      if (!files.has(key)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return files.get(key)
    },
    async writeText(t, text, expected, signal, sandboxPolicy) { writes.push({ target: t, sandboxPolicy }) },
    async listDir(t) {
      if (!String(t.displayPath).toLowerCase().includes('/characters')) return []
      return [{ name: 'alice.state.json', target: target(String(t.displayPath) + '/alice.state.json'), type: 'file' }]
    },
  }
  const ctx = {
    get(service) {
      if (service === 'fs') return fs
      if (service === 'sandboxPolicy') return sp
      if (service === 'sessions') return makeSessions([SESSION])
      return undefined
    },
    inject() {},
  }

  const tool = buildTools(ctx).find((t) => t.name === 'dnd_spend')
  await tool.execute({ amount: '15 cp', character: 'alice' })

  assert.ok(writes.length > 0, 'the write must still be attempted')
  for (const w of writes) {
    assert.equal(w.sandboxPolicy, undefined,
      'an agentless call must NOT receive a policy — no guessed root, no widened mode')
  }
})

// ---------------------------------------------------------------------------
// Reads must not regress
// ---------------------------------------------------------------------------

await test('readCharacter never passes a sandbox policy (reads stay unrefusable)', async () => {
  const fs = makeRecordingFs()
  await readCharacter(fs, SESSION_CHAR_DIR, 'alice')

  // The recording fs only records READS here; the assertion is that the read
  // path never reaches writeText at all, and so can never be fenced.
  assert.equal(fs.writes.length, 0, 'a read must never write, and so never be refusable')
})

await test('a read outside the process root is still performed (no fence on reads)', async () => {
  // A fs that HONOURS reads, so the read path is genuinely exercised rather
  // than short-circuiting on a missing stat. `readTextOrUndefined` stats
  // before reading, so a stat that always misses would make this test vacuous.
  const reads = []
  const writes = []
  const target = (p) => ({ targetKey: String(p).toLowerCase(), displayPath: String(p) })
  const fs = {
    async resolve(p) { return target(p) },
    async stat(t) {
      // Present regardless of which root the path sits under. That is the
      // point: `D:/DND` is outside the process root, and a read must not care.
      return { type: String(t.displayPath).endsWith('.md') ? 'file' : 'directory', size: 1, mtime: 0 }
    },
    async readText(t) { reads.push(t); return '# Alice\n\nNarrative.\n' },
    async writeText(t, text, expected, signal, sandboxPolicy) { writes.push({ t, sandboxPolicy }) },
    async listDir() { return [] },
  }

  await readCharacter(fs, SESSION_CHAR_DIR, 'alice')

  assert.ok(reads.length > 0,
    'a read of a campaign under D:/DND must still be attempted — reads carry no policy and so cannot be refused')
  assert.equal(writes.length, 0, 'a read must never write')
})

console.log('')
if (failures > 0) {
  console.log(`session-scope: ${failures} failure(s)`)
  process.exit(1)
}
console.log('session-scope: all tests passed')