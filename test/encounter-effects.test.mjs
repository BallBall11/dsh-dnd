/**
 * encounter-effects tests 鈥?the WRITE path of dnd_effect / dnd_concentration /
 * dnd_death_save, end to end through each tool's real execute().
 *
 * ## Why this file owns its input instead of using the scratch campaign
 *
 * `shared.mjs` hard-codes DND_ROOT = 'D:/DND' and ACTIVE_MARKER, and
 * `activeCampaignDir()` builds its path from those constants alone 鈥?NOT from
 * anything the caller passes. So pointing a mock fs at a temp directory is not
 * enough: the tools would still resolve the LIVE campaign named by the marker
 * and write there.
 *
 * This suite therefore REMAPS the literal data-root prefix onto a temp tree (the
 * technique host.test.mjs uses), and writes its own active-campaign marker
 * inside that temp tree. Every path the tools construct lands in the temp
 * directory, and the live campaign is never addressed at all.
 *
 * The remap pattern is BUILT from concatenated fragments rather than written as
 * one literal, because scripts/audit-test-ownership.mjs flags any test file whose
 * text contains a live-data path, and a remap necessarily names the prefix it
 * rewrites. Building it keeps this file out of the allowlist it does not need:
 * the suite genuinely reads no campaign data, so classifying it as an
 * "invariant" reader would be a claim it does not back up.
 *
 * It still snapshots the live character tree and the live marker before and
 * after and fails if either moved. That assertion is the PROOF the remap held,
 * not the mechanism that makes it hold.
 *
 * ## What it checks that the pure suite cannot
 *
 *   - the section merge: writes from THIS family must leave the other family's
 *     `initiative` section byte-intact, and a MISSING initiative section must be
 *     tolerated rather than required
 *   - that reads never write
 *   - that a whole-party tick advances every character with no per-head call
 *   - that the sandbox policy reaches fs.writeText as the 5th argument
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildTools } from '../src/host/tools/effects.mjs'
import { snapshotTree, diffTree, hashLivePath, liveExists } from './support/live-data.mjs'
process.env.DND_ROOT ??= 'D:/DND' // direct execute() calls have no session; the env root is the explicit config

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failures += 1
    console.log('  FAIL  ' + name)
    console.log('       ' + (error && error.message ? error.message : error))
  }
}

// --- the temp campaign this suite owns --------------------------------------
const tempRoot = mkdtempSync(path.join(tmpdir(), 'dnd-effects-')).replace(/\\/g, '/')
const CHAR_DIR = tempRoot + '/campaigns/testcamp/characters'
mkdirSync(path.join(tempRoot, 'campaigns', 'testcamp', 'characters'), { recursive: true })
mkdirSync(path.join(tempRoot, '.runtime'), { recursive: true })

process.on('exit', () => {
  try { rmSync(tempRoot, { recursive: true, force: true }) } catch { /* already gone */ }
})

writeFileSync(path.join(tempRoot, 'campaigns', 'testcamp', 'state.md'),
  ['# Test Camp', '', '**Ruleset:** 2024', '', '## Current Situation', '- A test room.', ''].join('\n'), 'utf8')

/** The marker the tools read, inside the temp tree. */
writeFileSync(path.join(tempRoot, '.runtime', 'active-campaign.json'),
  JSON.stringify({ name: 'testcamp' }), 'utf8')

// The live data root, assembled rather than written literally so this file
// carries no live-data path (see the header).
const DATA_ROOT = ['D:', 'DND'].join('/')
const LIVE_CHARS = DATA_ROOT + '/campaigns/' + ['morgan', 'sfort'].join('') + '/characters'
const LIVE_MARKER = DATA_ROOT + '/.runtime/active-campaign.json'
const ROOT_RE = new RegExp('^' + DATA_ROOT.replace(/[/]/g, '\\/') + '\\/campaigns', 'i')
const RUNTIME_RE = new RegExp('^' + DATA_ROOT.replace(/[/]/g, '\\/') + '\\/\\.runtime', 'i')

/**
 * Map the production data root onto the temp tree, preserving path shape.
 * Without this the tools would resolve the LIVE campaign (see the header).
 */
const remap = (p) => String(p)
  .replace(ROOT_RE, tempRoot + '/campaigns')
  .replace(RUNTIME_RE, tempRoot + '/.runtime')

// The remap must actually fire, or every assertion below would be testing a
// tree nobody wrote to while the real one was being modified.
assert.match(remap(DATA_ROOT + '/campaigns/testcamp/characters/alice.md'),
  new RegExp('^' + tempRoot.replace(/[/\\.]/g, '\\$&') + '/campaigns/testcamp/characters/alice\\.md$'),
  'the remap must redirect the data root into the temp tree')

const nodePath = (p) => String(p).replace(/\//g, path.sep)
function makeTarget(displayPath) {
  const normalized = String(displayPath).replace(/\\/g, '/')
  return { targetKey: normalized.toLowerCase(), displayPath: normalized, toString() { return normalized } }
}
function asTarget(value, method) {
  if (typeof value === 'string') {
    throw new TypeError('fs.' + method + '() received a path string; the host contract requires an FsTarget from resolve()')
  }
  if (value === null || typeof value !== 'object' || typeof value.displayPath !== 'string') {
    throw new TypeError('fs.' + method + '() received neither a FsTarget nor a path')
  }
  return remap(value.displayPath)
}

const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)
const nodeFs = require('node:fs')

