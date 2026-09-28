#!/usr/bin/env node
/**
 * Tests the fal.ai image pipeline in electron/images.cjs.
 *
 *   node scripts/test-images.cjs
 *
 * Two halves:
 *   OFFLINE  drives the whole submit -> poll -> download -> save path against a
 *            local stand-in that replays fal's documented response shapes. This
 *            runs with no key and no network, and is the part that proves the
 *            parsing, the schema-driven request body and the file writing.
 *   LIVE     only when FAL_KEY is set in the environment: the real catalogue, a
 *            real per-model schema, a bad key, and one real generation. The
 *            key is never printed.
 */
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

const images = require('../electron/images.cjs')

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) {
    pass += 1
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ------------------------------------------------------- a real tiny PNG */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** a valid 8x8 RGB PNG, built here so the test needs no fixture files */
function makePng(size = 8) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  const raw = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 3)
    raw[row] = 0 // filter: none
    for (let x = 0; x < size; x += 1) {
      const p = row + 1 + x * 3
      raw[p] = 200
      raw[p + 1] = 40
      raw[p + 2] = 40
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* --------------------------------------------- a stand-in for fal's queue */

const PNG = makePng()
const seen = { submit: null, polls: 0 }

/** schema with image_size + num_images declared */
const SCHEMA_FULL = {
  components: {
    schemas: {
      StubInput: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: { type: 'string' },
          num_images: { type: 'integer', default: 1, maximum: 4 },
          image_size: {
            default: 'landscape_4_3',
            anyOf: [
              { enum: ['square_hd', 'square', 'landscape_4_3', 'portrait_4_3'] },
              { type: 'object' },
            ],
          },
          output_format: { type: 'string', default: 'jpeg' },
        },
      },
    },
  },
}

/** schema that declares neither: the body must stay minimal */
const SCHEMA_MIN = {
  components: { schemas: { BareInput: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } } } },
}

function startServer(port) {
  return new Promise((resolve) => {
    let polls = 0
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`)
      const send = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      if (url.pathname === '/schema') return send(SCHEMA_FULL)
      if (url.pathname === '/schema-min') return send(SCHEMA_MIN)
      if (url.pathname === '/img.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        return res.end(PNG)
      }
      if (req.method === 'POST' && url.pathname.startsWith('/fal-ai/')) {
        let body = ''
        req.on('data', (c) => {
          body += c
        })
        req.on('end', () => {
          seen.submit = { path: url.pathname, body: JSON.parse(body || '{}'), auth: req.headers.authorization }
          send({
            status: 'IN_QUEUE',
            request_id: 'stub-request-1',
            status_url: `http://127.0.0.1:${port}/status`,
            response_url: `http://127.0.0.1:${port}/result`,
            cancel_url: `http://127.0.0.1:${port}/cancel`,
          })
        })
        return undefined
      }
      if (url.pathname === '/status') {
        polls += 1
        seen.polls = polls
        if (polls === 1) return send({ status: 'IN_QUEUE', queue_position: 2 })
        if (polls === 2) return send({ status: 'IN_PROGRESS' })
        return send({ status: 'COMPLETED' })
      }
      if (url.pathname === '/result') {
        return send({
          images: [{ url: `http://127.0.0.1:${port}/img.png`, width: 512, height: 512, content_type: 'image/png' }],
          seed: 42,
        })
      }
      res.writeHead(404)
      return res.end('{}')
    })
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

