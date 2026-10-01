'use strict'

// The rules that decide which files this app will open, and what the agent is told about pictures.
// Both were the cause of a real complaint: Open did nothing on a file the agent had just written,
// and an agent asked to use an earlier picture could not find it.

const path = require('node:path')
const p = require('C:/Users/Mel/zen-chat/electron/paths.cjs')

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

const ws = 'C:/Users/Mel/Documents/agent-folder'
const docs = 'C:/Users/Mel/Documents/WorkBuro'

check('1. a bare filename from the agent means "in the workspace", not "wherever the app is"', () => {
  assert.strictEqual(p.resolveOpenable('welcome.html', ws), path.normalize(path.join(ws, 'welcome.html')))
})

check('2. an absolute path is left alone', () => {
  const abs = path.normalize('C:/Users/Mel/Pictures/shot.png')
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
  assert.strictEqual(p.withinAny('C:/Windows/System32/drivers/etc/hosts', [docs, ws]), false)
})

check('8. a folder is openable, so the reveal button works on one', () => {
  assert.strictEqual(p.withinAny(ws, [docs, ws]), true)
})

check('9. a sibling that merely starts with the same letters is not inside', () => {
  assert.strictEqual(p.withinAny(`${ws}-old/secret.txt`, [docs, ws]), false)
})

check('10. a parent directory is not inside either', () => {
  assert.strictEqual(p.withinAny('C:/Users/Mel/Documents', [docs, ws]), false)
})

check('11. no pictures yet means no note at all, rather than a sentence about nothing', () => {
  assert.strictEqual(p.pictureNote('C:/x/images', []), '')
  assert.strictEqual(p.pictureNote('', ['a.png']), '')
  assert.strictEqual(p.pictureNote('C:/x/images', null), '')
})

check('12. the note names the folder and every picture, and points the agent at them', () => {
  const note = p.pictureNote('C:/x/images', ['one.png', 'two.png'])
  assert.ok(note.includes('C:/x/images'), note)
  assert.ok(note.includes(path.join('C:/x/images', 'one.png')), note)
  assert.ok(note.includes(path.join('C:/x/images', 'two.png')), note)
  assert.ok(/read it from there/i.test(note), note)
})

console.log('')
console.log(`=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
