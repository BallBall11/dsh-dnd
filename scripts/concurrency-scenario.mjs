/**
 * tests CONCURRENCY in the write tools.
 *
 * `write-tools-scenario.mjs` covers a repeated request (same `key` twice) and
 * checks the result of AWAITING each call in turn. That is idempotency, and it
 * says nothing about two calls that overlap: awaiting the first to completion
 * before starting the second cannot produce a race, so a suite built that way
 * passes against a completely unserialized implementation.
 *
 * This file starts both calls and only then awaits them, which is the shape that
 * actually happens when the model emits two tool calls in one step, or when the
 * panel and a tool write at once.
 *
 * ## What the bug looked like
 *
 * Every write is read-modify-write, and the read happened in `locateCharacter`,
 * BEFORE the mutating half. Two overlapping calls therefore both read HP 8, both
 * computed 8-3=5, and both wrote 5 — one of the two hits vanished while both
 * calls reported success. Measured before the fix:
 *
 *     start hp = 8  ->  final hp = 5   (two hits should give 2)
 *     start purse = 785 -> final 770   (two 15 cp spends should give 755)
 *
 * Keyed idempotency cannot close this. The two calls below carry no key at all,
 * because "take 5 damage" twice is legitimately 10 damage; the point is that the
 * arithmetic must compose even when the calls overlap.
 *
 * ## Why the fs wrapper yields
 *
 * `node:fs` here is synchronous, so two "concurrent" calls would run to
 * completion one after another and the race would hide. Real async I/O yields
 * between the read and the write. The wrapper below yields on every operation,
 * which reproduces the interleaving deterministically instead of hoping for it —
 * measured, not assumed. Without the fix these assertions fail; with it they
 * pass.
 *
 * ## Safety
 *
 * The scenario is SELF-CONTAINED: it builds a throwaway workspace in the OS
 * temp dir, points the explicit `DND_ROOT` env at it for the duration, and
 * scaffolds the campaign inside it — no live campaign is read, repointed, or
 * hashed, because there is no live campaign in the picture at all. Every fs
 * method guards its paths against escaping the temp tree, so a leak fails
 * loudly instead of touching a real campaign.
 */
