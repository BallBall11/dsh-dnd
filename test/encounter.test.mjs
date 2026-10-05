/**
 * encounter.test.mjs — encounter difficulty and loot (GAP plan, project 5).
 *
 * The difficulty numbers are pinned against the DMG's own worked examples:
 * the published method (threshold sums + the monster-count multiplier) has
 * known answers, and a wrong multiplier is exactly the kind of silent error
 * only an independent check catches.
 *
 * Rules: docs/harness/GAP-TOOLS-PLAN.md · src/host/tools/encounter.mjs
 */
import assert from 'node:assert/strict'
import { difficultyFor } from '../src/host/tools/encounter.mjs'

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

await test('DMG method: four level-1 PCs vs four goblins (CR 1/4) hits the deadly threshold', async () => {
  // 4x50 = 200 raw, x2 (4 monsters) = 400 adjusted. Party deadly = 4x100 =
  // 400 — adjusted >= deadly, and the method says exactly that: this fight is
  // DEADLY for a fresh party (the DMG's own caution about goblin packs).
  const out = difficultyFor([1, 1, 1, 1], [{ cr: '1/4', count: 4 }])
  assert.equal(out.rawXP, 200)
  assert.equal(out.adjustedXP, 400)
  assert.equal(out.multiplier, 2)
  assert.equal(out.verdict, '致命', JSON.stringify(out))
})

await test('a single monster takes NO multiplier', async () => {
  const out = difficultyFor([1, 1, 1, 1], [{ cr: '1' }])
  assert.equal(out.multiplier, 1)
  assert.equal(out.adjustedXP, 200)
  // 200 >= medium 200, < hard 300 -> medium.
  assert.equal(out.verdict, '中等')
})

await test('two monsters multiply by 1.5 and the result rounds', async () => {
  const out = difficultyFor([1], [{ cr: '1/4', count: 2 }])
  assert.equal(out.multiplier, 1.5)
  assert.equal(out.adjustedXP, 150, '2 x 50 x 1.5')
})

await test('seven monsters multiply by 2.5', async () => {
  const out = difficultyFor([5, 5, 5, 5], [{ cr: '1/2', count: 7 }])
  assert.equal(out.multiplier, 2.5)
  assert.equal(out.adjustedXP, 7 * 100 * 2.5, '1750')
  // Four level-5s: easy 1000, medium 2000 — 1750 sits between easy and medium.
  assert.equal(out.verdict, '简单')
})

await test('an empty verdict for a trivially small budget says so honestly', async () => {
  const out = difficultyFor([10, 10], [{ cr: '0', count: 1 }])
  assert.equal(out.adjustedXP, 10)
  assert.match(out.verdict, /低于「简单」/)
})

await test('unknown CRs and levels are reported, never silently dropped', async () => {
  const out = difficultyFor([3, 99], [{ cr: 'banana' }, { cr: '1' }])
  assert.deepEqual(out.unknownCRs, ['banana'])
  assert.deepEqual(out.unknownLevels, [99])
  // Only the level-3 thresholds count; only CR 1 counts.
  assert.equal(out.thresholds[3], 400)
  assert.equal(out.rawXP, 200)
})

await test('fractional CRs resolve (1/8, 1/2) and CR 0 awards 10 XP', async () => {
  assert.equal(difficultyFor([1], [{ cr: '1/8' }]).rawXP, 25)
  assert.equal(difficultyFor([1], [{ cr: '1/2' }]).rawXP, 100)
  assert.equal(difficultyFor([1], [{ cr: '0' }]).rawXP, 10)
})

await test('fifteen monsters hit the x4 cap', async () => {
  const out = difficultyFor([20, 20, 20, 20], [{ cr: '1', count: 15 }])
  assert.equal(out.multiplier, 4)
})

await test('an eight-member party sums its thresholds', async () => {
  const out = difficultyFor([5, 5, 5, 5, 5, 5, 5, 5], [{ cr: '5', count: 2 }])
  // 8 x 500 easy = 4000; deadly = 8800. 2 x 1800 x 1.5 = 5400 -> between
  // medium 4000 and hard 6000... 5400 >= easy+medium but < hard => medium? No:
  // bands are absolute thresholds; 5400 >= medium(4000) and < hard(6000).
  assert.equal(out.verdict, '中等')
})

console.log(failures === 0 ? 'encounter.test.mjs: all passed' : `encounter.test.mjs: ${failures} failure(s)`)
if (failures > 0) process.exit(1)
