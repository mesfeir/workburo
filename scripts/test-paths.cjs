'use strict'

// The rules that decide which files this app will open, and what the agent is told about pictures.
// Both were the cause of a real complaint: Open did nothing on a file the agent had just written,
// and an agent asked to use an earlier picture could not find it.

const path = require('node:path')
const p = require('../electron/paths.cjs')

let pass = 0
let fail = 0
function check (name, fn) {
  try {
    fn()
    pass++
    console.log(`  PASS  ${name}`)
  } catch (e) {
    fail++
    console.log(`  FAIL  ${name}\n        ${e && e.message}`)
  }
}
const assert = require('node:assert/strict')
const os = require('node:os')

// Fixtures are built for the machine the test is running on, so these check the rules themselves
// rather than behaving differently on a Mac. A Windows-shaped path is still worth testing, but only
// where that is the platform's own form; see the guarded check at the end.
const ws = path.join(os.tmpdir(), 'zen-test-workspace')
const docs = path.join(os.tmpdir(), 'zen-test-documents')
const images = path.join(os.tmpdir(), 'zen-test-images')

check('1. a bare filename from the agent means "in the workspace", not "wherever the app is"', () => {
  assert.strictEqual(p.resolveOpenable('welcome.html', ws), path.normalize(path.join(ws, 'welcome.html')))
})

check('2. an absolute path is left alone', () => {
  const abs = path.join(os.tmpdir(), 'shot.png')
  assert.strictEqual(p.resolveOpenable(abs, ws), abs)
})

check('3. a nested agent path resolves under the workspace too', () => {
  assert.strictEqual(p.resolveOpenable('out/report.csv', ws), path.normalize(path.join(ws, 'out', 'report.csv')))
})

check('4. an empty path resolves to nothing rather than to the cwd', () => {
  assert.strictEqual(p.resolveOpenable('', ws), '')
  assert.strictEqual(p.resolveOpenable(null, ws), '')
})

check('5. a file in the workspace is openable, which is the one that used to be refused', () => {
  const target = p.resolveOpenable('welcome.html', ws)
  assert.strictEqual(p.withinAny(target, [docs, ws]), true)
})

check('6. a file in a subfolder of the workspace is openable too', () => {
  assert.strictEqual(p.withinAny(path.join(ws, 'out', 'report.csv'), [docs, ws]), true)
})

check('7. a file outside both folders is still refused', () => {
  assert.strictEqual(p.withinAny(path.join(os.tmpdir(), 'not-in-either-folder.txt'), [docs, ws]), false)
})

check('8. a folder is openable, so the reveal button works on one', () => {
  assert.strictEqual(p.withinAny(ws, [docs, ws]), true)
})

check('9. a sibling that merely starts with the same letters is not inside', () => {
  assert.strictEqual(p.withinAny(`${ws}-old/secret.txt`, [docs, ws]), false)
})

check('10. a parent directory is not inside either', () => {
  assert.strictEqual(p.withinAny(path.dirname(docs), [docs, ws]), false)
})

// Windows-shaped paths are still worth testing, but only on Windows, where that is the real form.
// On a Mac a string like C:/x/y is just a filename with a colon in it, and testing it would be
// testing nothing.
if (process.platform === 'win32') {
  check('13. a drive-letter path from the agent is recognised as absolute', () => {
    const winAbs = path.normalize('C:/Users/Mel/Pictures/shot.png')
    assert.strictEqual(p.resolveOpenable(winAbs, ws), winAbs)
  })
  check('14. a UNC path is recognised as absolute too', () => {
    const unc = path.normalize('\\\\server\\share\\file.txt')
    assert.strictEqual(p.resolveOpenable(unc, ws), unc)
  })
}

check('11. no pictures yet means no note at all, rather than a sentence about nothing', () => {
  assert.strictEqual(p.pictureNote(images, []), '')
  assert.strictEqual(p.pictureNote('', ['a.png']), '')
  assert.strictEqual(p.pictureNote(images, null), '')
})

check('12. the note names the folder and every picture, and points the agent at them', () => {
  const note = p.pictureNote(images, ['one.png', 'two.png'])
  assert.ok(note.includes(images), note)
  assert.ok(note.includes(path.join(images, 'one.png')), note)
  assert.ok(note.includes(path.join(images, 'two.png')), note)
  assert.ok(/read it from there/i.test(note), note)
})

check('13. nothing attached means no note, and a name with no path is not pretended about', () => {
  assert.strictEqual(p.attachmentNote([], [], {}), '')
  assert.strictEqual(p.attachmentNote(null, null, null), '')
  // A document with no path cannot be pointed at, and naming it would only send the agent looking
  // for something that is not there.
  assert.strictEqual(p.attachmentNote([{ name: 'notes.md' }], [], {}), '')
  // A picture that only ever existed as a data URL is not a file on disk.
  assert.strictEqual(
    p.attachmentNote([], [{ name: 'shot.png', url: 'data:image/png;base64,AA' }], {}),
    '',
  )
})

check('14. an attached document is named by path, and the agent is told to read it', () => {
  // Agent mode sent the prompt alone, so an attached .md file reached the agent as nothing at all.
  const note = p.attachmentNote([{ name: 'notes.md', path: 'C:/tmp/notes.md' }], [], {})
  assert.ok(note.includes('notes.md'), note)
  assert.ok(note.includes('C:/tmp/notes.md'), note)
  assert.ok(/read them with your file tools/i.test(note), note)
})

check('15. a document copied into the agent folder is named where it can be opened', () => {
  const copied = { 'C:/elsewhere/notes.md': 'C:/work/attachments/notes.md' }
  const note = p.attachmentNote([{ name: 'notes.md', path: 'C:/elsewhere/notes.md' }], [], copied)
  assert.ok(note.includes('C:/work/attachments/notes.md'), note)
  assert.ok(note.includes('C:/elsewhere/notes.md'), note)
})

check('16. a document outside the agent folder is placed inside it, and one already there is not', () => {
  const ws = path.resolve('/work')
  const inside = path.join(ws, 'notes.md')
  const outside = path.resolve('/elsewhere/report.md')
  const copies = p.attachmentCopies([{ name: 'notes.md', path: inside },
                                     { name: 'report.md', path: outside }], ws)
  assert.strictEqual(copies.length, 1, JSON.stringify(copies))
  assert.strictEqual(copies[0].from, outside)
  assert.strictEqual(copies[0].to, path.join(ws, 'attachments', 'report.md'))
  // No folder to put it in, and nothing attached: nothing to do.
  assert.deepStrictEqual(p.attachmentCopies([{ path: outside }], ''), [])
  assert.deepStrictEqual(p.attachmentCopies([], ws), [])
})

console.log('')
console.log(`=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