import { readFileSync, writeFileSync, statSync, readdirSync, existsSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { buildTools } from '../src/host/tools/track.mjs'
import { writeCharacter } from '../src/host/tools/state-io.mjs'

const nodePath = (p) => String(p).replace(/\//g, path.sep)
const target = (p) => ({ targetKey: String(p).toLowerCase(), displayPath: String(p).replace(/\\/g, '/') })

// ─── the throwaway workspace ─────────────────────────────────────────────────
const savedRoot = process.env.DND_ROOT
const tempRoot = mkdtempSync(path.join(tmpdir(), 'dnd-concurrency-')).replace(/\\/g, '/')
process.env.DND_ROOT = tempRoot
process.on('exit', () => {
  try { rmSync(tempRoot, { recursive: true, force: true }) } catch { /* gone */ }
})

/** Every fs path must stay inside the temp tree; a leak is a hard failure. */
function guard(p, method) {
  const norm = String(p).replace(/\\/g, '/')
  if (!norm.startsWith(tempRoot)) {
    throw new Error('LEAK: fs.' + method + '() outside the temp workspace: ' + norm)
  }
  return norm
}

/**
 * The underlying synchronous fs.
 *
 * `node:fs` is used directly rather than through a mock because the tools are
 * being exercised end to end: the bytes these functions write are the bytes the
 * assertions hash.
 */
const rawFs = {
  async resolve(p) { return target(guard(p, 'resolve')) },
  async stat(t) {
    try {
      const s = statSync(nodePath(guard(t.displayPath, 'stat')))
      return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs }
    } catch { return undefined }
  },
  async readText(t) { return readFileSync(nodePath(guard(t.displayPath, 'readText')), 'utf8') },
  async writeText(t, text) { writeFileSync(nodePath(guard(t.displayPath, 'writeText')), text, 'utf8') },
  async listDir(t) {
    const base = String(guard(t.displayPath, 'listDir')).replace(/\/$/, '')
    return readdirSync(nodePath(base), { withFileTypes: true }).map((e) => ({
      name: e.name, target: target(`${base}/${e.name}`),
      type: e.isDirectory() ? 'directory' : 'file',
    }))
  },
}

/** Yield to the event loop, as genuine async I/O would. */
const yieldTick = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Count how many fs operations each call makes, so the test can prove the
 * interleaving really occurred rather than passing because the calls happened to
 * be serialized by the test harness itself.
 */
const fsTouched = []
const fs = {
  async resolve(p) { fsTouched.push('resolve'); await yieldTick(); return rawFs.resolve(p) },
  async stat(t) { fsTouched.push('stat'); await yieldTick(); return rawFs.stat(t) },
  async readText(t) { fsTouched.push('read'); await yieldTick(); return rawFs.readText(t) },
  async writeText(t, text) { fsTouched.push('write'); await yieldTick(); return rawFs.writeText(t, text) },
  async listDir(t) { fsTouched.push('list'); await yieldTick(); return rawFs.listDir(t) },
}

const ROOT = tempRoot
const MARKER = `${ROOT}/.runtime/active-campaign.json`
const CAMPAIGN = `${ROOT}/campaigns/stage2-test`
const CHAR_DIR = `${CAMPAIGN}/characters`
const STATE = `${CHAR_DIR}/alice.state.json`
const SHEET = `${CHAR_DIR}/alice.md`

mkdirSync(nodePath(CHAR_DIR), { recursive: true })
mkdirSync(nodePath(`${ROOT}/.runtime`), { recursive: true })
writeFileSync(nodePath(MARKER), JSON.stringify({ name: 'stage2-test' }), 'utf8')
writeFileSync(nodePath(`${CAMPAIGN}/calendar.json`), JSON.stringify({
  day: 2, month: 3, year: 1247, hour: 8, month_length: 30,
  months: ['Frostride', 'Thawmonth', 'Seedfall', 'Rainmonth', 'Bloomtide', 'Highsun',
    'Fireseek', 'Sunswane', 'Harvestmoot', 'Leafall', 'Frostmoot', 'Sunwane'],
  day_names: [], events: [],
}, null, 2) + '\n', 'utf8')

// The character fixture, born through the SAME validated write path the tools
// use. xpNext is a stored field, so the XP-progress cases have a threshold.
{
  const { refused, reason } = await writeCharacter(rawFs, CHAR_DIR, 'alice', {
    state: {
      name: 'Alice',
      identity: { level: 1, xp: 0, xpNext: 300 },
      combat: { hp: { current: 8, max: 8 }, tempHp: 0 },
      currency: 785,
      spellSlots: { 1: { total: 2, used: 0 } },
      equipment: {
        gear: {
          'Spellbook (arcane focus)': 1,
          Robe: 1,
          'Book (history)': 1,
          Parchment: 8,
          "Calligrapher's Supplies": 1,
          "Scholar's pack": 1,
        },
      },
    },
    narrative: 'A tidy wizard in a grey robe, fond of parchment.\n',
    player: 'scenario',
    campaign: 'stage2-test',
    calendar: JSON.parse(readFileSync(nodePath(`${CAMPAIGN}/calendar.json`), 'utf8')),
  })
  if (refused) {
    console.error('concurrency.scenario: the fixture itself is invalid: ' + reason)
    process.exit(1)
  }
}

const sha = (p) => createHash('sha256').update(readFileSync(nodePath(p))).digest('hex')
const ctx = { get: (n) => (n === 'fs' ? fs : undefined) }
const byName = Object.fromEntries(buildTools(ctx).map((t) => [t.name, t]))
const call = (name, args) => byName[name].execute(args)

let failures = 0
function check(cond, msg) {
  if (cond) { console.log('  ok  ' + msg) } else { failures += 1; console.log('  FAIL ' + msg) }
}
function section(title) { console.log('\n' + title) }

const readState = () => JSON.parse(readFileSync(nodePath(STATE), 'utf8'))
const writeState = (obj) => writeFileSync(nodePath(STATE), JSON.stringify(obj, null, 2) + '\n', 'utf8')

/** Reset every field the cases below touch, so order cannot decide the result. */
function resetFixture({ currency = 785, hp = 8, maxHp = 8, xp = 0, used = 0 } = {}) {
  const s = readState()
  s.currency = currency
  s.combat.hp = { current: hp, max: maxHp }
  s.combat.tempHp = 0
  s.identity.xp = xp
  s.identity.level = 1
  s.spellSlots = { 1: { total: 2, used } }
  s.equipment.gear = {
    'Spellbook (arcane focus)': 1,
    Robe: 1,
    'Book (history)': 1,
    Parchment: 8,
    "Calligrapher's Supplies": 1,
    "Scholar's pack": 1,
  }
  delete s.conditions
  delete s.appliedKeys
  writeState(s)
}

try {
  // The marker already points at the throwaway campaign; the cases below just
  // run. (The live-campaign save/restore this used to do is gone with the live
  // campaign itself.)

  // --- two overlapping damage calls --------------------------------------
  // The core case. No keys: two hits are two hits, and BOTH must land.
  section('two concurrent dnd_track calls — both must land')
  resetFixture({ hp: 8, maxHp: 8 })
  const startHp = readState().combat.hp.current

  // Start both, THEN await. This is the ordering that exposes the race.
  const p1 = call('dnd_track', { hp: '-3', reason: 'goblin' })
  const p2 = call('dnd_track', { hp: '-3', reason: 'goblin' })
  const [r1, r2] = await Promise.all([p1, p2])

  const finalHp = readState().combat.hp.current
  check(startHp === 8, 'the fixture starts at HP 8, got ' + startHp)
  check(finalHp === 2, `both hits landed: 8 - 3 - 3 = 2, got ${finalHp} (a lost update gives 5)`)

  // The reports must show a CHAIN, not two identical reads. If both calls
  // report "8 -> 5" they both acted on the same stale snapshot even if the
  // final number happened to come out right.
  const texts = [r1, r2].join('\n')
  check(/HP 8 -> 5/.test(texts), 'one call saw the original value: ' + JSON.stringify(r1))
  check(/HP 5 -> 2/.test(texts), 'the other saw the first call\'s result: ' + JSON.stringify(r2))
  check(!/fs service unavailable/.test(texts), 'both calls had the fs service')

  // --- two overlapping spends --------------------------------------------
  section('two concurrent dnd_spend calls — both must charge')
  resetFixture({ currency: 785 })
  const [s1, s2] = await Promise.all([
    call('dnd_spend', { amount: '15 cp', reason: 'arrows' }),
    call('dnd_spend', { amount: '15 cp', reason: 'arrows' }),
  ])
  check(readState().currency === 755,
    `both purchases charged: 785 - 15 - 15 = 755, got ${readState().currency} (a lost update gives 770)`)
  check(/Spent 1 sp 5 cp/.test(s1) && /Spent 1 sp 5 cp/.test(s2), 'both reported a successful spend')
  // The prose renders coin twice and the two renderers differ: the purse moves
  // through `formatCurrencyShort` (zero units dropped: "7 gp 7 sp") while the
  // trailing parenthetical uses the full `formatCurrency` ("7 gp 7 sp 0 cp").
  // The evidence that the calls CHAINED is the middle value appearing as one
  // call's `after` and the other's `before`.
  check(/7 gp 8 sp 5 cp -> 7 gp 7 sp\b/.test(s1 + s2),
    'one spend saw the opening balance: ' + JSON.stringify(s1))
  check(/7 gp 7 sp -> 7 gp 5 sp 5 cp/.test(s1 + s2),
    'the other saw the first spend\'s balance: ' + JSON.stringify(s2))

  // --- one character named three ways -------------------------------------
  // The lock is keyed on the RESOLVED stem, not on the caller's argument, and
  // this is the case that proves why. `locateCharacter` matches a substring, and
  // an omitted name is allowed when the campaign has one character, so "alice",
  // "ali" and "" are three spellings of ONE character. Keying on the raw
  // argument gave them three independent chains and they still lost updates:
  //
  //     "alice" vs "ali"     -> hp 5
  //     "alice" vs omitted   -> hp 5
  //     "ALICE" vs "alice"   -> hp 2   (lowercasing hid it for the case variant)
  //
  // The last line is why this needs its own case: an earlier version lowercased
  // the key and looked correct for the one spelling pair a case-insensitive test
  // would try.
  section('the lock is keyed on the resolved character, not the argument')
  for (const [label, a, b] of [
    ['"alice" vs "ali"', { character: 'alice', hp: '-3' }, { character: 'ali', hp: '-3' }],
    ['"alice" vs omitted', { character: 'alice', hp: '-3' }, { hp: '-3' }],
    ['"ALICE" vs "alice"', { character: 'ALICE', hp: '-3' }, { character: 'alice', hp: '-3' }],
  ]) {
    resetFixture({ hp: 8, maxHp: 8 })
    await Promise.all([call('dnd_track', a), call('dnd_track', b)])
    const hp = readState().combat.hp.current
    check(hp === 2, `${label}: both hits landed, 8 - 3 - 3 = 2, got ${hp}`)
  }

  // --- an unaffordable spend racing an affordable one ---------------------
  // The refusal decision must be made against the CURRENT purse. If the second
  // call reads a stale 10 cp it refuses a purchase the purse can now afford.
  section('a refusal is judged against the current purse, not a stale one')
  resetFixture({ currency: 10 })
  const beforeRefusalRace = sha(STATE)
  const [okSpend, refusedSpend] = await Promise.all([
    call('dnd_spend', { amount: '10 cp' }),
    call('dnd_spend', { amount: '10 cp' }),
  ])
  const purse = readState().currency
  check(purse >= 0, 'the purse never goes negative, got ' + purse)
  // Exactly one of the two can be paid: 10 cp affords one 10 cp purchase.
  check(purse === 0, 'exactly one 10 cp purchase succeeded: 10 - 10 = 0, got ' + purse)
  const refusedText = [okSpend, refusedSpend].filter((t) => /REFUSED/.test(t))
  const okText = [okSpend, refusedSpend].filter((t) => !/REFUSED/.test(t))
  check(refusedText.length === 1, 'exactly one call was refused, got ' + refusedText.length)
  check(okText.length === 1, 'and exactly one succeeded, got ' + okText.length)
  check(/Short by/.test(refusedText[0] ?? ''), 'the refusal names the shortfall: ' + JSON.stringify(refusedText[0]))
  check(sha(STATE) !== beforeRefusalRace, 'the successful half did write')

  // --- two overlapping XP awards -----------------------------------------
  section('two concurrent dnd_track xp changes — both must award')
  resetFixture({ xp: 0 })
  await Promise.all([
    call('dnd_track', { xp: '+100', reason: 'trap' }),
    call('dnd_track', { xp: '+100', reason: 'trap' }),
  ])
  check(readState().identity.xp === 200,
    `both awards applied: 0 + 100 + 100 = 200, got ${readState().identity.xp} (a lost update gives 100)`)

  // --- one key, two overlapping calls ------------------------------------
  // The same key sent twice at once must still apply exactly once. This is the
  // interaction between the two mechanisms: the duplicate check reads
  // `appliedKeys` from the same snapshot the write restores, so it is only
  // correct if it too runs inside the lock.
  section('the same key twice, concurrently, applies exactly once')
  resetFixture({ xp: 0 })
  const [d1, d2] = await Promise.all([
    call('dnd_track', { xp: '+100', key: 'session-4' }),
    call('dnd_track', { xp: '+100', key: 'session-4' }),
  ])
  check(readState().identity.xp === 100,
    `a duplicated key charged once: got ${readState().identity.xp}`)
  const dup = [d1, d2].filter((t) => /Already applied/.test(t))
  check(dup.length === 1, 'exactly one call reported the duplicate, got ' + dup.length)

  // --- different characters must not block one another --------------------
  // Serialization is per character. A lock held across the whole campaign would
  // make two players' writes queue behind each other for no reason.
  //
  // The second character is created and removed inside this block. Leaving it
  // behind would make every later keyless call ambiguous ("stage2-test has 2"),
  // which is a real failure mode: an earlier version of this file cleaned up
  // only files it found empty, so a leftover `bob.md` silently broke the cases
  // that ran after it.
  section('the lock is per character, not global')
  resetFixture({ currency: 785 })
  const bobStatePath = `${CHAR_DIR}/bob.state.json`
  const bobSheetPath = `${CHAR_DIR}/bob.md`
  const hadBobState = existsSync(nodePath(bobStatePath))
  const hadBobSheet = existsSync(nodePath(bobSheetPath))
  const bobStateBytes = hadBobState ? readFileSync(nodePath(bobStatePath)) : null
  const bobSheetBytes = hadBobSheet ? readFileSync(nodePath(bobSheetPath)) : null
  try {
    // A minimal second character, cloned from alice so it is a valid sheet.
    const bob = JSON.parse(JSON.stringify(readState()))
    bob.name = 'Bob'
    bob.currency = 785
    writeFileSync(nodePath(bobStatePath), JSON.stringify(bob, null, 2) + '\n', 'utf8')
    writeFileSync(nodePath(bobSheetPath), readFileSync(nodePath(SHEET), 'utf8'), 'utf8')

    await Promise.all([
      call('dnd_spend', { amount: '15 cp', character: 'alice' }),
      call('dnd_spend', { amount: '15 cp', character: 'bob' }),
    ])
    const alicePurse = readState().currency
    const bobPurse = JSON.parse(readFileSync(nodePath(bobStatePath), 'utf8')).currency
    check(alicePurse === 770, 'alice was charged once, got ' + alicePurse)
    check(bobPurse === 770, 'bob was charged once, got ' + bobPurse)
  } finally {
    // Restore exactly what was there: the bytes if the file existed, REMOVAL if
    // it did not. Blanking instead of deleting would still leave a character.
    if (hadBobState) writeFileSync(nodePath(bobStatePath), bobStateBytes)
    else rmSync(nodePath(bobStatePath), { force: true })
    if (hadBobSheet) writeFileSync(nodePath(bobSheetPath), bobSheetBytes)
    else rmSync(nodePath(bobSheetPath), { force: true })
  }
  // The roster must be back to one character, or the cases below cannot address
  // a character by omission.
  check(readdirSync(nodePath(CHAR_DIR)).filter((f) => /^bob\./i.test(f)).length === 0,
    'the temporary second character was removed')

  // --- the interleaving really happened -----------------------------------
  // Without this, the whole file could pass because the two calls never actually
  // overlapped — the assertions above would then prove nothing about concurrency.
  //
  // `execute` is async, and each fs operation suspends it, so reaching the first
  // READ takes several event-loop turns (resolve, stat, resolve, read...). The
  // loop pumps ticks until a write appears, or until a bound is hit, and then
  // the order of the ops already recorded is what gets asserted.
  section('the calls genuinely interleaved')
  resetFixture({ hp: 8, maxHp: 8 })
  fsTouched.length = 0
  const w1 = call('dnd_track', { hp: '-1' })
  const w2 = call('dnd_track', { hp: '-1' })
  for (let i = 0; i < 50 && !fsTouched.includes('write'); i += 1) await yieldTick()
  const firstWrite = fsTouched.indexOf('write')
  const readsBeforeFirstWrite = (firstWrite === -1 ? fsTouched : fsTouched.slice(0, firstWrite))
    .filter((x) => x === 'read').length
  check(firstWrite !== -1, 'a write was issued')
  check(readsBeforeFirstWrite >= 2,
    `both reads were issued before the first write (${readsBeforeFirstWrite} reads), so the window was open ` +
    `— trace: ${fsTouched.join(',')}`)
  await Promise.all([w1, w2])
  check(readState().combat.hp.current === 6, 'and both writes landed: 8 - 1 - 1 = 6, got ' + readState().combat.hp.current)

  // --- a concurrent write must not corrupt the narrative ------------------
  section('overlapping writes leave a well-formed sheet')
  resetFixture()
  await Promise.all([
    call('dnd_track', { hp: '-1' }),
    call('dnd_track', { hp: '-1' }),
    call('dnd_track', { conditions: 'prone' }),
  ])
  const sheetText = readFileSync(nodePath(SHEET), 'utf8')
  const generatedCount = (sheetText.match(/<!-- dsh-dnd:generated -->/g) ?? []).length
  check(generatedCount === 1, `exactly one generated block survives, found ${generatedCount}`)
  check(/^updated: \d{4}-\d{2}-\d{2}$/m.test(sheetText), 'the clock is stamped exactly once')
  const finalState = readState()
  check(finalState.combat.hp.current === 6, 'all three writes landed: 8 - 1 - 1 = 6, got ' + finalState.combat.hp.current)
} finally {
  resetFixture()
  process.env.DND_ROOT = savedRoot
}

section('the workspace stayed inside the temp tree')
check(existsSync(nodePath(MARKER)), 'the active-campaign marker exists in the temp workspace')
check(JSON.parse(readFileSync(nodePath(MARKER), 'utf8').replace(/^\uFEFF/, '')).name === 'stage2-test',
  'and the throwaway campaign is the active one')

console.log('')
if (failures > 0) {
  console.error(`concurrency.scenario: ${failures} failure(s)`)
  process.exit(1)
}
console.log('concurrency.scenario: all assertions passed')
