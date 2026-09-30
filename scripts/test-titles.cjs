/**
 * Conversation title rules.
 *
 * Offline, no network, no key: these check the parts that must not depend on a model —
 * reading the reply, refusing an echo, and choosing what the model is shown.
 *
 *   node scripts/test-titles.cjs
 *
 * The live half of this feature is proved by the app self-test, which sends a real turn and
 * checks the sidebar title that results.
 */

'use strict'

const titles = require('../electron/title.cjs')

let passed = 0
let failed = 0
const failures = []

function check (label, fn) {
  try {
    const r = fn()
    if (r === false) throw new Error('assertion failed')
    if (r && r.ok === false) throw new Error(r.why || 'assertion failed')
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    failures.push(`${label}: ${err.message}`)
    console.log(`  FAIL  ${label} — ${err.message}`)
  }
}

function assert (cond, why) {
  if (!cond) throw new Error(why || 'assertion failed')
}

console.log('\n=== titles ===')

check('1. a plain reply is taken as it is', () => {
  assert(titles.clean('report data spreadsheet') === 'report data spreadsheet', 'trimmed reply lost')
})

check('2. quotes and markdown are stripped', () => {
  assert(titles.clean('"quarterly budget review"') === 'quarterly budget review', 'double quotes kept')
  assert(titles.clean('**weather in london**') === 'weather in london', 'markdown kept')
  assert(titles.clean('“concrete wall details”') === 'concrete wall details', 'curly quotes kept')
})

check('3. a label the model added is dropped', () => {
  assert(titles.clean('Title: image model pricing') === 'image model pricing', 'label kept')
  assert(titles.clean('Chat title - agent file posting') === 'agent file posting', 'label kept')
})

check('4. trailing punctuation goes, including a full stop', () => {
  assert(titles.clean('rust ownership basics.') === 'rust ownership basics', 'full stop kept')
  assert(titles.clean('latest news about vllm!') === 'latest news about vllm', 'bang kept')
})

check('5. one word is a valid title', () => {
  assert(titles.clean('Rhino') === 'Rhino', 'single word rejected')
})

check('6. five or more words are cut to four, not rejected', () => {
  assert(titles.clean('how do i set up ollama locally') === 'how do i set', 'wrong cut')
})

check('7. the length ceiling matches the opening-words fallback', () => {
  const long = titles.clean('a'.repeat(80))
  assert(long.length === titles.MAX_CHARS, `expected ${titles.MAX_CHARS}, got ${long.length}`)
})

check('8. only the first line is read', () => {
  assert(titles.clean('leather sofa repair\n\nHere is why I chose those words:') === 'leather sofa repair', 'later lines kept')
})

check('9. empty answers are refused', () => {
  assert(titles.clean('') === '', 'empty should stay empty')
  assert(titles.clean('   \n  ') === '', 'whitespace should stay empty')
  assert(titles.clean(null) === '', 'null should stay empty')
  assert(titles.clean('""') === '', 'empty quotes should stay empty')
  assert(titles.clean('Title:') === '', 'a bare label should stay empty')
})

check('10. usable refuses nothing at all', () => {
  assert(titles.usable('', 'hello there') === false, 'empty accepted')
})

check('11. usable refuses a reply that just echoes the opening', () => {
  assert(
    titles.usable('can you turn this report', 'can you turn this report into a spreadsheet please') === false,
    'an echo of the opening was accepted as a summary',
  )
})

check('12. usable accepts a title built from the opening\'s own nouns', () => {
  // This used to be refused, and that was wrong. A summary of a long opening almost always
  // reuses its nouns, and "supplier prices spreadsheet" is a good title for a message about
  // turning supplier prices into a spreadsheet. Found by a live run, not by this suite.
  assert(
    titles.usable('report this turn', 'can you turn this report into a spreadsheet please') === true,
    'a reordered run of the opening words was refused, which throws away good titles',
  )
  assert(
    titles.usable('supplier prices spreadsheet', 'turn these supplier prices into a spreadsheet') === true,
    'a summary reusing the opening nouns was refused',
  )
})

check('13. usable accepts a title that says something new', () => {
  assert(titles.usable('report data spreadsheet', 'can you turn this report into a spreadsheet please') === true, 'real summary refused')
  assert(titles.usable('agent file posting', 'the agent cannot post files into the chat') === true, 'real summary refused')
})

