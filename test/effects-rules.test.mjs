/**
 * effects-rules tests 鈥?the PURE half of timed effects, concentration and death
 * saves.
 *
 * Everything asserted here is a function of its arguments: no filesystem, no
 * clock, no campaign. That is the property the module was designed around (see
 * the header of src/host/tools/effects.mjs, sections 2 and 3), and it is what
 * makes these tests worth having 鈥?a rule can be pinned by calling one function
 * with a literal.
 *
 * These are MUTATION-CHECKED. Each block was written so that deliberately
 * breaking the matching line of the implementation turns it red; the specific
 * mutations and their observed failures are recorded in the task report.
 *
 * This suite reads no campaign data at all, so it needs no ownership
 * classification (see scripts/audit-test-ownership.mjs).
 */
import assert from 'node:assert/strict'
import {
  applyDeathSave,
  breakSaveDc,
  concentrationEffect,
  effectMatches,
  elapsedSeconds,
  formatDuration,
  makeEffect,
  parseDuration,
  remainingSeconds,
  secondsToDuration,
  tickEffects,
  UNIT_SECONDS,
  verdictFor,
  verdictSentence,
} from '../src/host/tools/effects.mjs'

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

const effect = (name, spec, options) => makeEffect(name, parseDuration(spec), options)

console.log('effect durations:')

await test('a round is six seconds, a minute sixty, an hour three thousand six hundred', () => {
  assert.equal(UNIT_SECONDS.rounds, 6, 'a 5e round is 6 seconds (SRD 5.2, The Order of Combat)')
  assert.equal(UNIT_SECONDS.minutes, 60)
  assert.equal(UNIT_SECONDS.hours, 3600)
})

await test('parses rounds, minutes, hours and indefinite', () => {
  assert.deepEqual(parseDuration('10r'), { unit: 'rounds', remaining: 10 })
  assert.deepEqual(parseDuration('60m'), { unit: 'minutes', remaining: 60 })
  assert.deepEqual(parseDuration('8h'), { unit: 'hours', remaining: 8 })
  assert.deepEqual(parseDuration('indef'), { unit: 'indefinite', remaining: null })
  assert.deepEqual(parseDuration('10 rounds'), { unit: 'rounds', remaining: 10 })
  assert.deepEqual(parseDuration('10 minutes'), { unit: 'minutes', remaining: 10 })
  assert.deepEqual(parseDuration('2 hours'), { unit: 'hours', remaining: 2 })
})

await test('a BARE number is refused rather than guessed at', () => {
  // The whole reason this is a refusal: "10" is either ten rounds or ten
  // minutes, and guessing wrong is a silent, plausible-looking error.
  assert.equal(parseDuration('10'), null, 'a bare number must not be read as a duration')
  assert.equal(parseDuration(''), null)
  assert.equal(parseDuration(undefined), null)
  assert.equal(parseDuration('banana'), null)
  assert.equal(parseDuration('0r'), null, 'a zero-length effect is not an effect')
  assert.equal(parseDuration('r'), null, 'a unit with no count is not a duration')
})

await test('renders a duration with a singular for exactly one', () => {
  assert.equal(formatDuration({ unit: 'rounds', remaining: 1 }), '1 round')
  assert.equal(formatDuration({ unit: 'rounds', remaining: 3 }), '3 rounds')
  assert.equal(formatDuration({ unit: 'minutes', remaining: 60 }), '60 minutes')
  assert.equal(formatDuration({ unit: 'indefinite', remaining: null }), 'indefinite')
})

console.log('')
console.log('tick 鈥?the pure decrement rule:')

await test('a 5-round effect expires on the FIFTH round tick, not the fourth', () => {
  // The off-by-one that matters: an effect with 5 rounds left must still be
  // running after four ticks and gone after the fifth.
  let effects = [effect('Bless', '5r')]
  for (let i = 1; i <= 4; i += 1) {
    const step = tickEffects(effects, { rounds: 1 })
    assert.equal(step.expired.length, 0, 'Bless must survive tick ' + i)
    assert.equal(step.remaining.length, 1, 'Bless must still be running after tick ' + i)
    effects = step.remaining
  }
  const fifth = tickEffects(effects, { rounds: 1 })
  assert.equal(fifth.expired.length, 1, 'Bless must expire on the fifth tick')
  assert.equal(fifth.expired[0].name, 'Bless')
  assert.equal(fifth.remaining.length, 0, 'nothing may be left running')
})

await test('an effect that reaches zero is moved out, never left at remaining 0', () => {
  const step = tickEffects([effect('Shield', '1r')], { rounds: 1 })
  assert.equal(step.remaining.length, 0, 'a spent effect must not stay in the running list')
  assert.deepEqual(step.remaining.filter((e) => e.duration.remaining === 0), [],
    'zero rounds left must never be a state a reader has to special-case')
})

