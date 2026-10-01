'use strict'

// The agent's picture tool against the real fal, once.
//
// The stub suite proves the branches. It cannot prove the one thing that actually matters to the
// user: that a picture comes back and lands on disk when the call is real. This makes one real call
// with a real reference picture, using the key already in the app's own store, so nothing is passed
// on a command line and nothing is printed. It reports paths and byte counts, never the key.

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const EXT = path.join(__dirname, '..', 'electron', 'agent-ext', 'generate-image.ts')

const store = JSON.parse(
  fs.readFileSync(path.join(process.env.APPDATA, 'WorkBuro', 'zen-chat-store.json'), 'utf8')
)
const cfg = store.config || {}
const key = String((cfg.imageGen || {}).falKey || '').trim()
if (!key) {
  console.log('no image key in the store, so this cannot run')
  process.exit(1)
}
console.log(`image key present: ${key.length} chars (not printed)`)

const IMAGES = path.join(process.env.APPDATA, 'WorkBuro', 'images')
const WORKSPACE = path.join(os.tmpdir(), 'wb-real-probe')
fs.mkdirSync(WORKSPACE, { recursive: true })

process.env.WORKBURO_FAL_KEY = key
process.env.WORKBURO_IMAGE_MODEL = (cfg.imageGen || {}).model || 'fal-ai/flux-2/klein/9b'
process.env.WORKBURO_IMAGE_EDIT_MODEL = (cfg.imageGen || {}).editModel || ''
process.env.WORKBURO_IMAGES_DIR = IMAGES
process.env.WORKBURO_WORKSPACE = WORKSPACE
console.log(`model: ${process.env.WORKBURO_IMAGE_MODEL}`)
console.log(`edit model: ${process.env.WORKBURO_IMAGE_EDIT_MODEL || '(none set, so edits use the same model)'}`)

// pick a picture this app already made, so the reference path is exercised for real
const existing = fs
  .readdirSync(IMAGES)
  .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
  .map((f) => ({ f, t: fs.statSync(path.join(IMAGES, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)
const reference = existing.length ? path.join(IMAGES, existing[0].f) : null
console.log(reference ? `reference: ${path.basename(reference)} (${Math.round(fs.statSync(reference).size / 1024)} KB)` : 'reference: none available, making a new picture')

async function main () {
  const tools = []
  const mod = await import(pathToFileURL(EXT).href)
  mod.default({ registerTool: (tool) => tools.push(tool) })
  const tool = tools.find((t) => t.name === 'generate_image')
  if (!tool) throw new Error('the tool did not register')

  const before = new Set(fs.readdirSync(IMAGES))
  const started = Date.now()
  const out = await tool.execute(
    'real-1',
    {
      prompt: reference
        ? 'the same building at night, warm windows lit, deep blue sky, cinematic'
        : 'a small stone villa on a hillside at dusk, warm windows lit',
      ...(reference ? { image_path: reference, count: 1 } : {})
    },
    null,
    (u) => console.log(`   … ${u?.content?.[0]?.text || ''}`)
  )
  const took = Date.now() - started

  const text = out?.content?.[0]?.text || ''
  const written = (out?.details?.files || []).filter((f) => fs.existsSync(f))
  console.log(`\nRESULT in ${(took / 1000).toFixed(1)}s`)
  console.log(text.split('\n').map((l) => `   ${l}`).join('\n'))
  console.log(`\n   files on disk: ${written.length}`)

  const after = fs.readdirSync(IMAGES).filter((f) => !before.has(f))
  console.log(`   new files in the app image folder: ${after.length}${after.length ? ` -> ${after.join(', ')}` : ''}`)
  if (after.length) {
    const newest = path.join(IMAGES, after[0])
    const head = fs.readFileSync(newest).subarray(0, 8)
    const isPng = head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG'
    console.log(`   newest: ${fs.statSync(newest).size} bytes, PNG signature: ${isPng ? 'yes' : 'no'}`)
  }
  fs.rmSync(WORKSPACE, { recursive: true, force: true })
  console.log(`\n${written.length && after.length ? 'REAL CALL WORKED' : 'REAL CALL DID NOT PRODUCE A PICTURE'}`)
  process.exit(written.length && after.length ? 0 : 1)
}

main().catch((e) => {
  console.error(`\nREAL CALL FAILED: ${e && e.message ? e.message : e}`)
  process.exit(1)
})