check('14. usable refuses a reply longer than four words', () => {
  assert(titles.usable('one two three four five', 'something else entirely here') === false, 'five words accepted')
})

check('15. the transcript carries the first exchange, with the reply first', () => {
  const t = titles.transcript([
    { role: 'user', content: 'turn this report into a spreadsheet' },
    { role: 'assistant', content: 'Done — saved reports/q3.xlsx' },
    { role: 'user', content: 'now chart it' },
  ])
  assert(t.includes('User asked: turn this report into a spreadsheet'), 'first user turn missing')
  assert(t.includes('Assistant: Done'), 'first assistant reply missing')
  assert(!t.includes('now chart it'), 'a later turn leaked into the transcript')
  // the reply leads: a model shown the request first tends to echo it, and an echo is refused
  assert(t.indexOf('Assistant:') < t.indexOf('User asked:'), 'the reply should come first')
})

check('16. the transcript works with only a user turn', () => {
  const t = titles.transcript([{ role: 'user', content: 'hello' }])
  assert(t === 'User asked: hello', `unexpected transcript: ${JSON.stringify(t)}`)
})

check('17. the transcript is empty when there is nothing to read', () => {
  assert(titles.transcript([]) === '', 'empty list should give an empty transcript')
  assert(titles.transcript([{ role: 'system', content: 'you are a helpful assistant' }]) === '', 'system-only should be empty')
})

check('18. each message is capped so a pasted document cannot blow up the call', () => {
  const t = titles.transcript([{ role: 'user', content: 'x'.repeat(5000) }])
  const body = t.replace(/^User asked: /, '')
  assert(body.length <= titles.PER_MESSAGE, `message body too long: ${body.length}`)
  assert(t.length < titles.PER_MESSAGE + 40, `transcript unexpectedly long: ${t.length}`)
})

check('19. the instruction and the parser agree on three or four words', () => {
  assert(/3 or 4 words/.test(titles.INSTRUCTIONS), 'the instruction no longer asks for 3 or 4 words')
  assert(/no quotes/i.test(titles.INSTRUCTIONS), 'the instruction no longer forbids quotes')
  assert(titles.MAX_WORDS === 4, 'MAX_WORDS drifted from the instruction')
})

check('20. a path or filename survives cleaning', () => {
  // titles are shown in a sidebar, never used as a path, but a model may answer with one
  assert(titles.clean('reports/q3 budget.xlsx') === 'reports/q3 budget.xlsx', 'path mangled')
})

check('21. a title that only repeats the assistant greeting is refused', () => {
  const opening = 'hi'
  const reply = 'Hello! 👋 How can I help you today?'
  assert(
    !titles.usable('Hello! 👋 How can', opening, reply),
    'the assistant greeting was accepted as a title',
  )
  assert(titles.usable('Elephant image generation', opening, reply), 'a real title was refused')
})

check('22. a summary built from the opening survives now that the reply is checked too', () => {
  const opening = 'turn my supplier prices into a spreadsheet I can sort and filter'
  const reply = 'Happy to help — send the list over.'
  assert(
    titles.usable('supplier prices spreadsheet', opening, reply),
    'a good summary was refused because a reply was present',
  )
  assert(!titles.usable('turn my supplier prices', opening, reply), 'an echo of the opening was accepted')
})

check('23. the second framing asks for a subject for the request alone', () => {
  const msgs = [
    { role: 'user', content: 'turn my supplier prices into a spreadsheet' },
    { role: 'assistant', content: 'Happy to help — send the list over.' },
  ]
  const only = titles.transcript(msgs, { only: 'user' })
  assert(
    only === 'User asked: turn my supplier prices into a spreadsheet',
    `the request-only framing came out as ${JSON.stringify(only)}`,
  )
  assert(!only.includes('Assistant:'), 'the reply leaked into the request-only framing')
  assert(titles.transcript(msgs) !== only, 'both framings are identical, so retrying one is pointless')
  return true
})

console.log(`\n=== summary ===`)
console.log(`  ${passed} passed, ${failed} failed`)
if (failures.length) {
  console.log('\nfailures:')
  for (const f of failures) console.log(`  - ${f}`)
}
process.exit(failed ? 1 : 0)