await test('a round tick costs six seconds, so a minute effect survives many rounds', () => {
  // A 1-minute (60s) spell lasts TEN rounds, not one. If a round tick consumed a
  // whole minute it would expire after a single turn.
  let effects = [effect('Hunters Mark', '1m')]
  for (let i = 1; i <= 9; i += 1) {
    effects = tickEffects(effects, { rounds: 1 }).remaining
    assert.equal(effects.length, 1, 'the 1-minute effect must survive round ' + i)
  }
  const tenth = tickEffects(effects, { rounds: 1 })
  assert.equal(tenth.expired.length, 1, 'sixty seconds is exactly ten rounds')
})

await test('minutes tick a minute effect; hours tick an hour effect', () => {
  const afterTenMinutes = tickEffects([effect('Hunters Mark', '10m')], { minutes: 10 })
  assert.equal(afterTenMinutes.expired.length, 1, '10 minutes consumes a 10m effect exactly')
  const afterEightHours = tickEffects([effect('Mage Armor', '8h')], { hours: 8 })
  assert.equal(afterEightHours.expired.length, 1, '8 hours consumes an 8h effect exactly')
  const partial = tickEffects([effect('Mage Armor', '8h')], { hours: 7 })
  assert.equal(partial.expired.length, 0, 'seven hours leaves an 8h effect running')
  assert.deepEqual(partial.remaining[0].duration, { unit: 'hours', remaining: 1 })
})

await test('one tick advances a MIXED set by the same elapsed time', () => {
  // The reason everything is counted in seconds: a single "a round passed" has
  // to move a round effect and a minute effect by different amounts.
  const step = tickEffects([effect('Bless', '2r'), effect('Hunters Mark', '10m')], { rounds: 1 })
  assert.equal(step.remaining.length, 2)
  assert.deepEqual(step.remaining[0].duration, { unit: 'rounds', remaining: 1 })
  assert.equal(remainingSeconds(step.remaining[1]), 60 * 10 - 6,
    'the minute effect must have lost exactly six seconds')
})

await test('an indefinite effect never ticks down and never expires', () => {
  const step = tickEffects([effect('True Seeing', 'indef')], { hours: 100 })
  assert.equal(step.expired.length, 0, 'an indefinite effect does not expire on its own')
  assert.equal(step.remaining.length, 1)
  assert.deepEqual(step.remaining[0].duration, { unit: 'indefinite', remaining: null })
})

await test('ticking with no elapsed time is a no-op, and says so', () => {
  const step = tickEffects([effect('Bless', '5r')], {})
  assert.equal(step.advanced, false, 'a zero-length tick must report advanced: false')
  assert.deepEqual(step.remaining[0].duration, { unit: 'rounds', remaining: 5 })
  assert.equal(elapsedSeconds({}), 0)
  assert.equal(elapsedSeconds({ rounds: 0, minutes: 0 }), 0)
  assert.equal(elapsedSeconds({ rounds: -1 }), 0, 'a negative elapsed time is not a rewind')
})

await test('tickEffects MUTATES nothing 鈥?the input is untouched', () => {
  // Purity is the property the whole design rests on. If tickEffects edited its
  // input in place, a caller that ticked and then failed to save would have
  // already destroyed its own snapshot, and no test could tell.
  const original = effect('Bless', '3r')
  const input = [original]
  const snapshot = JSON.stringify(input)
  const step = tickEffects(input, { rounds: 1 })
  assert.equal(JSON.stringify(input), snapshot, 'the input array and its members must be unchanged')
  assert.notEqual(step.remaining[0], original, 'the result must be a copy, not the same object')
  assert.deepEqual(original.duration, { unit: 'rounds', remaining: 3 })
})

await test('secondsToDuration keeps the declared unit only while it is EXACT', () => {
  assert.deepEqual(secondsToDuration(60, 'minutes'), { unit: 'minutes', remaining: 1 })
  assert.deepEqual(secondsToDuration(600, 'minutes'), { unit: 'minutes', remaining: 10 })
  // 594s is 9.9 minutes. Rounding to ten minutes would let the spell outlive its
  // own arithmetic, so it drops to seconds instead.
  assert.deepEqual(secondsToDuration(594, 'minutes'), { unit: 'seconds', remaining: 594 })
  assert.deepEqual(secondsToDuration(Infinity, 'minutes'), { unit: 'indefinite', remaining: null })
})

console.log('')
console.log('concentration 鈥?the save it forces:')

await test('breakSaveDc is max(10, half the damage), with the half rounded DOWN', () => {
  // SRD 5.2, Concentration. The floor is what keeps 21 damage at DC 10: half is
  // 10.5, and 10 is still the higher of the two.
  assert.equal(breakSaveDc(1), 10)
  assert.equal(breakSaveDc(10), 10)
  assert.equal(breakSaveDc(20), 10)
  assert.equal(breakSaveDc(21), 10, 'half of 21 is 10.5; the rule takes the HIGHER of 10 and half')
  assert.equal(breakSaveDc(22), 11)
  assert.equal(breakSaveDc(30), 15)
  assert.equal(breakSaveDc(40), 20)
  assert.equal(breakSaveDc(100), 50)
})

