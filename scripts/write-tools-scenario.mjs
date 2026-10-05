/**
 * tests the WRITE TOOLS, not the write layer.
 *
 * scenario-test.mjs drives `writeCharacter` directly, which is why the money
 * rules were covered while `dnd_spend` itself never ran. This goes through the
 * real `execute(args)` of dnd_spend / dnd_track, so the argument
 * parsing, the affordability decision, the idempotency check and the returned
 * prose are all exercised — the parts a DM actually meets.
 *
 * ## Safety
 *
 * The scenario is SELF-CONTAINED: it builds a throwaway workspace in the OS
 * temp dir, points the explicit `DND_ROOT` env at it for the duration, and
 * scaffolds the campaign inside it — no live campaign is read, repointed, or
 * hashed, because there is no live campaign in the picture at all. Every fs
 * method guards its paths against escaping the temp tree, so a leak fails
 * loudly instead of touching a real campaign.
 *
 * ## Why it asserts on BYTES, not on re-reads
 *
 * "The file must not change when a spend is refused" is a claim about bytes on
 * disk. Re-reading through the same parser that may be wrong would agree with
 * itself. So the refusals compare file hashes.
 */
import { readFileSync, writeFileSync, statSync, readdirSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { buildTools } from '../src/host/tools/track.mjs'
import { writeCharacter } from '../src/host/tools/state-io.mjs'

const nodePath = (p) => String(p).replace(/\//g, path.sep)
const target = (p) => ({ targetKey: String(p).toLowerCase(), displayPath: String(p).replace(/\\/g, '/') })

// ---------------------------------------------------------------------------
// the throwaway workspace
// ---------------------------------------------------------------------------
const savedRoot = process.env.DND_ROOT
const tempRoot = mkdtempSync(path.join(tmpdir(), 'dnd-write-scenario-')).replace(/\\/g, '/')
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

const fs = {
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
  const CAL = JSON.parse(readFileSync(nodePath(`${CAMPAIGN}/calendar.json`), 'utf8'))
  const { refused, reason } = await writeCharacter(fs, CHAR_DIR, 'alice', {
    state: {
      name: 'Alice',
      identity: { level: 1, xp: 0, xpNext: 300 },
      combat: { hp: { current: 5, max: 8 }, tempHp: 0 },
      currency: 785,
      spellSlots: { 1: { total: 2, used: 1 } },
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
    calendar: CAL,
  })
  if (refused) {
    console.error('write-tools.scenario: the fixture itself is invalid: ' + reason)
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

/**
 * Reset the fixture to a known state before each case.
 *
 * This must cover EVERY field any case touches, not just the obvious ones. An
 * earlier version left `tempHp` and the gear counts alone, so a case that ran
 * after another inherited its leftovers — the tests passed or failed according
 * to execution order, which is worse than failing outright.
 */
function resetFixture({ currency = 785, hp = 5, maxHp = 8, xp = 0, used = 1 } = {}) {
  const s = readState()
  s.currency = currency
  s.combat.hp = { current: hp, max: maxHp }
  s.combat.tempHp = 0
  s.identity.xp = xp
  s.identity.level = 1
  s.spellSlots = { 1: { total: 2, used } }
  // The full gear set, not just the one item a case adjusts: truncating it
  // would make the fixture progressively less like a real sheet, and a later
  // case could then succeed against a state no real character has.
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

  // --- dnd_spend: the affordable case ------------------------------------
  section('dnd_spend — affordable')
  resetFixture()
  // 15 cp renders as "1 sp 5 cp": formatCurrencyShort omits zero units on
  // purpose, so a small price does not read "0 gp 0 sp 15 cp".
  let out = await call('dnd_spend', { amount: '15 cp', reason: 'ten arrows' })
  check(/Spent 1 sp 5 cp/.test(out), 'reports the amount spent: ' + JSON.stringify(out))
  check(readState().currency === 770, 'purse moved 785 -> 770, got ' + readState().currency)

  // --- dnd_spend: judged on the TOTAL, not a denomination ----------------
  // 800 cp is 8 gp 0 sp 0 cp: no copper pieces at all, yet 15 cp is payable.
  section('dnd_spend — affordability is judged on the total')
  resetFixture({ currency: 800 })
  out = await call('dnd_spend', { amount: '15 cp' })
  check(/Spent 1 sp 5 cp/.test(out), 'payable with zero copper pieces: ' + JSON.stringify(out))
  check(readState().currency === 785, '800 - 15 = 785, got ' + readState().currency)

  // --- dnd_spend: refused, and the file must not move --------------------
  section('dnd_spend — unaffordable spend is refused')
  resetFixture({ currency: 10 })
  const beforeRefusal = sha(STATE)
  out = await call('dnd_spend', { amount: '8 gp' })
  check(/REFUSED/.test(out), 'reports refusal: ' + JSON.stringify(out))
  check(/Short by/.test(out), 'names the shortfall: ' + JSON.stringify(out))
  check(sha(STATE) === beforeRefusal, 'the state file is byte-identical after a refusal')
  check(readState().currency === 10, 'the purse did not move, got ' + readState().currency)
  check(!/debt/i.test(out) || /no debt/i.test(out), 'no debt is recorded')

  // 800 cp affords 15 cp even with no copper pieces was covered above; here the
  // reverse: 10 cp cannot afford 8 gp, and nothing partial is applied.
  check(readState().currency >= 0, 'the purse never goes negative')

  // --- idempotency: same key must not charge twice -----------------------
  section('dnd_spend — idempotency')
  resetFixture({ currency: 785 })
  out = await call('dnd_spend', { amount: '15 cp', key: 'buy-arrows-1' })
  check(readState().currency === 770, 'first call applies: ' + readState().currency)
  out = await call('dnd_spend', { amount: '15 cp', key: 'buy-arrows-1' })
  check(/Already applied/.test(out), 'second call reports the duplicate: ' + JSON.stringify(out))
  check(readState().currency === 770, 'second call did NOT charge again, got ' + readState().currency)

  // Without a key, two identical purchases are two purchases — the correct
  // default, because "take 5 damage" twice means 10.
  resetFixture({ currency: 785 })
  await call('dnd_spend', { amount: '15 cp' })
  await call('dnd_spend', { amount: '15 cp' })
  check(readState().currency === 755, 'two keyless spends both apply, got ' + readState().currency)

  // A different key is a different purchase, even at the same price.
  resetFixture({ currency: 785 })
  await call('dnd_spend', { amount: '15 cp', key: 'k-a' })
  await call('dnd_spend', { amount: '15 cp', key: 'k-b' })
  check(readState().currency === 755, 'distinct keys both apply, got ' + readState().currency)

  // --- dnd_spend: missing amount is refused, not treated as zero ---------
  // The live bug: a missing `query` became the string "undefined". Here a
  // missing amount must be caught before any arithmetic.
  section('dnd_spend — argument validation')
  resetFixture({ currency: 785 })
  const beforeBadArg = sha(STATE)
  out = await call('dnd_spend', {})
  check(/needs an `amount`/.test(out), 'a missing amount is reported: ' + JSON.stringify(out))
  check(sha(STATE) === beforeBadArg, 'nothing was written for a missing amount')
  check(readState().currency === 785, 'the purse is untouched, got ' + readState().currency)

  out = await call('dnd_spend', { amount: 'banana' })
  check(/could not read/.test(out), 'an unparseable amount is reported: ' + JSON.stringify(out))
  check(/Nothing was written/.test(out), 'and it says nothing was written')

  // --- dnd_track: damage, healing, clamping ------------------------------
  section('dnd_track — hit points')
  resetFixture({ hp: 5, maxHp: 8 })
  out = await call('dnd_track', { hp: '-3' })
  check(readState().combat.hp.current === 2, '5 - 3 = 2, got ' + readState().combat.hp.current)
  check(/HP 5 -> 2/.test(out), 'reports the change: ' + JSON.stringify(out))

  resetFixture({ hp: 5, maxHp: 8 })
  out = await call('dnd_track', { hp: '-20' })
  check(readState().combat.hp.current === 0, 'damage below 0 clamps to 0, got ' + readState().combat.hp.current)
  // The landing report names the overflow (the massive-damage input), not the
  // internal clamp — wording changed when temp HP absorption moved in.
  check(/Overflow damage: 15/.test(out), 'and reports the overflow: ' + JSON.stringify(out))

  resetFixture({ hp: 5, maxHp: 8 })
  out = await call('dnd_track', { hp: '+20' })
  check(readState().combat.hp.current === 8, 'healing above max clamps to max, got ' + readState().combat.hp.current)
  check(/clamped/.test(out), 'and says it clamped: ' + JSON.stringify(out))

  resetFixture({ hp: 5, maxHp: 8 })
  await call('dnd_track', { hp: '=4' })
  check(readState().combat.hp.current === 4, 'absolute set works, got ' + readState().combat.hp.current)

  // --- dnd_track: spell slots -------------------------------------------
  // `used` counts what has been EXPENDED, so "-1" (expend one from the
  // character's point of view) must RAISE it. The first version of this test
  // asserted the opposite and would have locked in a silent sign bug.
  section('dnd_track — spell slots')
  resetFixture({ used: 1 })
  out = await call('dnd_track', { spellSlots: '1:-1' })
  check(readState().spellSlots['1'].used === 2,
    'expending a slot raises `used` to 2, got ' + readState().spellSlots['1'].used)
  check(/1\/2 -> 0\/2/.test(out), 'the report shows slots remaining, not expended: ' + JSON.stringify(out))

  // Expending a third when only two exist must be refused, not written.
  const beforeOverdraw = sha(STATE)
  out = await call('dnd_track', { spellSlots: '1:-1' })
  check(/REFUSED/.test(out), 'over-expending is refused: ' + JSON.stringify(out))
  check(sha(STATE) === beforeOverdraw, 'the file is byte-identical after the refusal')

  // Restoring past full is a no-op, not an error.
  resetFixture({ used: 0 })
  out = await call('dnd_track', { spellSlots: '1:+1' })
  check(readState().spellSlots['1'].used === 0, 'restoring past full leaves used at 0, got ' + readState().spellSlots['1'].used)
  check(/no change/i.test(out), 'and says nothing changed: ' + JSON.stringify(out))

  // Restoring one from a partly-spent state does move.
  resetFixture({ used: 2 })
  await call('dnd_track', { spellSlots: '1:+1' })
  check(readState().spellSlots['1'].used === 1, 'restoring lowers used to 1, got ' + readState().spellSlots['1'].used)

  // Multiple levels in one call.
  resetFixture({ used: 1 })
  const multi = readState()
  multi.spellSlots['2'] = { total: 1, used: 0 }
  writeState(multi)
  await call('dnd_track', { spellSlots: '1:-1,2:-1' })
  const afterMulti = readState()
  check(afterMulti.spellSlots['1'].used === 2 && afterMulti.spellSlots['2'].used === 1,
    'both levels move in one call, got ' + JSON.stringify(afterMulti.spellSlots))

  // A level the character does not have is refused, not invented.
  const beforeNoLevel = sha(STATE)
  out = await call('dnd_track', { spellSlots: '7:-1' })
  check(/no level-7 spell slots/.test(out), 'an absent level is refused: ' + JSON.stringify(out))
  check(sha(STATE) === beforeNoLevel, 'and the file is byte-identical')

  // --- dnd_track: temp HP does not stack --------------------------------
  section('dnd_track — temporary HP')
  resetFixture()
  await call('dnd_track', { tempHp: '+8' })
  check(readState().combat.tempHp === 8, 'temp HP set to 8, got ' + readState().combat.tempHp)
  await call('dnd_track', { tempHp: '+3' })
  check(readState().combat.tempHp === 8, 'a lower source does not replace the higher, got ' + readState().combat.tempHp)
  await call('dnd_track', { tempHp: '+12' })
  check(readState().combat.tempHp === 12, 'a higher source replaces it, got ' + readState().combat.tempHp)

  // --- dnd_track: conditions --------------------------------------------
  section('dnd_track — conditions')
  resetFixture()
  await call('dnd_track', { conditions: 'prone,poisoned' })
  check(JSON.stringify(readState().conditions) === '["prone","poisoned"]',
    'conditions persist, got ' + JSON.stringify(readState().conditions))
  await call('dnd_track', { conditions: 'prone' })
  check(readState().conditions.length === 2, 'adding a duplicate does not duplicate it, got ' + JSON.stringify(readState().conditions))
  await call('dnd_track', { removeConditions: 'prone' })
  check(JSON.stringify(readState().conditions) === '["poisoned"]',
    'removing works, got ' + JSON.stringify(readState().conditions))
  await call('dnd_track', { conditions: 'none' })
  check(JSON.stringify(readState().conditions) === '[]', 'clearing works, got ' + JSON.stringify(readState().conditions))

  // --- dnd_track: a named consumable ------------------------------------
  section('dnd_track — a consumable')
  resetFixture()
  await call('dnd_track', { resource: 'Parchment', resourceDelta: '-2' })
  check(readState().equipment.gear.Parchment === 6, '8 - 2 = 6, got ' + readState().equipment.gear.Parchment)
  const beforeOveruse = sha(STATE)
  out = await call('dnd_track', { resource: 'Parchment', resourceDelta: '-99' })
  check(/REFUSED/.test(out), 'using more than you have is refused: ' + JSON.stringify(out))
  check(sha(STATE) === beforeOveruse, 'the file is byte-identical after the refusal')
  check(readState().equipment.gear.Parchment === 6, 'the count did not move')

  // --- dnd_track currency: the credit route for dnd_loot ----------------
  section('dnd_track — currency')
  resetFixture({ currency: 15 })
  out = await call('dnd_track', { currency: '+103 gp', reason: 'loot split' })
  check(readState().currency === 15 + 10300, 'loot credited in copper: 15 gp + 103 gp, got ' + readState().currency)
  check(/Purse/.test(out) && /-> 103 gp 1 sp 5 cp/.test(out), 'reports the purse movement: ' + JSON.stringify(out))

  out = await call('dnd_track', { currency: '-104 gp 6 sp' })
  check(/REFUSED/.test(out) && /Short by/.test(out), 'a debit below zero is refused with the shortfall: ' + JSON.stringify(out))
  check(readState().currency === 15 + 10300, 'the purse did not move on the refused debit')

  out = await call('dnd_track', { currency: '=50 gp' })
  check(readState().currency === 5000, 'absolute set works, got ' + readState().currency)

  out = await call('dnd_track', { currency: 'banana' })
  check(/could not read currency/.test(out), 'an unparseable currency is refused: ' + JSON.stringify(out))

  // --- dnd_track xp ------------------------------------------------------
  // dnd_xp_add was folded into dnd_track: the xp change now reports the level
  // progress from the stored `xpNext` right in its change list.
  section('dnd_track — xp and level progress')
  resetFixture({ xp: 0 })
  out = await call('dnd_track', { xp: '+250', reason: 'goblin ambush' })
  check(readState().identity.xp === 250, 'XP awarded, got ' + readState().identity.xp)
  check(/XP 0 -> 250/.test(out), 'reports the award: ' + JSON.stringify(out))
  check(/50 XP until level 2/.test(out), 'reports the remainder to the next level: ' + JSON.stringify(out))

  out = await call('dnd_track', { xp: '+50' })
  check(/Ready to advance to level 2/.test(out), 'reports readiness at the threshold: ' + JSON.stringify(out))
  check(readState().identity.level === 1, 'but does NOT level the character up, level is ' + readState().identity.level)

  const beforeNegXp = sha(STATE)
  out = await call('dnd_track', { xp: '-9999' })
  check(/REFUSED/.test(out), 'removing more XP than exists is refused: ' + JSON.stringify(out))
  check(sha(STATE) === beforeNegXp, 'the file is byte-identical after the refusal')

  out = await call('dnd_track', {})
  check(/needs at least one of/.test(out), 'a call with no change field is refused: ' + JSON.stringify(out))

  // --- learning spells is a track change, not a hand edit ----------------
  section('dnd_track — spell lists')
  resetFixture()
  out = await call('dnd_track', { spells: 'spellbook:+Fireball,prepared:+Fireball' })
  const afterLearn = readState()
  check(afterLearn.spells?.spellbook?.includes('Fireball') === true, 'Fireball learned into the spellbook')
  check(afterLearn.spells?.prepared?.includes('Fireball') === true, 'Fireball prepared in the same call')
  check(/Spell learned: Fireball/.test(out), 'reports each learning: ' + JSON.stringify(out))

  out = await call('dnd_track', { spells: 'spellbook:+Fireball' })
  check(/already knows/.test(out), 'learning a known spell is refused: ' + JSON.stringify(out))

  out = await call('dnd_track', { spells: 'prepared:-Fireball,spellbook:-Fireball' })
  const afterDrop = readState()
  check(afterDrop.spells?.spellbook?.includes('Fireball') !== true
    && afterDrop.spells?.prepared?.includes('Fireball') !== true, 'both lists dropped Fireball')

  out = await call('dnd_track', { spells: 'pages:+Fireball' })
  check(/could not read spells entry/.test(out), 'an unknown list is refused: ' + JSON.stringify(out))

  // --- idempotency for xp and track too ---------------------------------
  section('idempotency across the write tools')
  resetFixture({ xp: 0 })
  await call('dnd_track', { xp: '+100', key: 'session-4' })
  await call('dnd_track', { xp: '+100', key: 'session-4' })
  check(readState().identity.xp === 100, 'xp is not awarded twice for one key, got ' + readState().identity.xp)

  resetFixture({ hp: 8, maxHp: 8 })
  await call('dnd_track', { hp: '-3', key: 'trap-1' })
  await call('dnd_track', { hp: '-3', key: 'trap-1' })
  check(readState().combat.hp.current === 5, 'damage is not applied twice for one key, got ' + readState().combat.hp.current)

  // --- naming the character when ambiguous ------------------------------
  section('character selection')
  out = await call('dnd_spend', { amount: '1 cp', character: 'nobody' })
  check(/not found/.test(out), 'an unknown character is reported with the roster: ' + JSON.stringify(out))
  check(/alice/.test(out), 'and the message names who does exist')

  // --- the dual clocks ---------------------------------------------------
  section('dual clocks')
  resetFixture()
  await call('dnd_track', { hp: '-1', character: 'alice' })
  const sheetText = readFileSync(nodePath(SHEET), 'utf8')
  check(/^updated: \d{4}-\d{2}-\d{2}$/m.test(sheetText), 'the real clock is stamped in the frontmatter')
  check(/^worldTime: .+$/m.test(sheetText), 'the world clock is stamped too:\n' + sheetText.slice(0, 400))

  // --- the narrative half must survive ----------------------------------
  // This is the "summary block treated as preamble" defect (bug 8 in the plan):
  // it nested a copy of the generated block into the narrative on every write.
  // The check is that the narrative BELOW the generated block is byte-identical
  // across a write — comparing whole files would fail on the HP line, which is
  // supposed to change, and comparing only the frontmatter would miss the
  // nesting entirely.
  section('the narrative half survives a write')
  const narrativeOf = (text) => {
    const close = '<!-- /dsh-dnd:generated -->'
    const at = text.indexOf(close)
    const body = at === -1 ? text : text.slice(at + close.length)
    // Drop the frontmatter too: `updated` legitimately changes every write.
    return body.replace(/^---[\s\S]*?---\s*/, '').trim()
  }

  resetFixture()
  const sheetBefore = readFileSync(nodePath(SHEET), 'utf8')
  await call('dnd_track', { hp: '-1' })
  const sheetAfter = readFileSync(nodePath(SHEET), 'utf8')
  check(narrativeOf(sheetBefore) === narrativeOf(sheetAfter),
    'the narrative below the generated block is unchanged across a write')

  // Write twice more: nesting compounds, so one round trip would not catch it.
  await call('dnd_track', { hp: '-1' })
  await call('dnd_track', { hp: '+1' })
  const sheetThird = readFileSync(nodePath(SHEET), 'utf8')
  check(narrativeOf(sheetThird) === narrativeOf(sheetBefore),
    'and it is still unchanged after three writes, so nothing nests')
  const generatedCount = (sheetThird.match(/<!-- dsh-dnd:generated -->/g) ?? []).length
  check(generatedCount === 1, `exactly one generated block exists, found ${generatedCount}`)
} finally {
  // The marker is a temp file this script wrote; nothing to restore. The
  // fixture is reset so the assertions stay repeatable.
  resetFixture()
  process.env.DND_ROOT = savedRoot
}

section('the workspace stayed inside the temp tree')
check(existsSync(nodePath(MARKER)), 'the active-campaign marker exists in the temp workspace')
check(JSON.parse(readFileSync(nodePath(MARKER), 'utf8').replace(/^\uFEFF/, '')).name === 'stage2-test',
  'and the throwaway campaign is the active one')
check(readState().currency === 785, 'the fixture was restored for repeatability')

console.log('')
if (failures > 0) {
  console.error(`write-tools.scenario: ${failures} failure(s)`)
  process.exit(1)
}
console.log('write-tools.scenario: all assertions passed')