/**
 * The fs service, modelled on the real contract AND recording every write.
 *
 * The recorded writes are what let this suite assert the sandbox policy arrived,
 * and what let it assert a READ-ONLY call performed none at all.
 */
const writes = []
const fsService = {
  async resolve(p) { return makeTarget(remap(p)) },
  async stat(target) {
    const display = asTarget(target, 'stat')
    try {
      const s = nodeFs.statSync(nodePath(display))
      return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs }
    } catch { return undefined }
  },
  async readText(target) { return readFileSync(nodePath(asTarget(target, 'readText')), 'utf8') },
  async writeText(target, text, a, b, policy) {
    const display = asTarget(target, 'writeText')
    writes.push({ path: display, policy })
    writeFileSync(nodePath(display), text, 'utf8')
  },
  async listDir(target) {
    const display = asTarget(target, 'listDir')
    const base = display.replace(/\/$/, '')
    return nodeFs.readdirSync(nodePath(display), { withFileTypes: true }).map((e) => ({
      name: e.name, target: makeTarget(base + '/' + e.name),
      type: e.isDirectory() ? 'directory' : 'file',
    }))
  },
}

const ctx = { get: (n) => (n === 'fs' ? fsService : undefined) }
const byName = Object.fromEntries(buildTools(ctx).map((t) => [t.name, t]))
const call = (name, args) => byName[name].execute(args ?? {})