await test('breakSaveDc never returns less than 10, whatever it is handed', () => {
  assert.equal(breakSaveDc(0), 10)
  assert.equal(breakSaveDc(-5), 10, 'negative damage must not lower the DC below 10')
  assert.equal(breakSaveDc(undefined), 10)
  assert.equal(breakSaveDc('banana'), 10)
})

await test('concentrationEffect finds the running spell it points at', () => {
  const effects = [effect('Bless', '10r'), effect('Hunters Mark', '10m')]
  const found = concentrationEffect(effects, { spell: 'bless' })
  assert.ok(found !== undefined, 'a case-insensitive match must find the effect')
  assert.equal(found.name, 'Bless')
  assert.equal(concentrationEffect(effects, { spell: 'Fireball' }), undefined,
    'a spell with no running effect must report nothing')
  assert.equal(concentrationEffect(effects, null), undefined)
})

await test('effectMatches ignores case but not identity', () => {
  assert.equal(effectMatches({ name: 'Bless' }, 'bless'), true)
  assert.equal(effectMatches({ name: 'Bless' }, '  BLESS  '), true)
  assert.equal(effectMatches({ name: 'Bless' }, 'Bane'), false)
})

console.log('')
console.log('death saves 鈥?the tally and the verdicts:')

await test('a THIRD failure produces the death verdict, and the second does not', () => {
  const second = applyDeathSave({ successes: 0, failures: 1 }, 'failure', 5)
  assert.equal(second.failures, 2)
  assert.equal(second.verdict, 'dying', 'two failures is not yet dead')

  const third = applyDeathSave({ successes: 0, failures: 2 }, 'failure', 5)
  assert.equal(third.failures, 3)
  assert.equal(third.verdict, 'dead', 'THREE failures must produce an explicit death verdict')
  const sentence = verdictSentence('Alice', third.verdict, third)
  assert.match(sentence, /DEAD/, 'the death conclusion must be explicit in words: ' + sentence)
  assert.match(sentence, /three failed death saves/i, sentence)
})

await test('a THIRD success produces the stable verdict', () => {
  const third = applyDeathSave({ successes: 2, failures: 0 }, 'success', 15)
  assert.equal(third.successes, 3)
  assert.equal(third.verdict, 'stable')
  assert.match(verdictSentence('Alice', third.verdict, third), /STABLE/)
})

await test('a natural 1 counts as TWO failures', () => {
  const one = applyDeathSave({ successes: 0, failures: 0 }, 'failure', 1)
  assert.equal(one.failures, 2, 'a nat 1 is two failures, not one')
  assert.equal(one.delta, 2)
  assert.equal(one.verdict, 'dying', 'two failures is not yet dead')
})

await test('a natural 1 on the LAST failure still reaches 3, and says the cap absorbed one', () => {
  const result = applyDeathSave({ successes: 0, failures: 2 }, 'failure', 1)
  assert.equal(result.failures, 3, 'the tally stops at 3')
  assert.equal(result.verdict, 'dead')
  assert.equal(result.notes.some((n) => /capped at 3/.test(n)), true,
    'a DM reading two-on-a-tally-that-moved-by-one must be told why: ' + JSON.stringify(result.notes))
})

await test('a natural 20 revives and clears the tally', () => {
  const result = applyDeathSave({ successes: 1, failures: 2 }, 'success', 20)
  assert.equal(result.verdict, 'revived')
  assert.equal(result.regainsHp, true, 'a nat 20 restores 1 hit point')
  assert.equal(result.failures, 0, 'the tally is cleared, or the next reader acts on a finished fight')
  assert.equal(result.successes, 0)
})

await test('the tally never exceeds three in either direction', () => {
  let tally = { successes: 0, failures: 0 }
  for (let i = 0; i < 6; i += 1) tally = applyDeathSave(tally, 'failure', 5)
  assert.equal(tally.failures, 3, 'a fourth failure does not make anyone more dead')
  let other = { successes: 0, failures: 0 }
  for (let i = 0; i < 6; i += 1) other = applyDeathSave(other, 'success', 12)
  assert.equal(other.successes, 3)
})

await test('verdictFor reports dead, stable or dying, and dead wins a tie', () => {
  assert.equal(verdictFor(0, 0), 'dying')
  assert.equal(verdictFor(2, 2), 'dying')
  assert.equal(verdictFor(3, 0), 'stable')
  assert.equal(verdictFor(0, 3), 'dead')
  assert.equal(verdictFor(3, 3), 'dead', 'a tie must fail loudly rather than quietly revive')
})

await test('an unreadable outcome changes nothing', () => {
  const result = applyDeathSave({ successes: 1, failures: 1 }, 'banana', 5)
  assert.equal(result.successes, 1)
  assert.equal(result.failures, 1)
  assert.equal(result.delta, 0)
})

console.log('')
if (failures > 0) {
  console.error('effects-rules.test.mjs: ' + failures + ' failure(s)')
  process.exit(1)
}
console.log('effects-rules.test.mjs: all assertions passed')