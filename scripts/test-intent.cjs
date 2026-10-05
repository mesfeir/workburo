/**
 * The rule that reads an attached picture's intent, tested against the real source.
 *
 * This decides whether a dropped picture goes to fal to be changed, to the chat model to be read, or
 * back to the user as a question -- so a wrong answer here either spends money or sends a picture to
 * a model that never looks at it. It is worth a table.
 *
 * The module is TypeScript with no imports, so it is bundled with the project's own esbuild and then
 * required; nothing is reimplemented here, which is the whole point of the test.
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

const src = path.join(__dirname, '..', 'src', 'lib', 'imageIntent.ts')
const out = path.join(os.tmpdir(), `wb-intent-${Date.now()}.cjs`)
esbuild.buildSync({ entryPoints: [src], outfile: out, format: 'cjs', bundle: true, logLevel: 'silent' })
const { readImageIntent } = require(out)
fs.unlinkSync(out)

/* [what was typed, what the last turn did, what should happen] */
const table = [
  ['', false, 'look'],
  ['   ', false, 'look'],
  ['make it brighter', false, 'edit'],
  ['remove the background', false, 'edit'],
  ['turn this into a watercolour', false, 'edit'],
  ['upscale this please', false, 'edit'],
  ['crop the left side', false, 'edit'],
  ['add a hat to the person', false, 'edit'],
  ['change the sky to teal', false, 'edit'],
  ['make it look like a painting', false, 'edit'],
  ['what does this say?', false, 'look'],
  ['describe this image', false, 'look'],
  ['who is in this photo?', false, 'look'],
  ['read the text in this screenshot', false, 'look'],
  ['where was this taken?', false, 'look'],
  ['is there a cat in this?', false, 'look'],
  ['the file I mentioned', false, 'unsure'],
  /* "here is X" is a read, not a question: the analysis default means anything that does not ask for
     a change is looked at. Reading costs nothing and can be followed up; that is the point. */
  ['here is the mockup', false, 'look'],
  /* both at once: a turn can only do one, so it asks */
  ['remove the caption and tell me what it said', false, 'unsure'],
  /* continuation follows the last turn */
  ['more like this', true, 'edit'],
  ['more like this', false, 'look'],
  ['again', true, 'edit'],
  ['same but wider', true, 'edit'],
  ['keep going', false, 'look'],
]

for (const [text, lastWasEdit, want] of table) {
  const got = readImageIntent(text, lastWasEdit)
  check(
    `${JSON.stringify(text)} after ${lastWasEdit ? 'an edit' : 'a read'} -> ${want}`,
    got === want,
    `got ${got}`,
  )
}

/*
 * The one that matters most: words that say nothing about changing the picture must never reach fal,
 * because that is the case that used to cost money by default.
 */
const quiet = [
  '',
  'what does this say?',
  'describe it',
  'who is this?',
  'is this right?',
  'looks good?',
]
check(
  'nothing about changing a picture is ever sent to fal on a guess',
  quiet.every((t) => readImageIntent(t, false) !== 'edit'),
  quiet.map((t) => `${t}->${readImageIntent(t, false)}`).join(', '),
)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
