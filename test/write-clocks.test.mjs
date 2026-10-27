/**
 * write-clocks.test.mjs — the execute()-level two-clock invariant.
 *
 * Every character write stamps both clocks: `updated` (real) and `worldTime`
 * (from the campaign calendar). That invariant used to be tested only at the
 * `writeCharacter` layer, and `dnd_character_update` clobbered worldTime on
 * every call without a single red suite — the execute()-level choreography
 * was too expensive for any suite to repeat. The tempCampaign fixture makes
 * it one call, so the invariant is pinned where this defect class actually
 * lives: at the tool boundary.
 *
 * Covered paths: the shared pipeline (dnd_track, dnd_spend — dnd_rest and
 * dnd_level_up enter through the same applyChange) and the narrative path
 * (dnd_character_update), which had its own calendar fetch and was the one
 * that broke.
 *
 * Expectations are literals, not derived from the implementation under test:
 * a write assertion that computes its expectation with the same code passes
 * whenever the code does (lesson 12 of the rewrite).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

process.env.DND_ROOT ??= 'D:/DND' // direct execute() calls have no session; the env root is the explicit config

import { tempCampaign } from './support/temp-campaign.mjs'
import { buildTools as buildTrackTools } from '../src/host/tools/track.mjs'
import { buildTools as buildRestTools } from '../src/host/tools/rest.mjs'
import { buildTools as buildCreateTools } from '../src/host/tools/character-create.mjs'
import { splitSheet } from '../src/host/tools/sheet-split.mjs'

// formatWorldTime({ day: 2, month: 3, year: 1247, hour: 8, months: [...] }),
// written as a literal so a formatting regression cannot assert itself green.
const WORLD_TIME = '2 Thawmonth 1247 AR, 08:00'

const QUILL = {
  name: 'quill',
  state: {
    name: 'Quill',
    identity: { level: 3, xp: 0 },
    combat: { hp: { current: 20, max: 20 }, ac: 12, hitDice: { die: 'd8', remaining: 2 } },
    currency: 800,
  },
  narrative: '## Character Pillar\n\nQuiet, watchful, keeps score of everything.\n',
}

function assertBothClocks(camp, stem) {
  const sheetText = readFileSync(`${camp.charactersDir}/${stem}.md`, 'utf8')
  const { metadata } = splitSheet(sheetText, { name: stem })
  assert.equal(metadata.worldTime, WORLD_TIME, 'worldTime must survive a write')
  assert.match(String(metadata.updated), /^\d{4}-\d{2}-\d{2}$/, 'the real clock is stamped as a date')
}

async function withCampaign(run) {
  const camp = await tempCampaign({ characters: [QUILL] })
  try {
    await run(camp)
  } finally {
    camp.dispose()
  }
}

const trackCtx = (camp) => ({ get: (n) => (n === 'fs' ? camp.fs : undefined) })

await test('dnd_track stamps both clocks and preserves worldTime', async () => {
  await withCampaign(async (camp) => {
    const track = buildTrackTools(trackCtx(camp)).find((t) => t.name === 'dnd_track')
    const out = String(await track.execute({ character: 'quill', hp: '-3' }))
    assert.match(out, /Written|HP now/, 'the change must land: ' + out)
    assertBothClocks(camp, 'quill')
  })
})

await test('dnd_spend stamps both clocks and preserves worldTime', async () => {
  await withCampaign(async (camp) => {
    const spend = buildTrackTools(trackCtx(camp)).find((t) => t.name === 'dnd_spend')
    const out = String(await spend.execute({ character: 'quill', amount: '1 cp' }))
    assert.match(out, /Spent .* Purse: .*7 gp 9 sp 9 cp/, 'the spend must land: ' + out)
    assertBothClocks(camp, 'quill')
  })
})

await test('dnd_rest stamps both clocks and preserves worldTime', async () => {
  await withCampaign(async (camp) => {
    const track = buildTrackTools(trackCtx(camp)).find((t) => t.name === 'dnd_track')
    await track.execute({ character: 'quill', hp: '-6' })
    const rest = buildRestTools(trackCtx(camp)).find((t) => t.name === 'dnd_rest')
    const out = String(await rest.execute({ kind: 'long', character: 'quill' }))
    assert.match(out, /LONG rest/, 'the rest must settle: ' + out)
    assertBothClocks(camp, 'quill')
  })
})

await test('dnd_character_update stamps both clocks and preserves worldTime', async () => {
  await withCampaign(async (camp) => {
    const update = buildTrackTools(trackCtx(camp)).find((t) => t.name === 'dnd_character_update')
    const out = String(await update.execute({
      op: 'append', section: 'Character Pillar', text: 'Owes the innkeeper three silver.',
    }))
    assert.match(out, /Appended/, 'the narrative edit must land: ' + out)
    assertBothClocks(camp, 'quill')
  })
})

await test('dnd_character_create stamps both clocks and preserves worldTime', async () => {
  await withCampaign(async (camp) => {
    // No `klass`: the class skeleton lives in the package dataset, outside the
    // temp workspace, and this test is about the clocks, not the skeleton.
    const create = buildCreateTools(trackCtx(camp)).find((t) => t.name === 'dnd_character_create')
    const out = String(await create.execute({ name: 'Mira', hp: 10, ac: 12, abilities: { STR: 10 } }))
    assert.match(out, /Created Mira/, 'the create must land: ' + out)
    assertBothClocks(camp, 'mira')
  })
})

await test('a refused startup probe prepends its advisory through the pipeline', async () => {
  // The advisory is the pipeline's job now, so every writer that enters the
  // seam — rest and the narrative writer included — surfaces it, not just the
  // track family. The published probe state is the module's documented
  // interface (a mount publishes it); the test publishes a refused one and
  // restores whatever the process had.
  const probe = await import('../src/host/tools/write-probe.mjs')
  const previous = probe.writeProbeState()
  try {
    await withCampaign(async (camp) => {
      const published = probe.createProbeState()
      published.set({ status: probe.PROBE_REFUSED, path: camp.campaignDir, message: 'probe refused (fixture)' })
      probe.setWriteProbeState(published)

      const rest = buildRestTools(trackCtx(camp)).find((t) => t.name === 'dnd_rest')
      const out = String(await rest.execute({ kind: 'long', character: 'quill' }))
      assert.match(out, /^WARNING: the startup write self-check was REFUSED/, 'rest must surface the advisory: ' + out)
      assert.match(out, /probe refused \(fixture\)/)
      assert.match(out, /LONG rest/, 'the advisory must prepend, not replace, the report: ' + out)

      const update = buildTrackTools(trackCtx(camp)).find((t) => t.name === 'dnd_character_update')
      const upd = String(await update.execute({ op: 'append', section: 'Character Pillar', text: 'Still owes the innkeeper.' }))
      assert.match(upd, /^WARNING: the startup write self-check was REFUSED/, 'the narrative writer must surface it too: ' + upd)
      assert.match(upd, /Appended/, 'the advisory must prepend, not replace, the report: ' + upd)
    })
  } finally {
    probe.setWriteProbeState(previous)
  }
})
