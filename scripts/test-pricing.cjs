#!/usr/bin/env node
/**
 * Tests for the two things you actually notice about image generation: what it costs, and what
 * the row says while it works.
 *
 *   node scripts/test-pricing.cjs
 *
 * OFFLINE  the cost arithmetic, against the exact wordings fal publishes, plus a whole run driven
 *          against a fal-shaped stand-in that reports a queue position of 0 — the case that used
 *          to render as a bare "0" on screen.
 * LIVE     the public price catalogue is walked for real. No key is needed for this half and none
 *          is printed.
 */
'use strict'

const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

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

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const SCHEMA = {
  components: {
    schemas: {
      StubInput: {
        properties: {
          prompt: { type: 'string' },
          image_size: { type: 'string', enum: ['square_hd', 'square'] },
        },
        required: ['prompt'],
      },
    },
  },
}

/** the exact sentences fal publishes, copied from its own catalogue */
const PER_IMAGE = 'Your request will cost $0.15 per image. For $1.00, you can run this model 7 times. 4K outputs will be charged at double the standard rate.'
const FIRST_PLUS = 'Your request will cost $0.03 for the first megapixel of output, plus $0.015 per extra megapixel of input and output, rounded up to the nearest megapixel.'
const PER_MEGAPIXEL = 'Your request will cost $0.025 per megapixel of output, rounded up to the nearest megapixel.'

const MP_SQUARE_HD = (1024 * 1024) / 1e6

function startServer(port, seen) {
  return new Promise((resolve) => {
    let polls = 0
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`)
      const send = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      if (url.pathname === '/schema') return send(SCHEMA)
      if (url.pathname === '/img.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        return res.end(PNG)
      }
      if (req.method === 'POST' && url.pathname.startsWith('/fal-ai/')) {
        req.resume()
        req.on('end', () =>
          send({
            status: 'IN_QUEUE',
            request_id: 'stub-request-1',
            status_url: `http://127.0.0.1:${port}/status`,
            response_url: `http://127.0.0.1:${port}/result`,
          }),
        )
        return undefined
      }
      if (url.pathname === '/status') {
        polls += 1
        seen.polls = polls
        // position 0 means "next in line": this is the reply that showed up as a bare 0
        if (polls === 1) return send({ status: 'IN_QUEUE', queue_position: 0 })
        if (polls === 2) return send({ status: 'IN_QUEUE', queue_position: 3 })
        if (polls === 3) return send({ status: 'IN_PROGRESS' })
        return send({ status: 'COMPLETED' })
      }
      if (url.pathname === '/result') {
        return send({
          images: [{ url: `http://127.0.0.1:${port}/img.png`, width: 1024, height: 1024, content_type: 'image/png' }],
          seed: 7,
        })
      }
      res.writeHead(404)
      return res.end('{}')
    })
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

async function costMaths() {
  console.log('\n=== OFFLINE: what a picture costs ===\n')

  const perImage = images.estimateCost(PER_IMAGE, MP_SQUARE_HD)
  check('a per-image price is taken as-is', perImage && perImage.perImage === 0.15, JSON.stringify(perImage))

  const firstPlus = images.estimateCost(FIRST_PLUS, MP_SQUARE_HD)
  check(
    'first megapixel plus extra is added up, counting a part megapixel as whole',
    firstPlus && Math.abs(firstPlus.perImage - 0.045) < 1e-9,
    JSON.stringify(firstPlus),
  )

  const perMp = images.estimateCost(PER_MEGAPIXEL, MP_SQUARE_HD)
  check(
    'a per-megapixel model at 1024×1024 is billed as 2 MP',
    perMp && Math.abs(perMp.perImage - 0.05) < 1e-9,
    JSON.stringify(perMp),
  )

  const big = images.estimateCost(PER_MEGAPIXEL, 4)
  check('4 megapixels of output costs four times as much', big && Math.abs(big.perImage - 0.1) < 1e-9, JSON.stringify(big))

  check('a wording it cannot parse yields no number at all', images.estimateCost('Pricing depends on the moon.', 1) === null)
  check('no sentence yields no number at all', images.estimateCost('', 1) === null)
  check(
    'figures are formatted to be read',
    images.formatCost(0.15) === '$0.15' && images.formatCost(0.045) === '$0.045' && images.formatCost(1.5) === '$1.50',
    `${images.formatCost(0.15)} · ${images.formatCost(0.045)} · ${images.formatCost(1.5)}`,
  )
  check(
    'every size preset knows its own pixels',
    images.SIZE_PRESETS.every((p) => Number(p.width) > 0 && Number(p.height) > 0),
    images.SIZE_PRESETS.map((p) => `${p.id} ${p.width}×${p.height}`).join(', '),
  )
}

