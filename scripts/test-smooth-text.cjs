/**
 * The rules behind the steady reveal and the one-line thought, tested against the real module.
 *
 * The pacing rule is the one worth testing carefully: too slow and a long answer crawls behind the
 * model, too fast and a burst lands as a block again — which is the whole complaint. Both failures
 * this suite found first time round were real: a fixed speed floor left the tail of a burst crawling,
 * and dividing by a constant each frame decays geometrically, so "clear within the window" was never
 * actually a bound.
 *
 * The module has no framework imports, so it is bundled with the project's own esbuild and required;
 * nothing is reimplemented here, which is the whole point of the test.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')

const src = path.join(__dirname, '..', 'src', 'lib', 'smoothText.ts')
const out = path.join(os.tmpdir(), `wb-smooth-${Date.now()}.cjs`)
esbuild.buildSync({ entryPoints: [src], outfile: out, format: 'cjs', bundle: true, logLevel: 'silent' })
const { revealStep, thinkingStatus, DRAIN_MS } = require(out)
fs.rmSync(out, { force: true })

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log('  ok   ' + name)
  } else {
    failed++
    console.log('  FAIL ' + name + (detail ? '  -> ' + detail : ''))
  }
}

const FRAME = 1000 / 60

/** A burst arriving all at once, revealed frame by frame: how many frames until it is all shown. */
function framesToShow(total, dt = FRAME) {
  let shown = 0
  let elapsed = 0
  let frames = 0
  while (shown < total && frames < 600) {
    shown += revealStep(shown, total, dt, elapsed)
    elapsed += dt
    frames++
  }
  return frames
}

/** A live stream: more text every frame, so the backlog's clock keeps restarting. */
function lagAfterSteadyStream(perFrame, frames = 300) {
  let shown = 0
  let total = 0
  for (let i = 0; i < frames; i++) {
    total += perFrame
    shown += revealStep(shown, total, FRAME, 0)
  }
  return total - shown
}

console.log('\nthe reveal pace')

check('nothing to show means nothing to add', revealStep(0, 0, 16) === 0)
check('a finished string does not grow', revealStep(10, 10, 16) === 0)
check('it never goes backwards', revealStep(20, 10, 16) === 0)
check('a zero-length frame adds nothing rather than looping', revealStep(0, 5, 0) === 1)

const burst = framesToShow(1000)
check(
  `a 1000-character burst is shown within the ${DRAIN_MS}ms window`,
  burst * FRAME <= DRAIN_MS + FRAME * 2,
  `${burst} frames = ${Math.round(burst * FRAME)}ms`,
)
check('and it took more than one frame, so it reads as a run and not a block', burst > 1, `${burst} frames`)
check('so a big burst is not slower than a small one', framesToShow(5000) <= burst + 3, `5000 took ${framesToShow(5000)}`)

check('a trickle still moves every frame', revealStep(0, 3, FRAME, 0) >= 1, String(revealStep(0, 3, FRAME, 0)))
const small = revealStep(0, 8, FRAME, 0)
check('a small backlog is not dumped in one frame', small <= 3, String(small))

check('a long frame cannot overshoot the end', revealStep(990, 1000, 5000, 0) === 10, String(revealStep(990, 1000, 5000, 0)))
check('a past-window backlog is cleared promptly instead of decaying', framesToShow(1000, 16) <= 14, String(framesToShow(1000, 16)))

const lag = lagAfterSteadyStream(5)
check(
  'during a live stream the lag settles rather than growing',
  lag < 70,
  `${lag} characters behind after 300 frames`,
)
check(
  'a faster stream lags more but still stays bounded',
  lagAfterSteadyStream(40) < 500,
  String(lagAfterSteadyStream(40)),
)

console.log('\none word for what a thought is doing')

check('an empty thought is just the plain word', thinkingStatus('') === 'Thinking')
check('a thought with no clue in it is not guessed at', thinkingStatus('Hmm, let me consider the shape of this.') === 'Thinking')
check('writing is recognised', thinkingStatus('Let me write the sentences out.') === 'Writing')
check('counting is recognised', thinkingStatus('I need to count from one to forty.') === 'Counting')
check('checking is recognised', thinkingStatus('Let me verify this against the list.') === 'Checking')
check('searching is recognised', thinkingStatus('I should look up the value first.') === 'Searching')
check('planning is recognised', thinkingStatus('My approach: outline the steps.') === 'Planning')
check('comparing is recognised', thinkingStatus('Comparing the two options now.') === 'Comparing')
check('reading is recognised', thinkingStatus('Let me parse what was asked.') === 'Reading')
check(
  'what it is on now wins over what it opened with',
  thinkingStatus('First I will write a draft. ' + 'x'.repeat(300) + ' Now I should verify the result.') === 'Checking',
  thinkingStatus('First I will write a draft. ' + 'x'.repeat(300) + ' Now I should verify the result.'),
)
check(
  'it is always exactly one word',
  [
    '', 'Hmm.', 'Let me write this.', 'count to forty', 'verify it', 'look up the date',
    'my plan is', 'compare them', 'read it carefully', 'z'.repeat(500),
  ].every((t) => /^\S+$/.test(thinkingStatus(t))),
)
check(
  'and never a sentence',
  ['Let me write a draft of the answer.'].every((t) => thinkingStatus(t).length <= 12),
)

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
