'use strict'

// What a tool call left on disk, in the shape the chat renders.
//
// The bug this guards: the agent's picture tool wrote a file and reported its path truthfully, but
// the file was never looked for, so the chat posted nothing. The picture existed and nothing showed.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

const pi = require('C:/Users/Mel/zen-chat/electron/pi.cjs')

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workburo-out-'))
const workspace = path.join(root, 'workspace')
const images = path.join(root, 'images')
const elsewhere = path.join(root, 'elsewhere')
for (const d of [workspace, images, elsewhere]) fs.mkdirSync(d, { recursive: true })

const picture = path.join(images, 'cute-cat.png')
fs.writeFileSync(picture, 'bytes that only need to be a file')
const stray = path.join(elsewhere, 'not-ours.png')
fs.writeFileSync(stray, 'bytes')
const inWorkspace = path.join(workspace, 'made-by-agent.txt')
fs.writeFileSync(inWorkspace, 'hello')

const resultSaying = (p) => ({ content: [{ type: 'text', text: `Made the picture and saved it as:\n- ${p}\nIt is 1024x1024.` }] })

check('1. a picture the agent made is posted, which is the report that failed', () => {
  const outs = pi.outputsFromTool({
    name: 'generate_image',
    args: { prompt: 'a cute cat' },
    result: resultSaying(picture),
    workspace,
    imagesDir: images,
    since: 0
  })
  assert.equal(outs.images.length, 1, `nothing was posted: ${JSON.stringify(outs)}`)
  assert.equal(outs.images[0].path, path.resolve(picture))
  assert.equal(outs.images[0].name, 'cute-cat.png')
  assert.deepEqual(outs.notPosted, [], 'it complained about its own picture')
})

check('2. a picture outside both folders is still refused', () => {
  const outs = pi.outputsFromTool({
    name: 'generate_image',
    args: { prompt: 'a cat' },
    result: resultSaying(stray),
    workspace,
    imagesDir: images,
    since: 0
  })
  assert.equal(outs.images.length, 0, 'a stray picture was posted')
  assert.equal(outs.notPosted.length, 1, `the refusal was silent: ${JSON.stringify(outs)}`)
})

check('3. a file the agent wrote in its workspace still travels, as before', () => {
  const outs = pi.outputsFromTool({
    name: 'write',
    args: { path: inWorkspace },
    result: { content: [{ type: 'text', text: 'wrote it' }] },
    workspace,
    imagesDir: images,
    since: 0
  })
  assert.equal(outs.files.length, 1, `the file was dropped: ${JSON.stringify(outs)}`)
  assert.equal(outs.files[0].kind, 'txt')
})

check('4. a path a read merely mentions is not posted', () => {
  const outs = pi.outputsFromTool({
    name: 'read',
    args: { path: inWorkspace },
    result: { content: [{ type: 'text', text: `here is ${picture} and ${stray}` }] },
    workspace,
    imagesDir: images,
    since: 0
  })
  assert.equal(outs.images.length, 0, 'a file the agent only looked at was posted')
  assert.equal(outs.files.length, 0, 'a file the agent only looked at was posted')
})

check('5. a failed call posts nothing at all', () => {
  const outs = pi.outputsFromTool({
    name: 'generate_image',
    args: {},
    result: resultSaying(picture),
    workspace,
    imagesDir: images,
    since: 0,
    isError: true
  })
  assert.equal(outs.images.length, 0)
})

check('6. the label the row shows is the app vocabulary, not the raw tool name', () => {
  assert.equal(pi.TOOL_LABELS.generate_image, 'Generate image')
})

fs.rmSync(root, { recursive: true, force: true })

console.log('')
console.log(`=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