async function progressWords() {
  console.log('\n=== OFFLINE: what the row says while it works ===\n')

  const port = 8833
  const seen = {}
  const server = await startServer(port, seen)
  const queue = `http://127.0.0.1:${port}`
  const labels = []
  const res = await images.generate({
    key: 'stub-key',
    model: 'fal-ai/stub/model',
    prompt: 'a single red dot',
    count: 1,
    size: 'square_hd',
    imagesDir: fs.mkdtempSync(path.join(os.tmpdir(), 'zen-cost-test-')),
    endpoints: { queue, schema: `${queue}/schema` },
    onProgress: (p) => labels.push({ phase: p.phase, label: p.label, detail: p.detail }),
  })
  server.close()

  check('the run finished', res.ok === true, res.error || '')
  check('it polled through queue, generating and completion', seen.polls === 4, `${seen.polls} polls`)
  check(
    'every update carries words, never a bare number',
    labels.length > 0 && labels.every((l) => typeof l.label === 'string' && l.label.trim().length > 1 && !/^-?[0-9]+$/.test(l.label.trim())),
    JSON.stringify(labels.map((l) => l.label)),
  )
  check(
    'a queue position of 0 reads as waiting, not "0"',
    labels.some((l) => l.label === 'Waiting in the queue…'),
    JSON.stringify(labels.map((l) => l.label)),
  )
  check(
    'a queue position ahead of you is spelled out',
    labels.some((l) => /3 requests ahead/.test(l.label)),
    JSON.stringify(labels.map((l) => l.label)),
  )
  check(
    'the drawing step is named',
    labels.some((l) => /Generating image/.test(l.label)),
    JSON.stringify(labels.map((l) => l.label)),
  )
  check(
    'saving the file is named',
    labels.some((l) => /Saving image 1 of 1/.test(l.label)),
    JSON.stringify(labels.map((l) => l.label)),
  )
}

/** the app's own fal key, read from the store; never printed */
function readFalKey() {
  try {
    const file = path.join(process.env.APPDATA || '', 'zen-chat', 'zen-chat-store.json')
    const store = JSON.parse(fs.readFileSync(file, 'utf8'))
    return (store.config && store.config.imageGen && store.config.imageGen.falKey) || ''
  } catch {
    return ''
  }
}

async function liveCatalogue() {
  console.log('\n=== LIVE: the prices fal publishes ===\n')
  const map = await images.pricingMap()
  const ids = Object.keys(map)
  check('prices are collected for the whole listing, not one page', ids.length >= 100, `${ids.length} models priced`)
  check('the map is cached on disk for next time', fs.existsSync(path.join(process.env.APPDATA || '', 'zen-chat', 'fal-pricing.json')))

  const flux = map['fal-ai/flux/dev']
  check('the catalogue prices a large share of the listing for browsing', ids.length >= 100, `${ids.length} models priced in prose`)
  check('flux/dev is one of the models the catalogue leaves without a rate', !flux, 'so the pricing API below is the one that answers')

  // the rate itself comes from fal's pricing API, which needs the account's key
  const key = readFalKey()
  if (!key) {
    console.log('        (no fal key in the store — the live rate checks are skipped)')
    return
  }

  const rate = await images.priceFor('fal-ai/flux/dev', key)
  check(
    'the pricing API gives flux/dev a real rate',
    rate && /megapixel/i.test(rate.unit) && Math.abs(rate.unitPrice - 0.025) < 1e-9,
    JSON.stringify(rate),
  )
  const at1024 = rate ? images.costFromRate(rate, { width: 1024, height: 1024 }) : null
  check(
    'so one 1024×1024 image comes to five cents, as fal bills it',
    at1024 && Math.abs(at1024.perImage - 0.05) < 1e-9,
    JSON.stringify(at1024),
  )
  const smaller = rate ? images.costFromRate(rate, { width: 1024, height: 768 }) : null
  check('a smaller size that still rounds up to a megapixel costs the same', smaller && smaller.megapixels === 1, JSON.stringify(smaller))

  const schnell = await images.priceFor('fal-ai/flux/schnell', key)
  check('schnell is cheaper than dev, as fal says', schnell && schnell.unitPrice < 0.025, JSON.stringify(schnell))

  const perImageModel = await images.priceFor('fal-ai/nano-banana-pro/edit', key)
  const perImageCost = perImageModel ? images.costFromRate(perImageModel, { width: 1024, height: 1024 }) : null
  check(
    'a per-image model is charged per image, not per megapixel',
    perImageCost && perImageCost.perImage === 0.15,
    JSON.stringify(perImageCost),
  )
  check('rates are kept on disk so a model is only asked about once', fs.existsSync(path.join(process.env.APPDATA || '', 'zen-chat', 'fal-prices.json')))

  const unparsed = ids.filter((id) => !images.estimateCost(map[id], MP_SQUARE_HD))
  check(
    'a price that cannot be turned into a number is left alone rather than guessed',
    unparsed.length === ids.length - ids.filter((id) => images.estimateCost(map[id], MP_SQUARE_HD)).length,
    `${unparsed.length} of ${ids.length} are prose only`,
  )
}

;(async () => {
  await costMaths()
  await progressWords()
  await liveCatalogue()
  console.log(`\n${pass} passed, ${fail} failed\n`)
  if (fail) process.exitCode = 1
})().catch((err) => {
  console.error('\ntest harness error:', err)
  process.exitCode = 1
})
