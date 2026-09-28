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

/** an edit endpoint: takes a single reference image */
const SCHEMA_EDIT = {
  components: {
    schemas: {
      EditInput: {
        type: 'object',
        required: ['prompt', 'image_url'],
        properties: {
          prompt: { type: 'string' },
          image_url: { type: 'string' },
          strength: { type: 'number', default: 0.95 },
        },
      },
    },
  },
}

/** an edit endpoint that takes a list of reference images */
const SCHEMA_EDIT_MANY = {
  components: {
    schemas: {
      EditManyInput: {
        type: 'object',
        required: ['prompt', 'image_urls'],
        properties: {
          prompt: { type: 'string' },
          image_urls: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
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
      if (url.pathname === '/schema-edit') return send(SCHEMA_EDIT)
      if (url.pathname === '/schema-edit-many') return send(SCHEMA_EDIT_MANY)
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

  /* ------------------------ an attached reference, i.e. image-to-image */

  // a real (tiny) JPEG data URI, the shape a pasted image takes
  const REF = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64')}`
  const INSTRUCTION = 'make the sky orange and remove the car'

  seen.submit = null
  const edited = await images.generate({
    key: 'stub-key',
    model: 'fal-ai/stub/edit',
    prompt: INSTRUCTION,
    count: 1,
    size: 'square_hd',
    imageUrl: REF,
    imagesDir: outDir,
    endpoints: { queue, schema: `${queue}/schema-edit` },
  })
  check('an edit runs through the same pipeline', edited.ok === true, edited.error || '')
  check(
    'the reference is sent in the parameter the model declares',
    seen.submit?.body?.image_url === REF,
    Object.keys(seen.submit?.body || {}).join(', '),
  )
  check(
    'the instruction is sent verbatim — nothing re-described it on the way out',
    seen.submit?.body?.prompt === INSTRUCTION,
    String(seen.submit?.body?.prompt),
  )
  check(
    'a text-to-image model is never handed an image parameter',
    images.imageParamFor(SCHEMA_FULL.components.schemas.StubInput.properties) === null,
  )

  const reported = (edited.params || []).join(' | ')
  check(
    'the log reports the reference by name and size, never by content',
    /image_url=reference image/.test(reported) && !/base64|data:image/.test(reported),
    reported,
  )

  // a model that wants a list of images still takes a single reference
  seen.submit = null
  await images.generate({
    key: 'stub-key',
    model: 'fal-ai/stub/edit-many',
    prompt: INSTRUCTION,
    count: 1,
    imageUrl: REF,
    imagesDir: outDir,
    endpoints: { queue, schema: `${queue}/schema-edit-many` },
  })
  check(
    'a list-style endpoint gets a one-item list',
    JSON.stringify(seen.submit?.body?.image_urls) === JSON.stringify([REF]),
    JSON.stringify(seen.submit?.body?.image_urls || null).slice(0, 60),
  )

  // a text-only model must refuse, not quietly drop the picture
  seen.submit = null
  const noRef = await images.generate({
    key: 'stub-key',
    model: 'fal-ai/stub/min',
    prompt: INSTRUCTION,
    count: 1,
    imageUrl: REF,
    imagesDir: outDir,
    endpoints: { queue, schema: `${queue}/schema-min` },
  })
  check(
    'a model that cannot take a reference is refused, not ignored',
    noRef.ok === false && /does not accept a reference image/.test(noRef.error) && seen.submit === null,
    noRef.error,
  )

  // attaching a picture with no instruction has nothing to do
  const noText = await images.generate({
    key: 'stub-key',
    model: 'fal-ai/stub/edit',
    prompt: '   ',
    count: 1,
    imageUrl: REF,
    imagesDir: outDir,
    endpoints: { queue, schema: `${queue}/schema-edit` },
  })
  check(
    'an empty instruction is refused with something the user can act on',
    noText.ok === false && /what to change/i.test(noText.error),
    noText.error,
  )

  // the matcher itself
  check('image_url is found by name', images.imageParamFor({ image_url: { type: 'string' } })?.key === 'image_url')
  check(
    'a list parameter is recognised as a list',
    images.imageParamFor({ image_urls: { type: 'array', items: { type: 'string' } } })?.isArray === true,
  )
  check(
    'an unusual name is still found, but sizing is not mistaken for an image',
    images.imageParamFor({ input_image: { type: 'string' } })?.key === 'input_image' &&
      images.imageParamFor({ prompt: { type: 'string' }, image_size: { type: 'string' } }) === null,
  )

  server.close()
  fs.rmSync(outDir, { recursive: true, force: true })
}

/* ---------------------------------------------- the tool the model calls */

/**
 * The same pipeline, reached the way the model reaches it: through the tool
 * registry. A stand-in generator replaces fal, so this proves the wiring —
 * advertisement, argument validation, attachments, error mapping — with no key.
 */
async function toolLayer() {
  console.log('\n=== OFFLINE: generate_image as a tool ===\n')
  const tools = require('../electron/tools.cjs')
  const names = tools.chatToolDefs({}).map((t) => t.function.name)
  check('generate_image is advertised to the model by default', names.includes('generate_image'), names.join(', '))
  check(
    'and can be switched off in Settings → Tools',
    !tools
      .chatToolDefs({ toolToggles: { generate_image: false } })
      .map((t) => t.function.name)
      .includes('generate_image'),
  )
  const rs = tools.responsesToolDefs({}).find((t) => t.name === 'generate_image')
  check('the Responses protocol gets it too, flattened', Boolean(rs?.parameters?.required?.includes('prompt')))

  const schema = tools.REGISTRY.generate_image.schema.function
  check(
    'the schema offers exactly the sizes the picker offers',
    JSON.stringify(schema.parameters.properties.size.enum) === JSON.stringify(images.SIZE_PRESETS.map((p) => p.id)),
    schema.parameters.properties.size.enum.join(', '),
  )
  check(
    'the description tells the model to draw rather than describe',
    /never answer a request like this by\s+describing/i.test(schema.description.replace(/\s+/g, ' ')),
  )

  // a stand-in for fal that records exactly what the tool asked it for
  const calls = []
  let next = {
    ok: true,
    tookMs: 1200,
    model: 'fal-ai/flux/schnell',
    images: [
      { path: 'C:/tmp/zen-1.png', name: 'zen-1.png', url: 'data:image/png;base64,AAAA', bytes: 4, width: 512, height: 512 },
    ],
  }
  const opts = {
    images: {
      key: 'stub-key',
      model: 'fal-ai/flux/schnell',
      imagesDir: 'C:/tmp',
      generate: async (a) => {
        calls.push(a)
        return next
      },
    },
  }

  const ok = await tools.executeTool('generate_image', JSON.stringify({ prompt: 'a red dot on white' }), opts)
  check('a tool call comes back successful', ok.ok === true, ok.error || '')
  check(
    'the picture is handed back as an attachment',
    (ok.images || []).length === 1 && String(ok.images[0].path).endsWith('.png'),
    (ok.images || []).map((i) => i.path).join(', '),
  )
  check(
    'the model gets a short report, never image bytes',
    typeof ok.text === 'string' && ok.text.length < 500 && !/base64/.test(ok.text),
    ok.text,
  )
  check('the report names the model and the time', /schnell/.test(ok.text) && /1\.2s/.test(ok.text), ok.text)
  check('the key and the images folder reach the generator', calls[0]?.key === 'stub-key' && calls[0]?.imagesDir === 'C:/tmp')
  check('the default count is one image', calls[0]?.count === 1, String(calls[0]?.count))

  await tools.executeTool('generate_image', JSON.stringify({ prompt: 'x', count: 99, size: 'portrait_16_9' }), opts)
  check('an absurd count is clamped to 4', calls[1]?.count === 4, String(calls[1]?.count))
  check('a valid size is passed straight through', calls[1]?.size === 'portrait_16_9', String(calls[1]?.size))

  const badSize = await tools.executeTool('generate_image', JSON.stringify({ prompt: 'x', size: 'huge' }), opts)
  check('an unknown size is refused with the list of real ones', badSize.ok === false && /square_hd/.test(badSize.error), badSize.error)
  check('and nothing was generated for it', calls.length === 2, `${calls.length} generator calls`)

  const noPrompt = await tools.executeTool('generate_image', '{}', opts)
  check('a missing prompt is refused', noPrompt.ok === false && /needs a prompt/.test(noPrompt.error), noPrompt.error)

  const noKey = await tools.executeTool(
    'generate_image',
    JSON.stringify({ prompt: 'x' }),
    { images: { ...opts.images, key: '' } },
  )
  check(
    'with no key the model is told exactly what to ask the user for',
    noKey.ok === false && /Settings → Images/.test(noKey.error),
    noKey.error,
  )

  next = { ok: false, error: 'Your fal.ai account is locked: the balance is exhausted.' }
  const failed = await tools.executeTool('generate_image', JSON.stringify({ prompt: 'x' }), opts)
  check('a fal failure becomes the tool error, verbatim', failed.ok === false && /balance/.test(failed.error), failed.error)
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

    // the same pipeline again, but reached the way the model reaches it
    const viaTool = await require('../electron/tools.cjs').executeTool(
      'generate_image',
      JSON.stringify({ prompt: 'a single blue dot centred on a white background', size: 'square' }),
      { images: { key, model: 'fal-ai/flux/schnell', imagesDir: path.join(os.tmpdir(), 'zen-img-live-test') } },
    )
    check(
      'the same thing works through the tool the model calls',
      viaTool.ok === true && (viaTool.images || []).length === 1,
      viaTool.error || viaTool.text,
    )
  } else {
    console.log(`BLOCKED  real generation: ${gen.error}`)
    check('a refused generation fails with an actionable message', /balance|billing/i.test(gen.error || ''), gen.error)
  }
}

;(async () => {
  await offline()
  await toolLayer()
  await live()
  console.log(`\n=== ${pass}/${pass + fail} passed ===`)
  process.exit(fail ? 1 : 0)
})()