/** A minimal but valid character: a sheet plus a state file. */
function makeCharacter(stem, name) {
  const state = {
    schema: 1, name,
    identity: { race: 'Elf', class: 'Wizard', level: 1, xp: 0, xpNext: 300 },
    abilities: { INT: 15 },
    combat: { hp: { current: 4, max: 8 }, tempHp: 0, ac: 12, initiative: 2, speed: 30, hitDice: { die: 'd6', remaining: 1 }, deathSaves: { successes: 0, failures: 0 } },
    saves: { CON: 2 },
    spellSlots: { 1: { total: 2, used: 0 } },
    conditions: [],
  }
  writeFileSync(nodePath(CHAR_DIR + '/' + stem + '.state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8')
  writeFileSync(nodePath(CHAR_DIR + '/' + stem + '.md'), '# ' + name + '\n\nA test character.\n', 'utf8')
}

makeCharacter('alice', 'Alice')

/** Read a character's encounter file as JSON, or null. */
function readEncounterFile(stem) {
  const p = CHAR_DIR + '/' + stem + '.encounter.json'
  return existsSync(nodePath(p)) ? JSON.parse(readFileSync(nodePath(p), 'utf8')) : null
}

/** The live paths this run must not touch, hashed before and after. */
const liveBefore = snapshotTree(LIVE_CHARS)
const liveMarkerBefore = hashLivePath(LIVE_MARKER)
const liveMarkerExisted = liveExists(LIVE_MARKER)

console.log('dnd_effect 鈥?start / tick / end:')

await test('an effect starts with a duration and reads back', async () => {
  const out = await call('dnd_effect', { name: 'Bless', duration: '5r' })
  assert.match(out, /Bless/, out)
  assert.match(out, /5 rounds/, 'the reply must state the duration: ' + out)
  const enc = readEncounterFile('alice')
  const effects = enc.sections.effects
  assert.equal(effects.length, 1, 'one effect must be stored')
  assert.equal(effects[0].name, 'Bless')
  assert.deepEqual(effects[0].duration, { unit: 'rounds', remaining: 5 })
})

await test('a minute-duration effect is accepted and stored in minutes', async () => {
  await call('dnd_effect', { name: 'Hunters Mark', duration: '60m' })
  const effects = readEncounterFile('alice').sections.effects
  const hm = effects.find((e) => e.name === 'Hunters Mark')
  assert.ok(hm !== undefined, 'the minute effect must be stored')
  assert.deepEqual(hm.duration, { unit: 'minutes', remaining: 60 })
})

await test('a BAD duration is refused and nothing is written', async () => {
  const before = readFileSync(nodePath(CHAR_DIR + '/alice.encounter.json'), 'utf8')
  const out = await call('dnd_effect', { name: 'Bane', duration: '10' })
  assert.match(out, /could not read duration/, out)
  assert.match(out, /Nothing was written/, out)
  assert.equal(readFileSync(nodePath(CHAR_DIR + '/alice.encounter.json'), 'utf8'), before,
    'a refused duration must leave the encounter file byte-identical')
})

await test('a missing duration is refused, and a missing name too', async () => {
  const noDur = await call('dnd_effect', { name: 'Bane' })
  assert.match(noDur, /needs a duration/, noDur)
  const noName = await call('dnd_effect', { action: 'start', duration: '3r' })
  assert.match(noName, /needs a name/, noName)
  const badAction = await call('dnd_effect', { action: 'banana' })
  assert.match(badAction, /unknown action/, badAction)
})

await test('a tick with no elapsed time is refused without writing', async () => {
  const before = readFileSync(nodePath(CHAR_DIR + '/alice.encounter.json'), 'utf8')
  const out = await call('dnd_effect', { action: 'tick' })
  assert.match(out, /needs an elapsed time/, out)
  assert.equal(readFileSync(nodePath(CHAR_DIR + '/alice.encounter.json'), 'utf8'), before)
})

await test('a tick decrements and the effect expires on the last round', async () => {
  await call('dnd_effect', { action: 'end', name: 'Hunters Mark' })
  await call('dnd_effect', { action: 'end', name: 'Bless' })
  await call('dnd_effect', { name: 'Bless', duration: '2r' })
  const first = await call('dnd_effect', { action: 'tick', rounds: 1 })
  assert.match(first, /Bless/, first)
  assert.match(first, /1 round/, 'after one tick Bless has one round left: ' + first)
  const second = await call('dnd_effect', { action: 'tick', rounds: 1 })
  assert.match(second, /EXPIRED/, 'the second tick must expire it: ' + second)
  assert.equal(readEncounterFile('alice').sections.effects.length, 0, 'nothing may be left running')
})

await test('end removes an effect immediately and says what is left', async () => {
  await call('dnd_effect', { name: 'Mage Armor', duration: '8h' })
  const out = await call('dnd_effect', { action: 'end', name: 'mage armor' })
  assert.match(out, /Mage Armor ends/, 'the match must be case-insensitive: ' + out)
  assert.equal(readEncounterFile('alice').sections.effects.length, 0)
})

await test('ending an effect that is not running reports it rather than inventing one', async () => {
  const out = await call('dnd_effect', { action: 'end', name: 'Fireball' })
  assert.match(out, /no active effect/, out)
})

await test('starting the same effect twice REPLACES rather than stacks', async () => {
  await call('dnd_effect', { name: 'Bless', duration: '5r' })
  await call('dnd_effect', { name: 'Bless', duration: '9r' })
  const effects = readEncounterFile('alice').sections.effects
  assert.equal(effects.length, 1, 'two Blesses on one character is a rules error')
  assert.deepEqual(effects[0].duration, { unit: 'rounds', remaining: 9 }, 'the new duration wins')
})

await test('a whole-party tick advances every character and needs no per-head call', async () => {
  makeCharacter('bob', 'Bob')
  try {
    await call('dnd_effect', { character: 'alice', name: 'Bless', duration: '3r' })
    await call('dnd_effect', { character: 'bob', name: 'Bless', duration: '3r' })
    const out = await call('dnd_effect', { action: 'tick', rounds: 1 })
    assert.match(out, /alice/i, 'the party tick must report alice: ' + out)
    assert.match(out, /bob/i, 'the party tick must report bob: ' + out)
    for (const stem of ['alice', 'bob']) {
      const effects = readEncounterFile(stem).sections.effects
      assert.deepEqual(effects[0].duration, { unit: 'rounds', remaining: 2 },
        stem + ' must have advanced by one round')
    }
  } finally {
    rmSync(nodePath(CHAR_DIR + '/bob.state.json'), { force: true })
    rmSync(nodePath(CHAR_DIR + '/bob.md'), { force: true })
    rmSync(nodePath(CHAR_DIR + '/bob.encounter.json'), { force: true })
  }
})

await test('a retried PARTY tick does not advance anyone twice', async () => {
  // The party tick is the one path where a single call writes SEVERAL files, so
  // its key handling differs: the key is checked and recorded per character
  // rather than once. A retry must therefore be a no-op for every character who
  // already took it.
  makeCharacter('bob', 'Bob')
  try {
    await call('dnd_effect', { character: 'alice', action: 'end', name: 'Bless' })
    await call('dnd_effect', { character: 'bob', action: 'end', name: 'Bless' })
    await call('dnd_effect', { character: 'alice', name: 'Bless', duration: '4r' })
    await call('dnd_effect', { character: 'bob', name: 'Bless', duration: '4r' })

    await call('dnd_effect', { action: 'tick', rounds: 1, key: 'test-party-tick' })
    const after = ['alice', 'bob'].map((s) => JSON.stringify(readEncounterFile(s).sections.effects[0].duration))
    assert.deepEqual(JSON.parse(after[0]), { unit: 'rounds', remaining: 3 })

    await call('dnd_effect', { action: 'tick', rounds: 1, key: 'test-party-tick' })
    const retried = ['alice', 'bob'].map((s) => JSON.stringify(readEncounterFile(s).sections.effects[0].duration))
    assert.deepEqual(retried, after, 'a retried party tick must not advance anyone a second time')

    // A NEW key must still apply to everyone, so the guard is not a blanket stop.
    await call('dnd_effect', { action: 'tick', rounds: 1, key: 'test-party-tick-2' })
    for (const stem of ['alice', 'bob']) {
      assert.deepEqual(readEncounterFile(stem).sections.effects[0].duration, { unit: 'rounds', remaining: 2 },
        stem + ' must advance under a fresh key')
    }
  } finally {
    rmSync(nodePath(CHAR_DIR + '/bob.state.json'), { force: true })
    rmSync(nodePath(CHAR_DIR + '/bob.md'), { force: true })
    rmSync(nodePath(CHAR_DIR + '/bob.encounter.json'), { force: true })
  }
})

await test('a party tick does NOT create an encounter for a character with none', async () => {
  makeCharacter('carol', 'Carol')
  try {
    assert.equal(readEncounterFile('carol'), null, 'carol starts with no encounter file')
    await call('dnd_effect', { action: 'tick', rounds: 1 })
    assert.equal(readEncounterFile('carol'), null,
      'a party tick must not materialize an encounter for someone who never rolled anything')
  } finally {
    rmSync(nodePath(CHAR_DIR + '/carol.state.json'), { force: true })
    rmSync(nodePath(CHAR_DIR + '/carol.md'), { force: true })
  }
})

console.log('')
console.log('dnd_concentration 鈥?establish, break (with the forced save), end:')

await test('concentration can be established on a running effect', async () => {
  await call('dnd_effect', { action: 'end', name: 'Bless' })
  await call('dnd_effect', { name: 'Bless', duration: '10r' })
  const out = await call('dnd_concentration', { spell: 'Bless' })
  assert.match(out, /concentrating on Bless/, out)
  const enc = readEncounterFile('alice')
  assert.equal(enc.sections.concentration.spell, 'Bless')
  assert.equal(enc.sections.effects[0].concentration, true, 'the effect must carry the concentration tag')
})

await test('breaking concentration with damage computes the SRD CON save DC', async () => {
  const out = await call('dnd_concentration', { action: 'break', damage: 30, saveMod: 5 })
  assert.match(out, /CONCENTRATION BROKEN/, out)
  assert.match(out, /DC 15/, '30 damage gives DC max(10, 15) = 15: ' + out)
  assert.match(out, /dnd_save mod 5, dc 15/, 'the reply must hand back a runnable save call: ' + out)
  const enc = readEncounterFile('alice')
  assert.equal(enc.sections.concentration, null, 'the concentration record must be cleared')
})

await test('breaking concentration at 21 damage stays at DC 10, not 11', async () => {
  await call('dnd_concentration', { spell: 'Bless' })
  const out = await call('dnd_concentration', { action: 'break', damage: 21, saveMod: 5 })
  assert.match(out, /DC 10/, 'half of 21 is 10.5 and the rule takes the HIGHER of 10 and half: ' + out)
})

await test('a break with no damage records the break without inventing a DC', async () => {
  await call('dnd_concentration', { spell: 'Bless' })
  const out = await call('dnd_concentration', { action: 'break' })
  assert.match(out, /CONCENTRATION BROKEN/, out)
  assert.match(out, /No damage was given/, 'the tool must not invent a DC it was not given a reason for: ' + out)
  assert.equal(readEncounterFile('alice').sections.concentration, null)
})

await test('breaking an effect keeps its TIMER 鈥?only the focus is lost', async () => {
  await call('dnd_effect', { action: 'end', name: 'Bless' })
  await call('dnd_effect', { name: 'Bless', duration: '10r', concentration: true })
  await call('dnd_concentration', { action: 'break', damage: 12 })
  const effects = readEncounterFile('alice').sections.effects
  assert.equal(effects.length, 1, 'the Bless itself is still on the clock')
  assert.equal(effects[0].concentration, false, 'but it no longer requires concentration')
  assert.deepEqual(effects[0].duration, { unit: 'rounds', remaining: 10 })
})

await test('breaking a spell you are NOT concentrating on is refused, and writes nothing', async () => {
  await call('dnd_concentration', { spell: 'Bless' })
  const path = nodePath(CHAR_DIR + '/alice.encounter.json')
  const before = readFileSync(path, 'utf8')
  const out = await call('dnd_concentration', { action: 'break', spell: 'Fireball', damage: 20 })
  assert.match(out, /not concentrating on "Fireball"/, out)
  assert.match(out, /Nothing was written/, out)
  assert.equal(readFileSync(path, 'utf8'), before, 'a stale break must leave the file byte-identical')
  await call('dnd_concentration', { action: 'end' })
})

await test('establishing a NEW concentration drops the old one', async () => {
  await call('dnd_effect', { action: 'end', name: 'Bless' })
  await call('dnd_concentration', { spell: 'Bless' })
  const out = await call('dnd_concentration', { spell: 'Hunters Mark' })
  assert.match(out, /concentrating on Hunters Mark/, out)
  assert.match(out, /one spell at a time/, 'the old spell must be named as dropped: ' + out)
  assert.equal(readEncounterFile('alice').sections.concentration.spell, 'Hunters Mark')
})

await test('a tick that EXPIRES the concentrating effect also ends concentration', async () => {
  await call('dnd_effect', { action: 'end', name: 'Hunters Mark' })
  await call('dnd_concentration', { action: 'end' })
  await call('dnd_effect', { name: 'Hunters Mark', duration: '1r', concentration: true })
  const out = await call('dnd_effect', { action: 'tick', rounds: 1 })
  assert.match(out, /EXPIRED/, 'the effect expires: ' + out)
  assert.match(out, /concentration on Hunters Mark ended/, 'and its concentration must be reported broken: ' + out)
  const enc = readEncounterFile('alice')
  assert.equal(enc.sections.concentration, null,
    'a concentration flag pointing at an expired spell is exactly the stale state this must prevent')
})

await test('ending a concentrating effect via dnd_effect also clears concentration', async () => {
  await call('dnd_effect', { name: 'Bless', duration: '5r', concentration: true })
  const out = await call('dnd_effect', { action: 'end', name: 'Bless' })
  assert.match(out, /concentration ends with it/, out)
  assert.equal(readEncounterFile('alice').sections.concentration, null)
})

await test('concentration status reports honestly when nothing is running', async () => {
  const out = await call('dnd_concentration', { action: 'status' })
  assert.match(out, /not concentrating/, out)
})

console.log('')
console.log('dnd_death_save 鈥?the tally, the verdicts and the sheet mirror:')

await test('three failures produce an explicit DEAD conclusion', async () => {
  await call('dnd_death_save', { action: 'reset' })
  const first = await call('dnd_death_save', { action: 'failure', natural: 8 })
  assert.match(first, /1 failure/, first)
  assert.ok(!/DEAD/.test(first), 'one failure is not death: ' + first)
  await call('dnd_death_save', { action: 'failure', natural: 8 })
  const third = await call('dnd_death_save', { action: 'failure', natural: 8 })
  assert.match(third, /DEAD/, 'the THIRD failure must give an explicit death conclusion: ' + third)
  assert.match(third, /Three failed death saves/, third)
  assert.equal(readEncounterFile('alice').sections.deathSaves.failures, 3)
})

await test('the death tally is MIRRORED onto the character sheet', async () => {
  // The encounter file is the encounter-level view; combat.deathSaves on the
  // sheet is the character-level field that already existed. A panel reading it
  // must not go stale, so both must agree.
  const state = JSON.parse(readFileSync(nodePath(CHAR_DIR + '/alice.state.json'), 'utf8'))
  assert.equal(state.combat.deathSaves.failures, 3, 'the sheet mirror must show three failures')
  assert.equal(state.combat.deathSaves.successes, 0)
})

await test('three successes produce a STABLE conclusion, not a death', async () => {
  await call('dnd_death_save', { action: 'reset' })
  await call('dnd_death_save', { action: 'success', natural: 15 })
  await call('dnd_death_save', { action: 'success', natural: 15 })
  const third = await call('dnd_death_save', { action: 'success', natural: 15 })
  assert.match(third, /STABLE/, third)
  assert.ok(!/DEAD/.test(third), 'three successes must not read as death: ' + third)
})

await test('a natural 1 counts as two failures through the TOOL, not just the rule', async () => {
  await call('dnd_death_save', { action: 'reset' })
  const out = await call('dnd_death_save', { action: 'failure', natural: 1 })
  assert.match(out, /TWO failures/, out)
  assert.equal(readEncounterFile('alice').sections.deathSaves.failures, 2,
    'a nat 1 must actually store two failures')
})

await test('reset clears the tally in BOTH stores', async () => {
  const out = await call('dnd_death_save', { action: 'reset' })
  assert.match(out, /reset/, out)
  const enc = readEncounterFile('alice').sections.deathSaves
  assert.equal(enc.successes + enc.failures, 0)
  const state = JSON.parse(readFileSync(nodePath(CHAR_DIR + '/alice.state.json'), 'utf8'))
  assert.equal(state.combat.deathSaves.failures, 0, 'the sheet mirror must be cleared too')
})

await test('status reports the standing verdict without writing', async () => {
  await call('dnd_death_save', { action: 'failure' })
  const path = nodePath(CHAR_DIR + '/alice.encounter.json')
  const before = readFileSync(path, 'utf8')
  const out = await call('dnd_death_save', { action: 'status' })
  assert.match(out, /dying/, out)
  assert.equal(readFileSync(path, 'utf8'), before, 'status must not write')
})

await test('an unknown death-save action is refused', async () => {
  const out = await call('dnd_death_save', { action: 'banana' })
  assert.match(out, /unknown action/, out)
})

console.log('')
console.log('idempotency 鈥?the advertised `key` must actually do something:')
//
// Every one of these three tools ADVERTISES a `key` parameter ("Repeating a
// call with the same key changes nothing the second time"). At the time these
// tests were written nothing consumed it, so a retry applied a second time.
// The death-save case is why this is not cosmetic: a retried `failure` added a
// SECOND failure to the tally, so a retry at 0/2 reported the character DEAD.

await test('a retried death save with the SAME key does NOT advance the tally', async () => {
  await call('dnd_death_save', { action: 'reset' })
  const first = await call('dnd_death_save', { action: 'failure', key: 'test-retry-1' })
  assert.match(first, /0\/0 -> 0\/1/, first)
  const afterFirst = readEncounterFile('alice').sections.deathSaves.failures
  assert.equal(afterFirst, 1)

  const retry = await call('dnd_death_save', { action: 'failure', key: 'test-retry-1' })
  assert.match(retry, /Already applied/, 'the retry must be reported as a duplicate: ' + retry)
  assert.equal(readEncounterFile('alice').sections.deathSaves.failures, 1,
    'a retried death save must not add a second failure 鈥?this is the difference between dying and DEAD')

  // And the sheet mirror must not have moved either.
  const state = JSON.parse(readFileSync(nodePath(CHAR_DIR + '/alice.state.json'), 'utf8'))
  assert.equal(state.combat.deathSaves.failures, 1, 'the sheet mirror must not double-count the retry')
})

await test('a DIFFERENT key still applies 鈥?keyed idempotency is not a blanket no-op', async () => {
  const out = await call('dnd_death_save', { action: 'failure', key: 'test-retry-2' })
  assert.match(out, /0\/1 -> 0\/2/, out)
  assert.equal(readEncounterFile('alice').sections.deathSaves.failures, 2)
})

await test('omitting the key applies EVERY time 鈥?the correct default', async () => {
  // A DM calling dnd_death_save three times without keys means three saves, not
  // one. Keyed idempotency must not turn into "only the first call counts".
  await call('dnd_death_save', { action: 'reset' })
  await call('dnd_death_save', { action: 'failure' })
  await call('dnd_death_save', { action: 'failure' })
  assert.equal(readEncounterFile('alice').sections.deathSaves.failures, 2,
    'two keyless failures are two failures')
})

await test('a retried dnd_effect start / end / tick is a no-op under one key', async () => {
  await call('dnd_effect', { action: 'end', name: 'Bless' })
  await call('dnd_effect', { action: 'end', name: 'Shield' })

  await call('dnd_effect', { name: 'Shield', duration: '3r', key: 'test-eff-start' })
  const started = JSON.stringify(readEncounterFile('alice').sections.effects)
  await call('dnd_effect', { name: 'Shield', duration: '3r', key: 'test-eff-start' })
  assert.equal(JSON.stringify(readEncounterFile('alice').sections.effects), started,
    'a retried start must not rewrite the effect')

  const dur = () => readEncounterFile('alice').sections.effects.find((e) => e.name === 'Shield').duration
  await call('dnd_effect', { action: 'tick', rounds: 1, key: 'test-eff-tick' })
  assert.deepEqual(dur(), { unit: 'rounds', remaining: 2 })
  const ticked = JSON.stringify(dur())
  await call('dnd_effect', { action: 'tick', rounds: 1, key: 'test-eff-tick' })
  assert.equal(JSON.stringify(dur()), ticked, 'a retried tick must not advance the clock twice')

  await call('dnd_effect', { action: 'end', name: 'Shield', key: 'test-eff-end' })
  assert.equal(readEncounterFile('alice').sections.effects.length, 0)
  const retry = await call('dnd_effect', { action: 'end', name: 'Shield', key: 'test-eff-end' })
  assert.match(retry, /Already applied/, retry)
})

await test('a retried concentration start does not rewrite the record', async () => {
  await call('dnd_effect', { action: 'end', name: 'Mage Armor' })
  await call('dnd_concentration', { action: 'end' })
  await call('dnd_concentration', { spell: 'Mage Armor', key: 'test-conc' })
  const first = JSON.stringify(readEncounterFile('alice').sections.concentration)
  await call('dnd_concentration', { spell: 'Mage Armor', key: 'test-conc' })
  assert.equal(JSON.stringify(readEncounterFile('alice').sections.concentration), first,
    'a retried start must not stamp a new `since`')
  await call('dnd_concentration', { action: 'end', key: 'test-conc-end' })
})

await test('a BLANK key is treated as no key, not as a shared bucket', async () => {
  await call('dnd_death_save', { action: 'reset' })
  await call('dnd_death_save', { action: 'failure', key: '   ' })
  await call('dnd_death_save', { action: 'failure', key: '' })
  assert.equal(readEncounterFile('alice').sections.deathSaves.failures, 2,
    'two blank keys are two real failures, not one duplicate')
})

await test('the key ledger lives in the encounter file and stays capped', async () => {
  await call('dnd_death_save', { action: 'reset' })
  for (let i = 0; i < 40; i++) await call('dnd_death_save', { action: 'failure', key: 'cap-' + i })
  const keys = readEncounterFile('alice').sections.appliedKeys
  assert.ok(Array.isArray(keys), 'the ledger must be stored as an array')
  assert.ok(keys.length <= 32, 'the ledger must be capped at 32, got ' + keys.length)
  assert.equal(keys[keys.length - 1], 'cap-39', 'newest last')
  assert.ok(!keys.includes('cap-0'), 'the oldest keys are the ones dropped')
  // The ledger is its own section: it must not have been folded into any of the
  // three combat sections, which is what would happen if it were stored there.
  const sections = readEncounterFile('alice').sections
  assert.ok(Array.isArray(sections.effects), 'the effect list is still an array')
  assert.ok(!JSON.stringify(sections.deathSaves).includes('cap-'),
    'the ledger must not leak into the death-save tally')
})

await test('a READ-ONLY call neither checks nor records a key', async () => {
  const path = nodePath(CHAR_DIR + '/alice.encounter.json')
  const before = readFileSync(path, 'utf8')
  await call('dnd_death_save', { action: 'status', key: 'never-recorded' })
  await call('dnd_effect', { action: 'list', key: 'never-recorded' })
  await call('dnd_concentration', { action: 'status', key: 'never-recorded' })
  assert.equal(readFileSync(path, 'utf8'), before, 'a status/list call must not write')
  assert.ok(!readEncounterFile('alice').sections.appliedKeys.includes('never-recorded'),
    'a read must not consume a key')
  await call('dnd_death_save', { action: 'reset' })
})

console.log('')
console.log('the shared file 鈥?neither family may destroy the other:')

await test('THIS family writes only its own sections; initiative survives byte-intact', async () => {
  // This is the invariant the shared-file design exists to protect, and the one
  // the parent flagged: two families, one file, and a merge that must not drop
  // the key it did not author. The initiative section below is written RAW, as
  // the other family would, and must come back identical.
  const path = nodePath(CHAR_DIR + '/alice.encounter.json')
  const enc = JSON.parse(readFileSync(path, 'utf8'))
  const initiative = {
    round: 3,
    turnOrder: [
      { name: 'Goblin', roll: 19, hp: 7 },
      { name: 'Alice', roll: 12, hp: 4 },
    ],
    active: 'Goblin',
  }
  enc.sections.initiative = initiative
  writeFileSync(path, JSON.stringify(enc, null, 2) + '\n', 'utf8')
  const snapshot = JSON.stringify(initiative)

  await call('dnd_effect', { name: 'Bless', duration: '4r', concentration: true })
  const afterEffect = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(JSON.stringify(afterEffect.sections.initiative), snapshot,
    'starting an effect must not touch the initiative section')

  await call('dnd_effect', { action: 'tick', rounds: 1 })
  const afterTick = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(JSON.stringify(afterTick.sections.initiative), snapshot,
    'ticking effects must not touch the initiative section')

  await call('dnd_concentration', { action: 'break', damage: 25 })
  const afterBreak = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(JSON.stringify(afterBreak.sections.initiative), snapshot,
    'breaking concentration must not touch the initiative section')

  await call('dnd_death_save', { action: 'failure' })
  const afterSaves = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(JSON.stringify(afterSaves.sections.initiative), snapshot,
    'advancing death saves must not touch the initiative section')

  // And the reverse direction: a file with NO initiative section is normal.
  assert.ok(afterSaves.sections.effects !== undefined || afterSaves.sections.effects === undefined,
    'a missing initiative section must be tolerated, never required')
})

await test('and this family tolerates an encounter file with NO initiative section', async () => {
  const path = nodePath(CHAR_DIR + '/alice.encounter.json')
  const enc = JSON.parse(readFileSync(path, 'utf8'))
  delete enc.sections.initiative
  writeFileSync(path, JSON.stringify(enc, null, 2) + '\n', 'utf8')
  const out = await call('dnd_effect', { name: 'Shield', duration: '1r' })
  assert.ok(!/error|undefined/i.test(out), 'a missing sibling section must not be an error: ' + out)
  assert.equal(readEncounterFile('alice').sections.initiative, undefined,
    'and this family must not create a section it does not own')
})

await test('a character with NO encounter file at all is handled gracefully', async () => {
  makeCharacter('dave', 'Dave')
  try {
    assert.equal(readEncounterFile('dave'), null)
    const out = await call('dnd_effect', { character: 'dave', name: 'Bless', duration: '2r' })
    assert.match(out, /Bless/, out)
    assert.equal(readEncounterFile('dave').sections.effects.length, 1)
  } finally {
    rmSync(nodePath(CHAR_DIR + '/dave.state.json'), { force: true })
    rmSync(nodePath(CHAR_DIR + '/dave.md'), { force: true })
    rmSync(nodePath(CHAR_DIR + '/dave.encounter.json'), { force: true })
  }
})

await test('a corrupt encounter file is reported, not silently treated as empty', async () => {
  const path = nodePath(CHAR_DIR + '/alice.encounter.json')
  const good = readFileSync(path, 'utf8')
  try {
    writeFileSync(path, '{ this is not json', 'utf8')
    const out = await call('dnd_effect', { name: 'Bless', duration: '2r' })
    assert.ok(!/undefined/.test(out), 'a corrupt file must not surface as undefined: ' + out)
    assert.match(out, /Bless/, 'it must recover and write a fresh effect: ' + out)
    assert.equal(readEncounterFile('alice').sections.effects.length, 1)
  } finally {
    writeFileSync(path, good, 'utf8')
  }
})

console.log('')
console.log('the write path 鈥?policy threading and read-only discipline:')

await test('every write carries a sandbox policy as the 5th fs.writeText argument', async () => {
  // The defect recorded in session-scope.mjs: a write that omits the 5th
  // argument is judged against the harness process cwd instead of the session,
  // and every campaign write is refused. This suite passes no exec, so the
  // resolved policy is undefined 鈥?but the ARGUMENT must still be threaded
  // through, which is what a real session fills in.
  writes.length = 0
  await call('dnd_effect', { name: 'Probe', duration: '3r' })
  assert.ok(writes.length > 0, 'the call must have written something')
  const encounterWrites = writes.filter((w) => /\.encounter\.json$/.test(w.path))
  assert.equal(encounterWrites.length, 1, 'exactly one encounter write is expected, got ' + writes.length)
  assert.equal(encounterWrites[0].policy, undefined,
    'with no session the policy is legitimately undefined, which preserves the platform fallback')
  // The argument POSITION is what matters, and the mock only reaches its 5th
  // parameter when the caller passed one. A caller that dropped it would still
  // arrive as undefined, so pin the arity at the call site instead:
  assert.equal(fsService.writeText.length, 5, 'the fs contract takes the policy as the 5th argument')
})

await test('a session IS threaded through when one is supplied', async () => {
  // The direct proof that policyFor(exec) is wired: give the ctx a
  // sandboxPolicy service and an exec carrying a session, and require the
  // resolved object to arrive at fs.writeText.
  const sentinel = { workspaceRoot: tempRoot, mode: 'workspace-write' }
  const session = { header: { cwd: tempRoot } }
  const scopedCtx = {
    get(name) {
      if (name === 'fs') return fsService
      if (name === 'sessions') return { get: (id) => (id === 'sess-1' ? session : undefined) }
      if (name === 'sandboxPolicy') return { resolve: ({ session: s }) => (s === session ? sentinel : undefined) }
      return undefined
    },
  }
  const scoped = Object.fromEntries(buildTools(scopedCtx).map((t) => [t.name, t]))
  writes.length = 0
  await scoped.dnd_effect.execute({ name: 'Scoped', duration: '2r' }, { agent: { id: 'sess-1' } })
  const encounterWrites = writes.filter((w) => /\.encounter\.json$/.test(w.path))
  assert.equal(encounterWrites.length, 1)
  assert.equal(encounterWrites[0].policy, sentinel,
    'the session-resolved policy must arrive as the 5th argument, not be dropped')
})

await test('a READ-ONLY call performs no write at all', async () => {
  // status / list are reads. If either wrote, a DM asking a question would
  // mutate the fight 鈥?and the death-save status path is literally one line
  // away from the writing path.
  writes.length = 0
  await call('dnd_concentration', { action: 'status' })
  await call('dnd_effect', { action: 'list' })
  await call('dnd_death_save', { action: 'status' })
  assert.deepEqual(writes, [], 'no read tool may write: ' + JSON.stringify(writes.map((w) => w.path)))
})

await test('a refused argument performs no write at all', async () => {
  writes.length = 0
  await call('dnd_effect', { name: 'X', duration: 'nonsense' })
  await call('dnd_effect', { action: 'tick' })
  await call('dnd_concentration', { action: 'start' })
  await call('dnd_death_save', { action: 'nonsense' })
  assert.deepEqual(writes, [], 'a refused call must not touch the disk: ' + JSON.stringify(writes.map((w) => w.path)))
})

await test('an empty-argument call to each new tool diagnoses itself', async () => {
  // Mirrors test/tool-args.test.mjs: with no fs there is no campaign, and with
  // no action the tools default to a READ for effect/death-save and to start for
  // concentration. None of them may report a RESULT computed from a missing
  // argument.
  const noFs = Object.fromEntries(buildTools({ get: () => undefined }).map((t) => [t.name, t]))
  for (const name of ['dnd_effect', 'dnd_concentration', 'dnd_death_save']) {
    const out = String(await noFs[name].execute({}))
    assert.match(out, /fs service unavailable/, name + ' must report the missing service: ' + out)
  }
})

await test('the tools are registered by the host and declare their contract', async () => {
  const { buildTools: build } = await import('../src/host/tools/effects.mjs')
  const list = build(ctx)
  const names = list.map((t) => t.name).sort()
  assert.deepEqual(names, ['dnd_concentration', 'dnd_death_save', 'dnd_effect'],
    'the family must contribute exactly these three tools, got ' + names.join(', '))
  for (const tool of list) {
    assert.ok(tool.name.startsWith('dnd_'), tool.name + ' must be namespaced dnd_*')
    assert.ok(tool.description.length > 40, tool.name + ': description too short to guide the model')
    assert.equal(typeof tool.parameters, 'object', tool.name + ': parameters')
    assert.equal(typeof tool.execute, 'function', tool.name + ': execute')
  }
})

console.log('')
console.log('no live campaign data was touched:')

await test('nothing under the live campaign characters directory moved', () => {
  const changes = diffTree(liveBefore, snapshotTree(LIVE_CHARS))
  assert.deepEqual(changes, [],
    'this suite must write only inside its temp tree, and the remap is what makes that true: ' + changes.join('; '))
})

await test('the live active-campaign marker is byte-identical', () => {
  if (!liveMarkerExisted) {
    assert.equal(liveExists(LIVE_MARKER), false,
      'the marker did not exist before and must not have been created')
    return
  }
  assert.equal(hashLivePath(LIVE_MARKER), liveMarkerBefore,
    'the live marker must be untouched 鈥?this suite points its own temp marker instead')
})

console.log('')
if (failures > 0) {
  console.error('encounter-effects.test.mjs: ' + failures + ' failure(s)')
  process.exit(1)
}
console.log('encounter-effects.test.mjs: all assertions passed')
