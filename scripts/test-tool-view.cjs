/**
 * The rule that decides what a turn's tool calls put on screen, tested against the real source.
 *
 * The transcript used to draw one line per tool. An agent turn that called forty of them became a
 * forty-line block that filled the window and re-rendered on every streamed token, which is what made
 * agent mode feel heavy. The fix is a rule about what to show, so the rule is what gets tested.
 *
 * The module is TypeScript whose only import is a type, so it is bundled with the project's own
 * esbuild and then required; nothing is reimplemented here, which is the whole point of the test.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const src = path.join(__dirname, '..', 'src', 'lib', 'toolView.ts')
const out = path.join(os.tmpdir(), `wb-toolview-${Date.now()}.cjs`)
esbuild.buildSync({ entryPoints: [src], outfile: out, format: 'cjs', bundle: true, logLevel: 'silent' })
const { toolView, toolLabel } = require(out)
fs.unlinkSync(out)

const tool = (id, status = 'done', extra = {}) => ({ id, name: 'bash', status, ...extra })
const many = (n, lastStatus = 'done') =>
  Array.from({ length: n }, (_, i) => tool(`t${i}`, i === n - 1 ? lastStatus : 'done'))

/* nothing at all */
const empty = toolView([], true)
check('no tools means nothing is drawn', empty.empty === true && empty.current === null)
check('no tools means no summary pretending otherwise', empty.summary === '')

/* while it works: the one in hand, and a count of the rest */
const running = toolView(many(40, 'running'), true)
check('while running, the tool in hand is the one still going', running.current.id === 't39')
check('while running, the other thirty-nine are only counted', running.done.length === 39)
check(
  'nothing is lost: the current tool and the rest add up to the whole list',
  running.done.length + 1 === 40,
)

/* all tools finished but the turn is still streaming: show the last one, not the list */
const between = toolView(many(40), true)
check('with none running, the last tool is the one shown', between.current.id === 't39')
check('and the other thirty-nine are still only counted', between.done.length === 39)

/* when it stops: one line, not forty */
const finished = toolView(many(40), false)
check('when the turn stops the whole run folds to one line', finished.summary === '40 tools used')
check('the folded line is not treated as live', !finished.live)

/* a single tool says what it was, not "1 tools used" */
const one = toolView([tool('only', 'done', { label: 'Read a file' })], false)
check('one tool names itself rather than being counted', one.summary === 'Read a file')

/* the label rule: a search says what it did, anything else falls back to its label then its name */
check('a web search is described in words', toolLabel({ name: 'web_search', server: true }) === 'Searched the web')
check('a named tool keeps its label', toolLabel({ name: 'bash', label: 'Ran a command' }) === 'Ran a command')
check('an unnamed tool falls back to its name', toolLabel({ name: 'read_file' }) === 'read_file')

/* the property that matters at every size, not only the one that was complained about */
let allSizes = true
for (let n = 1; n <= 60; n++) {
  const v = toolView(many(n, n % 3 === 0 ? 'running' : 'done'), n % 2 === 0)
  if (v.current === null || v.done.length + 1 !== n) allSizes = false
}
check('every size of run keeps one current tool and counts the rest', allSizes)

/* a failure must not be hidden behind the count while the turn is live */
const failing = toolView([tool('a'), tool('b', 'running'), tool('c', 'error')], true)
check('a failure is not hidden while the turn is live', failing.done.some((t) => t.status === 'error'))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
