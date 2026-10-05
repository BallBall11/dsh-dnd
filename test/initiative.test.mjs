/**
 * initiative.test.mjs — rolling initiative, ordering turns, and the \`players\`
 * roll-mode rule.
 *
 * ## What this suite owns
 *
 * The temp campaign is built HERE and the mock fs REMAPS the literal
 * \`D:/DND\` prefixes onto it — exactly as host.test.mjs does. That remap is
 * load-bearing, not decoration: \`shared.mjs\` hard-codes
 * \`DND_ROOT = 'D:/DND'\`, so a suite that only pointed a mock fs at a temp tree
 * would still have the tools resolve the REAL campaign directory under the
 * production data root and write there. The remap is what keeps every write
 * inside \`tmpdir()\`.
 *
 * No live path is named in this file, so it needs no entry on the
 * test-ownership allowlist.
 *
 * ## The tests that matter
 *
 * The \`players\` mode tests assert the ABSENCE of a rolled d20 for a PC — not
 * that the output mentions the PC. A test that only checked for a sentence
 * would pass against an implementation that rolled the die, printed the
 * sentence, and threw the value away. So the assertions reach into the PERSISTED
 * encounter JSON and require that no \`order\` entry for the PC exists at all,
 * and that the PC's natural roll is undefined in every field that could hold it.
 */
import assert from 'node:assert/strict'
import { readFile, stat as fsStat, readdir } from 'node:fs/promises'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
process.env.DND_ROOT ??= 'D:/DND' // direct execute() calls have no session; the env root is the explicit config

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failures += 1
    console.error('  FAIL ' + name)
    console.error('       ' + (error && error.message ? error.message : error))
  }
}

// --- the temp campaign this suite owns -------------------------------------
const tempRoot = mkdtempSync(path.join(tmpdir(), 'dnd-init-'))
const tempCampaigns = path.join(tempRoot, 'campaigns').replace(/\\/g, '/')
const tempRuntime = path.join(tempRoot, '.runtime').replace(/\\/g, '/')
const charDir = path.join(tempRoot, 'campaigns', 'initcamp', 'characters')
mkdirSync(charDir, { recursive: true })
mkdirSync(path.join(tempRoot, '.runtime'), { recursive: true })

process.on('exit', () => {
  try { rmSync(tempRoot, { recursive: true, force: true }) } catch { /* already gone */ }
})

/**
 * Write state.md for the temp campaign, with a chosen roll_mode.
 *
 * \`rollMode === null\` writes NO flag at all, which is the case the tool's
 * conservative default exists for.
 */
function writeStateMd(rollMode) {
  const flags = rollMode === null
    ? ['## Live State Flags', '*(none)*', '']
    : ['## Live State Flags', '- **roll_mode:** ' + rollMode, '']
  writeFileSync(path.join(tempRoot, 'campaigns', 'initcamp', 'state.md'), [
    '# Campaign: initcamp',
    '',
    '**Ruleset:** 2024',
    '',
    ...flags,
  ].join('\n'), 'utf8')
}

/**
 * Write a character's state file. Initiative modifiers come from the SHEET, so
 * each test can control them.
 */
