'use strict'

// The agent's picture tool, actually run.
//
// Why this exists: the tool loaded, Pi registered it, and the turn completed, so everything looked
// right. It still threw "list is not defined" the first time it was called, because the error was
// inside the tool body and nothing had ever executed it. Loading a tool proves the tool exists.
// Only running it proves the tool works. This runs it with fal stubbed out, so it costs nothing and
// needs no network, and it exercises every branch a real call would take.

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const EXT = path.join(__dirname, '..', 'electron', 'agent-ext', 'generate-image.ts')

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-imgtool-'))
const IMAGES = path.join(work, 'images')
const WORKSPACE = path.join(work, 'workspace')
fs.mkdirSync(IMAGES, { recursive: true })
fs.mkdirSync(WORKSPACE, { recursive: true })

// a real 1x1 PNG: the tool writes whatever fal hands it, so the bytes should be a real picture
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const MODEL = 'fal-ai/flux-2/klein/9b'
const EDIT_MODEL = 'fal-ai/nano-banana/edit'
process.env.WORKBURO_FAL_KEY = 'not-a-real-key'
process.env.WORKBURO_FAL_QUEUE = 'https://queue.test'
process.env.WORKBURO_FAL_SCHEMA = 'https://schema.test/openapi.json'
process.env.WORKBURO_IMAGE_MODEL = MODEL
process.env.WORKBURO_IMAGE_EDIT_MODEL = EDIT_MODEL
process.env.WORKBURO_IMAGES_DIR = IMAGES
process.env.WORKBURO_WORKSPACE = WORKSPACE

const requests = []
globalThis.fetch = async (url, init) => {
  const u = String(url)
  requests.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null })
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) })

  if (u.startsWith(process.env.WORKBURO_FAL_SCHEMA)) {
    // only the two real endpoints are described, so a model that declares a reference and one that
    // does not are both covered by the same stub
    const named = [MODEL, EDIT_MODEL]
    if (!named.some((m) => u.includes(encodeURIComponent(m)))) {
      return json({ components: { schemas: {} } })
    }
    return json({
      components: {
        schemas: {
          FluxInput: {
            // image_url so a reference is accepted, num_images so a count is, image_size so a size
            // is, and no strength because the edit endpoint is an instruction editor
            properties: { prompt: {}, num_images: {}, image_size: {}, image_url: {} }
          }
        }
      }
    })
  }
  if (/requests\/[^/]+\/status$/.test(u)) return json({ status: 'COMPLETED' })
  if (/requests\/[^/]+$/.test(u)) {
    const asked = requests.filter((r) => r.body?.num_images).pop()?.body?.num_images || 1
    return json({
      images: Array.from({ length: asked }, (_, i) => ({
        url: `https://cdn.test/picture-${i}.png`,
        width: 1024,
        height: 1024
      }))
    })
  }
  if (u.startsWith('https://cdn.test/')) {
    const jpeg = u.includes('picture-1')
    return {
      ok: true,
      status: 200,
      headers: { get: () => (jpeg ? 'image/jpeg' : 'image/png') },
      arrayBuffer: async () => PNG
    }
  }
  if (u.startsWith('https://queue.test/')) return json({ request_id: 'req-1' })
  return json({})
}

