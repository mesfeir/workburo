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

/* A picture pasted into the composer is a data URL and nothing else. These are the rules that turn
   it into something an agent can open, and the rule that tells the agent what was discussed before
   it was switched on. All three were written and then left unwired — which is why an attached image
   reached the model with agent mode off and never with it on. */
check('17. the bytes inside a data URL can be recovered, and anything else is refused', () => {
  const got = p.dataUrlBytes('data:image/png;base64,QUJD')
  assert.ok(got, 'a plain image data URL must decode')
  assert.strictEqual(got.base64, 'QUJD')
  assert.strictEqual(got.mime, 'image/png')
  assert.strictEqual(p.dataUrlBytes('https://example.com/a.png'), null, 'a remote url has no bytes here')
  assert.strictEqual(p.dataUrlBytes(''), null)
  assert.strictEqual(p.dataUrlBytes(undefined), null)
  assert.strictEqual(p.dataUrlBytes('data:text/plain;base64,QUJD'), null, 'only pictures are written out')
})

check('18. a pasted picture is given a name and a place in the agent folder', () => {
  const targets = p.attachmentImageTargets([
    { name: 'shot.png', url: 'data:image/png;base64,QUJD' },
    { url: 'data:image/png;base64,QUJD' },
    { name: 'already.png', path: path.join(ws, 'already.png') },
    { name: 'nowhere' }
  ], ws)
  assert.strictEqual(targets.length, 3, `an entry with no picture at all must be dropped: ${JSON.stringify(targets)}`)
  assert.strictEqual(targets[0].name, 'shot.png')
  assert.strictEqual(targets[0].to, path.join(ws, 'attachments', 'shot.png'))
  assert.strictEqual(targets[0].dataUrl, 'data:image/png;base64,QUJD')
  assert.strictEqual(targets[1].name, 'attached-2.png', 'an unnamed picture still needs a usable name')
  assert.strictEqual(targets[2].alreadyInside, true, 'a picture already in the workspace stays where it is')
  // Two pictures with one name must not overwrite each other.
  const dupes = p.attachmentImageTargets([
    { name: 'a.png', url: 'data:image/png;base64,QUJD' },
    { name: 'a.png', url: 'data:image/png;base64,QUJD' }
  ], ws)
  assert.notStrictEqual(dupes[0].name, dupes[1].name)
  // No folder to put them in: nothing to plan.
  assert.deepStrictEqual(p.attachmentImageTargets([{ name: 'a.png', url: 'data:image/png;base64,QUJD' }], ''), [])
})

check('19. the agent is told what was said before it was switched on, and what it missed since', () => {
  const m1 = { id: 'm1', role: 'user', content: 'we are building the workburo site' }
  const m2 = { id: 'm2', role: 'assistant', content: 'noted' }
  const m3 = { id: 'm3', role: 'user', content: 'add a search box to the hero' }
  const m4 = { id: 'm4', role: 'user', content: 'and a dark mode toggle' }

  const first = p.agentContextNote([m1, m2, m3], { currentPrompt: 'now switch to agent mode' })
  assert.ok(first.includes('we are building the workburo site'), `the first agent turn must be seeded: ${first}`)
  assert.ok(/before agent mode was switched on/i.test(first), 'and must say why it is being told')
  assert.ok(!first.includes('now switch to agent mode'), 'the prompt being sent must not be repeated back')

  const since = p.agentContextNote([m1, m2, m3, m4], { sinceText: 'add a search box to the hero', currentPrompt: 'and a dark mode toggle' })
  assert.strictEqual(since, '', 'with nothing said in between there is nothing to add, so no note is written')

  // The real case: the conversation carried on while agent mode was off, and the agent has to be
  // told about that stretch — and only that stretch.
  const m3b = { id: 'm3b', role: 'assistant', content: 'the hero already has one, on the right' }
  const missed = p.agentContextNote([m1, m2, m3, m3b, m4], { sinceText: 'add a search box to the hero', currentPrompt: 'and a dark mode toggle' })
  assert.ok(missed.includes('the hero already has one'), `what the agent missed must be carried: ${missed}`)
  assert.ok(!missed.includes('and a dark mode toggle'), 'the prompt is sent separately, never twice')
  assert.ok(!missed.includes('we are building the workburo site'), 'nothing already known may be repeated')
  assert.ok(/agent mode was off/i.test(missed), 'and it must say this is what it missed')

  const byId = p.agentContextNote([m1, m2, m3], { sinceId: 'm1' })
  assert.ok(byId.includes('noted') && byId.includes('add a search box'), 'everything after the anchor is included')
  assert.ok(!byId.includes('we are building the workburo site'), 'and nothing before it')

  assert.strictEqual(p.agentContextNote([], { currentPrompt: 'hello' }), '', 'an empty conversation adds nothing')
  assert.strictEqual(p.lastMessageId([m1, m2]), 'm2', 'the watermark is the newest message id')
  assert.strictEqual(p.lastMessageId([]), '')
})

console.log('')
console.log(`=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