async function offline() {
  console.log('\n=== OFFLINE: the whole pipeline against a fal-shaped stand-in ===\n')
  const port = 8811
  const server = await startServer(port)
  const queue = `http://127.0.0.1:${port}`
  const outDir = path.join(os.tmpdir(), `zen-img-test-${Date.now()}`)
  const phases = []

  const res = await images.generate({
    key: 'stub-key',
    model: 'fal-ai/stub/model',
    prompt: 'a single red dot',
    count: 1,
    size: 'square_hd',
    imagesDir: outDir,
    endpoints: { queue, schema: `${queue}/schema` },
    onProgress: (p) => phases.push(p.phase),
  })

  check('generation reports success', res.ok === true, res.error || '')
  check('one image came back', (res.images || []).length === 1)
  const img = (res.images || [])[0] || {}
  check('the file was written to disk', Boolean(img.path) && fs.existsSync(img.path), img.path)
  const onDisk = img.path && fs.existsSync(img.path) ? fs.readFileSync(img.path) : Buffer.alloc(0)
  check('the file is byte-identical to what fal served', onDisk.equals(PNG), `${onDisk.length} vs ${PNG.length} bytes`)
  check('it is a real PNG', onDisk.subarray(0, 8).equals(PNG.subarray(0, 8)))
  check('the extension follows the content type', img.path?.endsWith('.png'), path.extname(img.path || ''))
  const b64 = String(img.url || '').replace(/^data:image\/png;base64,/, '')
  check('the data URL round-trips to the same bytes', Buffer.from(b64, 'base64').equals(PNG))
  check('width/height are carried through', img.width === 512 && img.height === 512)
  check('the seed is surfaced', res.seed === 42)
  check('the request id is surfaced', res.requestId === 'stub-request-1')
  check('it polled until COMPLETED', seen.polls === 3, `${seen.polls} polls`)
  check('progress was reported through the phases', phases.length >= 3, phases.join(' → '))

  check(
    'the body sends only schema-declared parameters',
    JSON.stringify(seen.submit.body) === JSON.stringify({ prompt: 'a single red dot', num_images: 1, image_size: 'square_hd' }),
    JSON.stringify(seen.submit.body),
  )
  check('the key is sent as a fal Key header', seen.submit.auth === 'Key stub-key', String(seen.submit.auth))
  check('the model goes in the path', seen.submit.path === '/fal-ai/stub/model', seen.submit.path)

  // a model that declares no size: the body must not invent one
  seen.submit = null
  await images.generate({
    key: 'stub-key',
    model: 'fal-ai/stub/min',
    prompt: 'x',
    count: 3,
    size: 'square_hd',
    imagesDir: outDir,
    endpoints: { queue, schema: `${queue}/schema-min` },
  })
  check(
    'a model without image_size gets only the prompt',
    JSON.stringify(seen.submit.body) === JSON.stringify({ prompt: 'x' }),
    JSON.stringify(seen.submit.body),
  )

  // a bad key on the same path
  seen.submit = null
  const noKey = await images.generate({ key: '', model: 'fal-ai/stub/model', prompt: 'x', imagesDir: outDir })
  check('a missing key is refused before any network call', noKey.ok === false && /No fal\.ai API key/.test(noKey.error), noKey.error)

  server.close()
  fs.rmSync(outDir, { recursive: true, force: true })
}

async function live() {
  const key = process.env.FAL_KEY
  console.log('\n=== LIVE: the real fal.ai API ===\n')
  if (!key) {
    console.log('SKIP  FAL_KEY is not set — live checks not run\n')
    return
  }

  const bad = await images.listModels('00000000-0000-0000-0000-000000000000:deadbeef')
  check('a wrong key is rejected with a clear message', bad.ok === false && /invalid/i.test(bad.error || ''), bad.error)

  const list = await images.listModels(key)
  const models = list.models || []
  check('the key is accepted and the catalogue loads', list.ok === true, list.error || '')
  check('image models are listed', models.length > 5, `${models.length} of ${list.total} endpoints`)
  const cats = [...new Set(models.map((m) => m.category))]
  check('only image categories are kept', cats.every((c) => c === 'text-to-image' || c === 'image-to-image'), cats.join(', '))
  const withPrice = models.filter((m) => m.pricing).length
  console.log(`      ${models.length} models, ${withPrice} with pricing text`)
  for (const m of models.slice(0, 4)) console.log(`      · ${m.id} — ${m.name}${m.pricing ? ` — ${m.pricing}` : ''}`)

  const schema = await images.schemaFor('fal-ai/flux/schnell')
  check('a real per-model schema loads', Boolean(schema?.properties?.prompt), schema?.name || 'none')
  console.log(`      flux/schnell declares: ${Object.keys(schema?.properties || {}).join(', ')}`)

  const gen = await images.generate({
    key,
    model: 'fal-ai/flux/schnell',
    prompt: 'a single red dot centred on a white background',
    count: 1,
    size: 'square',
    imagesDir: path.join(os.tmpdir(), 'zen-img-live-test'),
  })
  if (gen.ok) {
    check('a real generation succeeded', true, `${gen.images.length} image(s) in ${gen.tookMs}ms`)
  } else {
    console.log(`BLOCKED  real generation: ${gen.error}`)
    check('a refused generation fails with an actionable message', /balance|billing/i.test(gen.error || ''), gen.error)
  }
}

;(async () => {
  await offline()
  await live()
  console.log(`\n=== ${pass}/${pass + fail} passed ===`)
  process.exit(fail ? 1 : 0)
})()