async function main () {
  const tools = []
  const mod = await import(pathToFileURL(EXT).href)
  mod.default({ registerTool: (tool) => tools.push(tool) })

  const tool = tools.find((t) => t.name === 'generate_image')
  check('the tool registers itself as generate_image', Boolean(tool))
  if (!tool) {
    console.log(`\n  ${pass} passed, ${fail} failed`)
    process.exit(1)
  }

  check('the tool declares count', Boolean(tool.parameters?.properties?.count))
  check('the tool declares image_path', Boolean(tool.parameters?.properties?.image_path))

  // 1. the ordinary call. This is the one that threw, so it is the one that matters most.
  let out = null
  let threw = null
  try {
    out = await tool.execute('c1', { prompt: 'a fluffy orange tabby cat on a windowsill' }, null, () => {})
  } catch (e) {
    threw = e
  }
  check('a plain call completes', !threw, threw && threw.message)
  const text = out?.content?.[0]?.text || ''
  check('the result names the file it saved', /- .*\.png/.test(text), text.slice(0, 120))
  check('the result reports the size', /1024x1024/.test(text), text.slice(0, 120))
  check('the picture was written into the app image folder', fs.readdirSync(IMAGES).length === 1)
  check('the picture was written into the workspace too', fs.readdirSync(WORKSPACE).length === 1)
  check('the file is a real picture', fs.readFileSync(path.join(IMAGES, fs.readdirSync(IMAGES)[0])).equals(PNG))
  check('the name says what the picture is', /cat/.test(fs.readdirSync(IMAGES)[0]), fs.readdirSync(IMAGES)[0])
  check('the tool reports details.files', (out?.details?.files || []).length === 2)

  // 2. more than one
  for (const f of fs.readdirSync(IMAGES)) fs.unlinkSync(path.join(IMAGES, f))
  out = await tool.execute('c2', { prompt: 'a villa at night', count: 2 }, null, () => {})
  check('count 2 makes two pictures', fs.readdirSync(IMAGES).length === 2, String(fs.readdirSync(IMAGES).length))
  const named = fs.readdirSync(IMAGES).sort()
  check('several pictures are numbered apart', named[0].includes('-1') && named[1].includes('-2'), named.join(', '))
  check('the result says how many', /2 pictures/.test(out?.content?.[0]?.text || ''))
  check(
    'a jpeg result is saved as .jpg rather than called a png',
    fs.readdirSync(IMAGES).some((f) => f.endsWith('.jpg')),
    fs.readdirSync(IMAGES).join(', ')
  )

  // 3. changing a picture that exists
  const key = process.env.WORKBURO_FAL_KEY
  const reference = path.join(IMAGES, named[0])
  const before = requests.length
  out = await tool.execute('c3', { prompt: 'the same villa by day', image_path: reference }, null, () => {})
  const sent = requests.slice(before).find((r) => r.body?.image_url)
  check('a reference is sent to fal', Boolean(sent))
  check('the reference travels as an inline data uri', String(sent?.body?.image_url || '').startsWith('data:image/png;base64,'))
  check('the result says what it was changed from', /changed from/.test(out?.content?.[0]?.text || ''))
  check(
    'an edit goes to the edit endpoint, not the drawing one',
    requests.slice(before).some((r) => r.url.includes(EDIT_MODEL)),
    requests.slice(before).map((r) => r.url.split('/').slice(-1)[0]).join(', ')
  )
  check('an instruction editor is not sent a strength', !('strength' in (sent?.body || {})))

  // 4. a picture that is not there
  threw = null
  try {
    await tool.execute('c4', { prompt: 'change this', image_path: 'C:/nope/not-here.png' }, null, () => {})
  } catch (e) {
    threw = e
  }
  check('a missing reference is refused in plain words', Boolean(threw) && /There is no picture at/.test(threw.message), threw && threw.message)

  // 5. a model that cannot take a reference says so, rather than ignoring the picture. The models
  //    are read once when the module loads, so this branch needs its own import and its own settings.
  process.env.WORKBURO_IMAGE_EDIT_MODEL = 'fal-ai/text-only/9b'
  const withoutRef = []
  const plain = await import(`${pathToFileURL(EXT).href}?noref=1`)
  plain.default({ registerTool: (tool) => withoutRef.push(tool) })
  threw = null
  try {
    await withoutRef[0].execute('c5', { prompt: 'change this', image_path: reference }, null, () => {})
  } catch (e) {
    threw = e
  }
  check('a model with no reference parameter is refused plainly', Boolean(threw) && /cannot take a picture to change/.test(threw.message), threw && threw.message)
  process.env.WORKBURO_IMAGE_EDIT_MODEL = EDIT_MODEL

  // 6. no key at all. The key is read once when the module loads, so a fresh import is the only
  //    honest way to test the branch the app would hit with no key configured.
  delete process.env.WORKBURO_FAL_KEY
  const fresh = await import(`${pathToFileURL(EXT).href}?nokey=1`)
  const withoutKey = []
  fresh.default({ registerTool: (tool) => withoutKey.push(tool) })
  threw = null
  out = null
  try {
    out = await withoutKey[0].execute('c6', { prompt: 'a cat' }, null, () => {})
  } catch (e) {
    threw = e
  }
  const said = threw ? threw.message : out?.content?.[0]?.text || ''
  check('without a key the tool says so', /key/i.test(said), said.slice(0, 90))
  process.env.WORKBURO_FAL_KEY = key

  fs.rmSync(work, { recursive: true, force: true })
  console.log(`\n  ${pass} passed, ${fail} failed  (the agent's picture tool, run for real)`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('  the suite itself failed:', e)
  process.exit(1)
})