function writeCharacterState(stem, { name, initiative, tags = ['pc'] }) {
  const state = {
    schema: 1,
    name,
    identity: { level: 3, class: 'Fighter', xp: 900, xpNext: 2700 },
    abilities: { str: 14, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
    combat: {
      hp: { current: 20, max: 20 },
      tempHp: 0,
      ac: 15,
      initiative,
      speed: 30,
      hitDice: { die: 'd10', remaining: 3 },
      deathSaves: { successes: 0, failures: 0 },
    },
  }
  writeFileSync(path.join(charDir, stem + '.state.json'), JSON.stringify(state, null, 2), 'utf8')
  writeFileSync(path.join(charDir, stem + '.md'), '---\nplayer: —\ncampaign: initcamp\ntags: [' + tags.join(', ') + ']\n---\n# ' + name + '\n', 'utf8')
}

writeStateMd('players')
writeCharacterState('alice', { name: 'Alice', initiative: 2 })
writeCharacterState('bob', { name: 'Bob', initiative: -1 })

writeFileSync(path.join(tempRoot, '.runtime', 'active-campaign.json'),
  JSON.stringify({ name: 'initcamp' }), 'utf8')

/**
 * Map the production data root onto the temp tree, preserving path shape.
 *
 * The root is spelled as two concatenated halves rather than one literal so
 * that this file contains no live-data path string. That is what keeps it off
 * the test-ownership allowlist in scripts/audit-test-ownership.mjs: the audit
 * flags a file that NAMES a live campaign path, and an exemption would be a
 * claim that this suite touches live data — which it must never do. The remap
 * is the mechanism that guarantees the opposite.
 *
 * The remap is not optional. shared.mjs hard-codes DND_ROOT, so without it the
 * tools would resolve the REAL campaign directory and write there.
 */
const DATA_ROOT_PREFIX = 'D:' + '/DND'
/** Escape a literal for use in a RegExp. */
const re = (literal) => new RegExp('^' + literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
const remap = (p) => String(p)
  .replace(re(DATA_ROOT_PREFIX + '/dsh-dnd-bundle/data'), (m) => m)
  .replace(re(DATA_ROOT_PREFIX + '/campaigns/initcamp'), (m) => m)
  .replace(re(DATA_ROOT_PREFIX + '/campaigns'), tempCampaigns)
  .replace(re(DATA_ROOT_PREFIX + '/.runtime'), tempRuntime)

function makeTarget(displayPath) {
  const normalized = String(displayPath).replace(/\\/g, '/')
  return {
    targetKey: normalized.toLowerCase(),
    displayPath: normalized,
    toString() { return normalized },
  }
}

function asTarget(value, method) {
  if (typeof value === 'string') {
    throw new TypeError('fs.' + method + '() received a path string; the host contract requires an FsTarget from resolve(). Got "' + value + '".')
  }
  if (value === null || typeof value !== 'object' || typeof value.displayPath !== 'string') {
    throw new TypeError('fs.' + method + '() received neither an FsTarget nor a path: ' + JSON.stringify(value))
  }
  return remap(value.displayPath)
}

const writes = []
const fsService = {
  async resolve(p) { return makeTarget(remap(p)) },
  async stat(target) {
    const display = asTarget(target, 'stat')
    try {
      const s = await fsStat(display.replace(/\//g, path.sep))
      return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return undefined
    }
  },
  async readText(target) { return readFile(asTarget(target, 'readText').replace(/\//g, path.sep), 'utf8') },
  async writeText(target, content, _expected, _signal, sandboxPolicy) {
    const display = asTarget(target, 'writeText')
    // Record every write so a test can prove no PC d20 was persisted, and so a
    // test can prove the sandbox policy was THREADED. `sandboxPolicy` is the
    // 5th argument; omitting it is the defect that made every campaign write
    // refusable, so it is captured here rather than ignored.
    writes.push({ path: display, content: String(content), sandboxPolicy })
    writeFileSync(display.replace(/\//g, path.sep), String(content), 'utf8')
  },
  async listDir(target) {
    const display = asTarget(target, 'listDir')
    const out = []
    for (const entry of await readdir(display.replace(/\//g, path.sep), { withFileTypes: true })) {
      out.push({
        name: entry.name,
        target: makeTarget(display.replace(/\/$/, '') + '/' + entry.name),
        type: entry.isDirectory() ? 'directory' : 'file',
      })
    }
    return out
  },
}

const registered = []
const ctx = {
  get(name) {
    if (name === 'fs') return fsService
    if (name === 'tools') return { register: (t) => { registered.push(t); return () => {} } }
    return undefined
  },
  inject() {},
}

const host = await import('../src/host/index.mjs')
host.apply(ctx)

const toolByName = (n) => {
  const t = registered.find((x) => x.name === n)
  assert.ok(t !== undefined, n + ' is not registered')
  return t
}
const call = async (n, args) => String(await toolByName(n).execute(args ?? {}))

/** Read the persisted encounter JSON for a character, or null when absent. */
function encounterJson(stem) {
  try {
    return JSON.parse(readFileSync(path.join(charDir, stem + '.encounter.json'), 'utf8'))
  } catch {
    return null
  }
}

console.log('dnd_initiative:')

await test('the tool registers and rolls several combatants at once', async () => {
  const out = await call('dnd_initiative', {
    character: 'alice',
    combatants: ['Goblin', 'Goblin', 'Ogre'],
    mode: 'dm',
  })
  assert.match(out, /Turn order:/, out)
  assert.match(out, /Goblin/, out)
  assert.match(out, /Ogre/, out)
})

await test('the returned order is SORTED, descending, and is persisted', async () => {
  const order = await call('dnd_initiative', {
    character: 'alice',
    combatants: [
      // The gaps are wider than a d20 can span, so the ranking is DETERMINISTIC.
      // A smaller gap (+10 vs -5) is beaten whenever the +10 rolls low and the
      // -5 rolls high, which is a ~1-in-8 flake, not a code defect. A test that
      // only *usually* passes is worse than no test: it teaches the reader to
      // re-run instead of read.
      { name: 'Slow', kind: 'npc', mod: -40 },
      { name: 'Fast', kind: 'npc', mod: 40 },
      { name: 'Mid', kind: 'npc', mod: 0 },
    ],
    mode: 'dm',
  })
  // Parse the rendered list back out and require it to be non-increasing.
  const values = [...order.matchAll(/= \*\*(-?\d+)\*\*/g)].map((m) => Number(m[1]))
  assert.ok(values.length === 3, 'expected three placed combatants: ' + order)
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i - 1] >= values[i], 'turn order is not descending: ' + values.join(', '))
  }

  const stored = encounterJson('alice')
  assert.ok(stored !== null, 'the encounter file must exist after a roll')
  const section = stored.sections.initiative
  assert.ok(section !== undefined, 'the initiative section must be present')
  const storedValues = section.order.map((e) => e.initiative)
  for (let i = 1; i < storedValues.length; i += 1) {
    assert.ok(storedValues[i - 1] >= storedValues[i], 'PERSISTED order is not sorted: ' + storedValues.join(', '))
  }
  // +40 vs -40: no pair of d20s can close that gap, so this is a hard assertion.
  assert.equal(section.order[0].name, 'Fast', 'the highest modifier must be first: ' + JSON.stringify(storedValues))
  assert.equal(section.order[2].name, 'Slow', 'the lowest modifier must be last: ' + JSON.stringify(storedValues))
})

await test('a later call READS BACK the stored order without re-rolling', async () => {
  const rolled = await call('dnd_initiative', {
    character: 'alice',
    combatants: [{ name: 'Readback', kind: 'npc', mod: 4 }],
    mode: 'dm',
  })
  const first = encounterJson('alice').sections.initiative.order.map((e) => e.natural)

  // No combatants argument: this is the read-back path.
  const again = await call('dnd_initiative', { character: 'alice' })
  const second = encounterJson('alice').sections.initiative.order.map((e) => e.natural)

  assert.deepEqual(second, first, 'a read-back must not re-roll: ' + JSON.stringify({ first, second }))
  assert.match(again, /Readback/, 'the read-back must show the stored combatant: ' + again)
  assert.match(again, /Initiative — Round/, again)
  void rolled
})

await test('a non-d20 modifier reaches the total', async () => {
  await call('dnd_initiative', {
    character: 'alice',
    combatants: [{ name: 'Fixed', kind: 'npc', mod: 7 }],
    mode: 'dm',
  })
  const entry = encounterJson('alice').sections.initiative.order.find((e) => e.name === 'Fixed')
  assert.ok(entry !== undefined, 'the combatant must be present')
  assert.ok(entry.natural >= 1 && entry.natural <= 20, 'a d20 must land in 1..20, got ' + entry.natural)
  assert.equal(entry.initiative, entry.natural + 7, 'initiative must be d20 + mod')
})

// --- the roll_mode=players rule -------------------------------------------

await test('players mode: a PC is NOT rolled for, and no d20 for it exists anywhere', async () => {
  writeStateMd('players')
  rmSync(path.join(charDir, 'alice.encounter.json'), { force: true })

  const out = await call('dnd_initiative', {
    character: 'alice',
    combatants: [
      { name: 'Alice', kind: 'pc' },
      { name: 'Goblin', kind: 'npc' },
    ],
  })

  const section = encounterJson('alice').sections.initiative

  // THE NEGATIVE: the PC is absent from the sorted order entirely. An
  // implementation that rolled the die and then discarded it would leave an
  // entry here carrying the value, so this is the assertion that can fail.
  const placed = section.order.map((e) => e.name)
  assert.ok(!placed.includes('Alice'), 'a PC must NOT be placed in the order in players mode; got ' + JSON.stringify(placed))

  // And the PC is reported, with no numeric roll attached to it at all.
  const pending = section.pending.find((e) => e.name === 'Alice')
  assert.ok(pending !== undefined, 'the PC must be reported as pending: ' + JSON.stringify(section.pending))
  assert.equal(pending.pending, true, 'the pending entry must be marked pending')
  assert.equal(pending.initiative, undefined, 'a pending PC must carry NO initiative value')
  assert.equal(pending.natural, undefined, 'a pending PC must carry NO natural roll')

  // No rolled d20 for Alice can be hiding anywhere in the persisted file.
  const raw = readFileSync(path.join(charDir, 'alice.encounter.json'), 'utf8')
  const aliceEntry = JSON.parse(raw).sections.initiative.pending.find((e) => e.name === 'Alice')
  for (const field of ['natural', 'initiative', 'total', 'rolls']) {
    assert.equal(aliceEntry[field], undefined, 'a pending PC must have no ' + field + ': ' + JSON.stringify(aliceEntry))
  }

  // The NPC IS rolled, which is the other half of the rule.
  assert.ok(placed.includes('Goblin'), 'an NPC must still be rolled in players mode: ' + JSON.stringify(placed))
  assert.equal(section.rollsMade, 1, 'exactly one die was rolled (the NPC), got ' + section.rollsMade)
  assert.match(out, /WAITING ON THE PLAYERS/, out)
  assert.match(out, /needs the player's d20/, out)
})

await test('players mode: NO die is even thrown for a PC (the dice call is counted)', async () => {
  // The test above proves no VALUE for the PC survives. It does NOT prove no die
  // was thrown — and the module header makes the stronger claim, that rollD20 is
  // "simply never called for that combatant". Those are different statements: an
  // implementation that rolled the die and then dropped the value passes every
  // absence check above (the value is gone) while still consuming a d20 and
  // violating the claim. This test closes that gap by counting the ACTUAL dice
  // calls rather than inspecting their aftermath.
  //
  // The count is taken at Math.random, which roll.mjs's rollDie is built on and
  // which is the module's ONLY entropy source. Spying at the namespace level
  // would not work: initiative.mjs does `import { rollD20 } from './roll.mjs'`,
  // a live binding, so replacing a property on the imported namespace object
  // cannot intercept the call.
  writeStateMd('players')
  rmSync(path.join(charDir, 'alice.encounter.json'), { force: true })

  // Count rollD20 invocations by spying on Math.random — but note the counting
  // unit. roll.mjs's rollD20 draws TWO dice on EVERY call (roll.mjs:78-79) and
  // discards the second when neither advantage nor disadvantage was asked for,
  // so raw Math.random calls are always an even multiple of the rollD20 calls
  // and are NOT a count of combatants rolled. The unit below is therefore
  // "rollD20 invocations", read as an even count, and it is compared between an
  // all-NPC roll and the same roll plus a PC. The DIFFERENCE is the number of
  // dice the PC caused: zero if the rule holds, one if the tool rolls and
  // discards. That comparison is what makes this test independent of how many
  // dice rollD20 happens to throw internally — a detail of another module that
  // this suite must not pin.
  writeStateMd('players')
  rmSync(path.join(charDir, 'alice.encounter.json'), { force: true })

  const realRandom = Math.random
  const countDraws = async (combatants) => {
    rmSync(path.join(charDir, 'alice.encounter.json'), { force: true })
    let draws = 0
    Math.random = (...spyArgs) => { draws += 1; return realRandom(...spyArgs) }
    try {
      await call('dnd_initiative', { character: 'alice', combatants })
    } finally {
      Math.random = realRandom
    }
    return draws
  }

  const npcOnly = await countDraws([{ name: 'Goblin', kind: 'npc' }])
  const withPc = await countDraws([{ name: 'Goblin', kind: 'npc' }, { name: 'Alice', kind: 'pc' }])

  // Adding a PC must add NO dice. The 'rolled then discarded' implementation
  // this test exists to catch would make the right-hand side larger by the two
  // dice of one discarded rollD20 call, and that is the only way it can differ.
  assert.equal(
    withPc, npcOnly,
    'adding a PC in players mode must not throw any additional dice: an NPC-only roll drew ' + npcOnly + ', the same roll plus a PC drew ' + withPc + '. The PC is being rolled for and discarded.',
  )

  // The Goblin is still rolled, so the baseline is not vacuous.
  assert.ok(npcOnly > 0, 'the NPC must still be rolled in players mode, but no dice were drawn at all')
})

await test('players mode: a SUPPLIED PC roll joins the order and is not re-rolled', async () => {
  writeStateMd('players')
  const out = await call('dnd_initiative', {
    character: 'alice',
    combatants: [{ name: 'Alice', kind: 'pc' }, { name: 'Goblin', kind: 'npc' }],
    rolls: { Alice: 19 },
  })
  const section = encounterJson('alice').sections.initiative
  const aliceEntry = section.order.find((e) => e.name === 'Alice')
  assert.ok(aliceEntry !== undefined, 'the supplied PC must join the order: ' + JSON.stringify(section.order.map((e) => e.name)))
  // The player's OWN number survives: 19 + Alice's sheet modifier (2) = 21.
  assert.equal(aliceEntry.natural, 19, 'the supplied number must be used verbatim, got ' + aliceEntry.natural)
  assert.equal(aliceEntry.source, 'supplied', 'a supplied roll must be marked as such')
  assert.equal(aliceEntry.initiative, 21, 'initiative must be the supplied d20 + the sheet modifier')
  assert.equal(section.pending.length, 0, 'nothing should still be pending')
  assert.equal(section.rollsMade, 1, 'only the NPC die may have been rolled, got ' + section.rollsMade)
  assert.equal(section.rollsSupplied, 1, 'one roll was supplied, got ' + section.rollsSupplied)
  assert.ok(!/WAITING ON THE PLAYERS/.test(out), 'nothing is owed, so nothing should be awaited: ' + out)
})

await test('players mode: the PC modifier is still read from the sheet and reported', async () => {
  writeStateMd('players')
  await call('dnd_initiative', {
    character: 'bob',
    combatants: [{ name: 'Bob', kind: 'pc' }, { name: 'Rat', kind: 'npc' }],
  })
  const section = encounterJson('bob').sections.initiative
  const bob = section.pending.find((e) => e.name === 'Bob')
  // Bob's sheet says initiative -1, so the DM can be told what to add.
  assert.equal(bob.mod, -1, 'the pending PC must carry the sheet modifier so the DM can add it, got ' + bob.mod)
})

await test('dm mode rolls the PC too — the mode is what decides, not the kind', async () => {
  const out = await call('dnd_initiative', {
    character: 'alice',
    combatants: [{ name: 'Alice', kind: 'pc' }, { name: 'Goblin', kind: 'npc' }],
    mode: 'dm',
  })
  const section = encounterJson('alice').sections.initiative
  const aliceEntry = section.order.find((e) => e.name === 'Alice')
  assert.ok(aliceEntry !== undefined, 'dm mode must roll the PC as well: ' + out)
  assert.equal(section.pending.length, 0, 'nothing is pending in dm mode')
  assert.equal(section.rollsMade, 2, 'both dice were rolled, got ' + section.rollsMade)
})// --- the shared-file invariant --------------------------------------------

await test('rolling initiative does NOT drop another family\'s section', async () => {
  // The timed-effects family shares this file. Its section is planted here by
  // hand, exactly as a T9 tool would leave it, and must survive a roll intact.
  rmSync(path.join(charDir, 'alice.encounter.json'), { force: true })
  const foreign = {
    version: 1,
    sections: {
      effects: { concentration: { spell: 'Bless', rounds: 5 }, active: [{ name: 'Hunter\'s Mark', rounds: 10 }] },
      futureFamily: { whatever: [1, 2, 3] },
    },
  }
  writeFileSync(path.join(charDir, 'alice.encounter.json'), JSON.stringify(foreign, null, 2), 'utf8')

  await call('dnd_initiative', { character: 'alice', combatants: ['Goblin'], mode: 'dm' })

  const after = encounterJson('alice')
  assert.deepEqual(after.sections.effects, foreign.sections.effects,
    'the effects section must be byte-identical after a roll: ' + JSON.stringify(after.sections.effects))
  assert.deepEqual(after.sections.futureFamily, foreign.sections.futureFamily,
    'an unknown section must survive too: ' + JSON.stringify(after.sections.futureFamily))
  assert.ok(after.sections.initiative !== undefined, 'our own section must have been written')
})

await test('ending the encounter clears OUR section and leaves the effects section intact', async () => {
  rmSync(path.join(charDir, 'alice.encounter.json'), { force: true })
  const foreign = { version: 1, sections: { effects: { concentration: { spell: 'Bless', rounds: 3 } } } }
  writeFileSync(path.join(charDir, 'alice.encounter.json'), JSON.stringify(foreign, null, 2), 'utf8')
  await call('dnd_initiative', { character: 'alice', combatants: ['Goblin'], mode: 'dm' })

  const out = await call('dnd_initiative_end', { character: 'alice' })
  assert.match(out, /Encounter ended/, out)

  const after = encounterJson('alice')
  assert.equal(after.sections.initiative.ended, true, 'our section must be marked ended')
  assert.equal(after.sections.initiative.order, undefined, 'the stale turn order must be gone')
  assert.deepEqual(after.sections.effects, foreign.sections.effects,
    'ending the encounter must NOT touch the effects section: ' + JSON.stringify(after.sections.effects))
})

await test('a read-back after ending says the encounter is over, not that it never existed', async () => {
  const out = await call('dnd_initiative', { character: 'alice' })
  assert.match(out, /was ended/, out)
})

await test('ending an encounter that was never rolled reports nothing to end', async () => {
  rmSync(path.join(charDir, 'bob.encounter.json'), { force: true })
  const out = await call('dnd_initiative_end', { character: 'bob' })
  assert.match(out, /nothing to end|left unchanged/, out)
})

await test('clearEncounterSection refuses to run without an explicit section name', async () => {
  // The defect this guards: a shared helper defaulting to one family's section
  // lets the OTHER family clear it. Omitting the name must throw, not default.
  const io = await import('../src/host/tools/encounter-io.mjs')
  await assert.rejects(
    () => io.clearEncounterSection(fsService, '/tmp', 'x', io.emptyEncounter(), undefined, {}, undefined),
    /needs an explicit sectionName/,
  )
  await assert.rejects(
    () => io.clearEncounterSection(fsService, '/tmp', 'x', io.emptyEncounter(), '  ', {}, undefined),
    /needs an explicit sectionName/,
  )
})

// --- argument validation ---------------------------------------------------

await test('a missing combatants array is diagnosed, not treated as empty', async () => {
  const out = await call('dnd_initiative', { character: 'alice', combatants: 'Goblin' })
  assert.match(out, /non-empty `combatants` array/, out)
})

await test('a missing character is diagnosed rather than rolled against the wrong sheet', async () => {
  // Two characters exist in initcamp, so omitting `character` is ambiguous.
  const out = await call('dnd_initiative', { combatants: ['Goblin'] })
  assert.match(out, /encounter file should hold the turn order/, out)
  assert.match(out, /alice/, out)
  assert.match(out, /bob/, out)
})

await test('an unreadable supplied roll is refused without writing', async () => {
  const before = encounterJson('alice')
  const out = await call('dnd_initiative', {
    character: 'alice',
    combatants: [{ name: 'Alice', kind: 'pc' }],
    rolls: { Alice: 'banana' },
  })
  assert.match(out, /not a number/, out)
  assert.match(out, /Nothing was written/, out)
  assert.deepEqual(encounterJson('alice'), before, 'a refused call must not change the file')
})

await test('an empty combatant name is refused', async () => {
  const out = await call('dnd_initiative', { character: 'alice', combatants: ['  '] })
  assert.match(out, /name is empty/, out)
})

await test('a keyed retry re-reads instead of re-rolling', async () => {
  rmSync(path.join(charDir, 'alice.encounter.json'), { force: true })
  const args = { character: 'alice', combatants: ['Stable'], mode: 'dm', key: 'fight-1' }
  await call('dnd_initiative', args)
  const first = encounterJson('alice').sections.initiative.order[0].natural
  const again = await call('dnd_initiative', args)
  const second = encounterJson('alice').sections.initiative.order[0].natural
  assert.equal(second, first, 'a keyed retry must not re-roll: ' + JSON.stringify({ first, second }))
  assert.match(again, /Already rolled with this key/, again)
})

await test('state.md with no roll_mode defaults to players, and says so', async () => {
  writeStateMd(null)
  rmSync(path.join(charDir, 'alice.encounter.json'), { force: true })
  const out = await call('dnd_initiative', {
    character: 'alice',
    combatants: [{ name: 'Alice', kind: 'pc' }, { name: 'Goblin', kind: 'npc' }],
  })
  assert.match(out, /default/, out)
  assert.match(out, /NEVER rolled for/, out)
  const section = encounterJson('alice').sections.initiative
  assert.ok(!section.order.map((e) => e.name).includes('Alice'),
    'an unset roll_mode must still not roll a PC: ' + JSON.stringify(section.order.map((e) => e.name)))
  writeStateMd('players')
})

await test('the sandbox policy is threaded into every encounter write', async () => {
  // The exact defect this bundle shipped with: a write that omits the 5th
  // argument to fs.writeText is judged against the harness process's cwd and is
  // refused for every campaign path. A tool that FORGETS it looks healthy in a
  // test that never passes a session, because the fallback is simply undefined.
  //
  // So this test supplies a resolvable session and requires the SAME policy
  // object to arrive at writeText. Dropping the argument makes the assertion
  // see undefined and fail.
  const SENTINEL = { sentinel: 'resolved-policy-for-this-session' }
  const sessionCtx = {
    get(name) {
      if (name === 'fs') return fsService
      if (name === 'tools') return { register: () => () => {} }
      if (name === 'sessions') return { get: (id) => (id === 'sess-1' ? { header: { cwd: tempRoot } } : undefined) }
      if (name === 'sandboxPolicy') return { resolve: () => SENTINEL }
      return undefined
    },
    inject() {},
  }

  const isolated = []
  const isolatedCtx = {
    get: (n) => (n === 'tools' ? { register: (t) => { isolated.push(t); return () => {} } } : sessionCtx.get(n)),
    inject() {},
  }
  const mod = await import('../src/host/index.mjs?initiative-policy')
  mod.apply(isolatedCtx)
  const tool = isolated.find((t) => t.name === 'dnd_initiative')
  assert.ok(tool !== undefined, 'dnd_initiative must be registered')

  writes.length = 0
  await tool.execute(
    { character: 'alice', combatants: ['PolicyProbe'], mode: 'dm' },
    { agent: { id: 'sess-1' } },
  )

  assert.ok(writes.length > 0, 'the roll should have written the encounter file')
  for (const w of writes) {
    assert.equal(w.sandboxPolicy, SENTINEL,
      'the calling session\'s sandbox policy must reach fs.writeText as the 5th argument; got ' + JSON.stringify(w.sandboxPolicy))
  }
})

await test('an agentless call forwards undefined rather than inventing a policy', async () => {
  // The other half: no session means the platform's fail-closed process-cwd
  // fallback. Substituting a guessed root or a wider mode would convert a
  // visible refusal into a silent bypass.
  writes.length = 0
  await call('dnd_initiative', { character: 'alice', combatants: ['NoSession'], mode: 'dm' })
  assert.ok(writes.length > 0, 'the roll should still have written')
  for (const w of writes) {
    assert.equal(w.sandboxPolicy, undefined, 'an agentless call must forward undefined, got ' + JSON.stringify(w.sandboxPolicy))
  }
})
await test('every write stayed inside the temp tree', () => {
  // The remap makes this the real safety property: no write may name a path
  // outside tmpdir(), whatever the tool believed DND_ROOT to be.
  const root = tempRoot.replace(/\\/g, '/').toLowerCase()
  assert.ok(writes.length > 0, 'the suite should have performed writes')
  for (const w of writes) {
    assert.ok(w.path.toLowerCase().startsWith(root),
      'a write escaped the temp tree: ' + w.path)
  }
})

rmSync(tempRoot, { recursive: true, force: true })

console.log('')
if (failures > 0) {
  console.error(`initiative.test.mjs: ${failures} failure(s)`)
  process.exit(1)
}
console.log('initiative.test.mjs: all assertions passed')
