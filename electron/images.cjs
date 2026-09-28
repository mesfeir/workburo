/**
 * fal.ai image generation, main process only.
 *
 * The renderer never sees the key and never talks to fal: it asks for a model
 * list or a generation, and gets back finished files. Everything here is driven
 * by fal's own catalogue and per-endpoint OpenAPI schema, so we only ever send
 * parameters a model actually declares instead of guessing and eating a 422.
 */
const path = require('node:path')
const fs = require('node:fs')

const CATALOGUE = 'https://api.fal.ai/v1/models'
const PUBLIC_CATALOGUE = 'https://fal.ai/api/models'
const PRICING_API = 'https://api.fal.ai/v1/models/pricing'
const SCHEMA_API = 'https://fal.ai/api/openapi/queue/openapi.json'
const QUEUE = 'https://queue.fal.run'
const UA = 'zen-chat/1.0'

/**
 * Real fal endpoints. A caller may pass its own set to drive the whole submit →
 * poll → download pipeline against a local stand-in; the app never does, and the
 * IPC handler builds its args field by field so a renderer cannot supply one.
 */
const DEFAULT_ENDPOINTS = { queue: QUEUE, schema: SCHEMA_API }

/** size presets; the schema decides whether a model accepts one at all */
const SIZE_PRESETS = [
  { id: 'square_hd', label: 'Square · 1024×1024', width: 1024, height: 1024 },
  { id: 'square', label: 'Square (small) · 512×512', width: 512, height: 512 },
  { id: 'landscape_4_3', label: 'Landscape · 4:3', width: 1024, height: 768 },
  { id: 'landscape_16_9', label: 'Wide · 16:9', width: 1024, height: 576 },
  { id: 'portrait_4_3', label: 'Portrait · 3:4', width: 768, height: 1024 },
  { id: 'portrait_16_9', label: 'Tall · 9:16', width: 576, height: 1024 },
]

/** the image categories worth showing in a generator */
const IMAGE_CATEGORIES = ['text-to-image', 'image-to-image']

const schemaCache = new Map()

/** Turn any fal failure into something a person can act on. */
function describeError(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body || {})
  let detail = ''
  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body
    detail = parsed?.detail || parsed?.error?.message || parsed?.message || ''
  } catch {
    detail = text.slice(0, 200)
  }
  if (status === 401 || status === 403) {
    if (/exhausted balance|user is locked/i.test(detail)) {
      return 'Your fal.ai account is locked: the balance is exhausted. Top up at fal.ai/dashboard/billing, then test again.'
    }
    if (status === 401) return 'fal.ai rejected the API key (invalid or revoked).'
    return detail || 'fal.ai refused the request (403).'
  }
  if (status === 422) return `fal.ai rejected the parameters: ${detail || 'validation error'}`
  if (status === 404) return 'That model endpoint does not exist on fal.ai any more.'
  if (status === 429) return 'fal.ai is rate-limiting this key. Try again shortly.'
  if (status >= 500) return `fal.ai had a server error (${status}). Try again.`
  return detail || `fal.ai returned HTTP ${status}.`
}

async function falFetch(url, { key, method = 'GET', body, timeout = 60000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { Authorization: `Key ${key}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return { ok: res.ok, status: res.status, json, text }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The authenticated catalogue. Also the honest way to test a key: fal answers
 * 401 for a bad key and 200 for a good one.
 */
async function listModels(key, { pages = 3 } = {}) {
  if (!key) return { ok: false, error: 'No fal.ai API key saved yet.' }
  const out = []
  let cursor = ''
  for (let i = 0; i < pages; i += 1) {
    const url = `${CATALOGUE}?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const res = await falFetch(url, { key, timeout: 30000 })
    if (!res.ok) return { ok: false, error: describeError(res.status, res.json || res.text), status: res.status }
    const models = res.json?.models || []
    out.push(...models)
    cursor = res.json?.next_cursor || ''
    if (!res.json?.has_more || !cursor) break
  }

  const mapped = out
    .map((m) => ({
      id: m.endpoint_id || '',
      name: m.metadata?.display_name || m.endpoint_id || '',
      description: m.metadata?.description || '',
      category: m.metadata?.category || '',
      status: m.metadata?.status || '',
      license: m.metadata?.license_type || '',
      thumbnail: m.metadata?.thumbnail_url || '',
    }))
    .filter((m) => m.id && IMAGE_CATEGORIES.includes(m.category))
    .filter((m) => !/deprecated|removed|hidden/i.test(m.status))

  // pricing comes from the public catalogue; it is a nicety, never a hard fail
  const pricing = await pricingMap()
  for (const m of mapped) if (pricing[m.id]) m.pricing = pricing[m.id]

  mapped.sort((a, b) =>
    a.category === b.category ? a.name.localeCompare(b.name) : a.category === 'text-to-image' ? -1 : 1,
  )
  return { ok: true, models: mapped, total: out.length }
}

/**
 * id -> the price sentence fal publishes for that endpoint.
 *
 * fal's models API carries no price at all, and the public catalogue that does is paged: 40 a
 * page, 38 pages for the whole listing. Asking for one page priced 17 models out of 226 — useless
 * for "what will this cost me" — so the listing is walked in full, a few pages at a time, and kept
 * on disk for a week: a price does not need re-fetching on every visit to Settings.
 */
const PRICING_TTL_MS = 7 * 24 * 60 * 60 * 1000
let pricingMemory = null

function pricingCachePath() {
  return path.join(process.env.APPDATA || process.cwd(), 'zen-chat', 'fal-pricing.json')
}

async function pricingMap({ refresh = false } = {}) {
  if (!refresh && pricingMemory && Date.now() - pricingMemory.at < PRICING_TTL_MS) return pricingMemory.map
  if (!refresh) {
    try {
      const onDisk = JSON.parse(fs.readFileSync(pricingCachePath(), 'utf8'))
      if (onDisk && onDisk.map && Date.now() - onDisk.at < PRICING_TTL_MS) {
        pricingMemory = onDisk
        return onDisk.map
      }
    } catch {
      // no usable cache yet; fetch it below
    }
  }
  const map = await fetchAllPricing()
  if (Object.keys(map).length) {
    pricingMemory = { at: Date.now(), map }
    try {
      fs.mkdirSync(path.dirname(pricingCachePath()), { recursive: true })
      fs.writeFileSync(pricingCachePath(), JSON.stringify(pricingMemory))
    } catch {
      // the cache is a convenience, not a requirement
    }
  }
  return map
}

async function fetchAllPricing() {
  const map = {}
  const collect = (items) => {
    for (const it of items || []) {
      const p = it.pricingInfoOverride || it.pricing || ''
      if (!it.id || !p) continue
      map[it.id] = String(p)
        .replace(/\*\*/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200)
    }
  }

  let pages = 1
  try {
    const first = await falFetch(`${PUBLIC_CATALOGUE}?page=1`, { timeout: 20000 })
    if (!first.ok || !first.json?.items) return map
    collect(first.json.items)
    pages = Math.min(Number(first.json.pages) || 1, 60)
  } catch {
    return map
  }

  const queue = []
  for (let page = 2; page <= pages; page += 1) queue.push(page)
  const workers = Array.from({ length: 5 }, async () => {
    while (queue.length) {
      const page = queue.shift()
      try {
        const r = await falFetch(`${PUBLIC_CATALOGUE}?page=${page}`, { timeout: 20000 })
        if (r.ok) collect(r.json?.items)
      } catch {
        // one missing page does not spoil the rest of the prices
      }
    }
  })
  await Promise.all(workers)
  return map
}

/**
 * What one image costs, in dollars, from the sentence fal publishes.
 *
 * fal bills either per image or per megapixel, and bills a part megapixel as a whole one — a
 * 1024×1024 square is 1.05 MP and is charged as 2 MP on a per-megapixel model. Only the wordings
 * fal actually uses are parsed; anything else returns null rather than a made-up number.
 */
function estimateCost(pricing, megapixels) {
  const text = String(pricing || '')
  if (!text) return null
  const mp = Math.max(1, Math.ceil(Number(megapixels) || 0))
  const money = (s) => Number(String(s).replace(/[^0-9.]/g, ''))

  const perImage = text.match(/\$([0-9]+(?:\.[0-9]+)?)\s*per\s*image/i)
  if (perImage) return { perImage: money(perImage[1]), basis: 'per image', megapixels: mp }

  const firstPlus = text.match(
    /\$([0-9]+(?:\.[0-9]+)?)\s*for the first megapixel[^$]*\$([0-9]+(?:\.[0-9]+)?)\s*per extra megapixel/i,
  )
  if (firstPlus) {
    return {
      perImage: money(firstPlus[1]) + money(firstPlus[2]) * (mp - 1),
      basis: 'first megapixel plus extra',
      megapixels: mp,
    }
  }

  const perMp = text.match(/\$([0-9]+(?:\.[0-9]+)?)\s*per\s*megapixel/i)
  if (perMp) return { perImage: money(perMp[1]) * mp, basis: 'per megapixel', megapixels: mp }

  return null
}

/** a dollar figure a person can read, keeping the precision a small amount needs */
function formatCost(perImage) {
  const n = Number(perImage) || 0
  if (n >= 0.1) return `$${n.toFixed(2)}`
  const three = n.toFixed(3)
  return `$${three.endsWith('0') ? n.toFixed(2) : three}`
}

/**
 * The rate fal actually charges for one endpoint, straight from its pricing API.
 *
 * The public catalogue states a price in prose for some models and says nothing about the rate for
 * others — fal-ai/flux/dev, the model this app starts on, is one of the silent ones — but the
 * pricing API answers for every endpoint with a number and a unit. It only takes one endpoint at a
 * time, so results are kept on disk: only the models actually chosen are ever asked about.
 */
const PRICE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const priceMemory = new Map()

function priceCachePath() {
  return path.join(process.env.APPDATA || process.cwd(), 'zen-chat', 'fal-prices.json')
}

function priceCacheRead() {
  if (priceCacheRead.done) return
  priceCacheRead.done = true
  try {
    const onDisk = JSON.parse(fs.readFileSync(priceCachePath(), 'utf8'))
    for (const [id, entry] of Object.entries(onDisk || {})) {
      // a lookup that found nothing is not an answer: only real rates are worth keeping
      if (entry && entry.rate && Date.now() - (entry.at || 0) < PRICE_TTL_MS) priceMemory.set(id, entry)
    }
  } catch {
    // no cache yet
  }
}

function priceCacheWrite() {
  try {
    fs.mkdirSync(path.dirname(priceCachePath()), { recursive: true })
    const out = {}
    for (const [id, entry] of priceMemory) out[id] = entry
    fs.writeFileSync(priceCachePath(), JSON.stringify(out))
  } catch {
    // the cache is a convenience, not a requirement
  }
}

async function priceFor(model, key) {
  const id = String(model || '')
  if (!id) return null
  priceCacheRead()
  const hit = priceMemory.get(id)
  if (hit) return hit.rate

  let rate = null
  try {
    const res = await falFetch(`${PRICING_API}?endpoint_id=${encodeURIComponent(id)}`, { key, timeout: 20000 })
    const p = res.json && Array.isArray(res.json.prices) ? res.json.prices[0] : null
    if (p && Number.isFinite(Number(p.unit_price))) {
      rate = { unitPrice: Number(p.unit_price), unit: String(p.unit || ''), currency: String(p.currency || 'USD') }
    }
  } catch {
    return null
  }
  // only a real rate is remembered: a keyless or failed lookup must not become the answer for a week
  if (rate) {
    priceMemory.set(id, { at: Date.now(), rate })
    priceCacheWrite()
  }
  return rate
}

/**
 * Dollars for one image at a given output size, from a rate and its unit.
 *
 * megapixels and processed megapixels are billed rounded up to the whole megapixel, which is what
 * makes a 1024×1024 square cost two megapixels rather than one. Units that are not about images or
 * megapixels (seconds of compute, and so on) have no per-image answer to give, so none is invented.
 */
function costFromRate(rate, { width, height } = {}) {
  const price = Number(rate && rate.unitPrice)
  if (!Number.isFinite(price)) return null
  const unit = String((rate && rate.unit) || '').toLowerCase()
  const mp = Math.max(1, Math.ceil(((Number(width) || 0) * (Number(height) || 0)) / 1e6))
  if (unit.includes('megapixel')) {
    return { perImage: price * mp, megapixels: mp, basis: `${formatCost(price)} per megapixel`, unit: rate.unit }
  }
  if (unit.includes('image')) {
    return { perImage: price, megapixels: mp, basis: `${formatCost(price)} per image`, unit: rate.unit }
  }
  return { perImage: null, megapixels: mp, basis: `${formatCost(price)} per ${rate.unit || 'unit'}`, unit: rate.unit }
}

/** The endpoint's real input schema: property names, enums, required fields. */
async function schemaFor(model, schemaUrl = SCHEMA_API) {
  const cacheKey = `${schemaUrl}|${model}`
  if (schemaCache.has(cacheKey)) return schemaCache.get(cacheKey)
  const res = await falFetch(`${schemaUrl}?endpoint_id=${encodeURIComponent(model)}`, { timeout: 20000 })
  let schema = null
  if (res.ok && res.json) {
    const comps = res.json.components?.schemas || {}
    for (const [name, sch] of Object.entries(comps)) {
      if (/Input$/.test(name) && sch?.properties) {
        schema = { name, properties: sch.properties, required: sch.required || [] }
        break
      }
    }
  }
  schemaCache.set(cacheKey, schema)
  return schema
}

/** Pull the allowed string values out of a fal enum-ish property. */
function enumValues(prop) {
  if (!prop) return []
  const found = new Set()
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node.enum)) node.enum.forEach((v) => typeof v === 'string' && found.add(v))
    if (Array.isArray(node.anyOf)) node.anyOf.forEach(walk)
    if (Array.isArray(node.oneOf)) node.oneOf.forEach(walk)
  }
  walk(prop)
  return [...found]
}

/** the parameter names fal endpoints use for a reference image, most common first */
const IMAGE_INPUT_KEYS = [
  'image_url',
  'image_urls',
  'image',
  'input_image',
  'image_reference',
  'reference_image',
  'init_image',
]

/** Which of a model's parameters takes the reference image, if any. */
function imageParamFor(props) {
  for (const key of IMAGE_INPUT_KEYS) {
    const prop = props?.[key]
    if (!prop) continue
    return { key, isArray: prop.type === 'array' || Boolean(prop.items) }
  }
  // A wider net for unusual spellings, but never a counter or a sizing option:
  // num_images and image_size are not image inputs.
  const match = Object.keys(props || {}).find(
    (k) => /(^|_)images?(_|$)/.test(k) && !/num|count|size|format|strength|checker|per/.test(k),
  )
  if (match) {
    const prop = props[match]
    return { key: match, isArray: prop?.type === 'array' || Boolean(prop?.items) }
  }
  return null
}

/**
 * Build the smallest body the model actually understands: prompt always, the
 * rest only when the schema declares it.
 */
async function buildBody(model, { prompt, count, size, imageUrl, schemaUrl }) {
  const schema = await schemaFor(model, schemaUrl)
  const props = schema?.properties || {}
  const body = { prompt }
  const applied = []

  if (props.num_images) {
    const max = Number(props.num_images.maximum) || 4
    body.num_images = Math.max(1, Math.min(count || 1, max))
    applied.push(`num_images=${body.num_images}`)
  }

  if (props.image_size) {
    const allowed = enumValues(props.image_size)
    const wanted = size || 'square_hd'
    if (!allowed.length || allowed.includes(wanted)) {
      body.image_size = wanted
    } else if (allowed.includes('square_hd')) {
      body.image_size = 'square_hd'
    } else if (allowed.includes('square')) {
      body.image_size = 'square'
    }
    if (body.image_size) applied.push(`image_size=${body.image_size}`)
  } else if (props.aspect_ratio && props.aspect_ratio.default) {
    applied.push(`aspect_ratio=${props.aspect_ratio.default} (model default)`)
  }

  if (props.enable_safety_checker) {
    // stay on fal's default; recorded in the log so the behaviour is inspectable
    applied.push('safety checker: fal default')
  }

  // a reference image turns this into an edit: the same user text is the prompt
  if (imageUrl) {
    const param = imageParamFor(props)
    if (!param) {
      return {
        body,
        applied,
        schema,
        error:
          `${model} does not accept a reference image, so it cannot edit one. Pick an image-to-image ` +
          'model in Settings → Images.',
      }
    }
    body[param.key] = param.isArray ? [imageUrl] : imageUrl
    // never log the data URI itself, only how big it is
    applied.push(`${param.key}=reference image (${Math.round(String(imageUrl).length / 1024)} KB inline)`)
  }

  return { body, applied, schema }
}

function extFor(contentType, url) {
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('png')) return 'png'
  if (ct.includes('webp')) return 'webp'
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg'
  const m = /\\.(png|jpe?g|webp)/i.exec(String(url || ''))
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'png'
}

function mimeFor(ext) {
  return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
}

/** Download one result and write it beside the store; returns the attachment. */
async function persistImage(item, imagesDir, index = 0) {
  const res = await fetch(item.url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`Could not download the generated image (HTTP ${res.status}).`)
  const buf = Buffer.from(await res.arrayBuffer())
  const ext = extFor(item.content_type || res.headers.get('content-type'), item.url)
  const name = `zen-${Date.now()}-${index + 1}.${ext}`
  const file = path.join(imagesDir, name)
  fs.mkdirSync(imagesDir, { recursive: true })
  fs.writeFileSync(file, buf)
  return {
    path: file,
    name,
    url: `data:${mimeFor(ext)};base64,${buf.toString('base64')}`,
    width: item.width || null,
    height: item.height || null,
    bytes: buf.length,
  }
}

/**
 * Generate images. Submits to fal's queue, polls it, then downloads the results
 * into the app's own image folder and hands back data URLs for display.
 */
async function generate({
  key,
  model,
  prompt,
  count = 1,
  size,
  imageUrl,
  imagesDir,
  endpoints,
  onProgress = () => {},
}) {
  const ep = { ...DEFAULT_ENDPOINTS, ...(endpoints || {}) }
  if (!key) return { ok: false, error: 'No fal.ai API key saved yet. Add one in Settings → Images.' }
  if (!model) return { ok: false, error: 'No fal.ai model selected. Pick one in Settings → Images.' }
  if (!prompt || !prompt.trim()) {
    return {
      ok: false,
      error: imageUrl
        ? 'Tell me what to change about the image — the instruction was empty.'
        : 'Nothing to draw — the prompt was empty.',
    }
  }

  const { body, applied, error: bodyError } = await buildBody(model, {
    prompt: prompt.trim(),
    count,
    size,
    imageUrl,
    schemaUrl: ep.schema,
  })
  if (bodyError) return { ok: false, error: bodyError }
  onProgress({ phase: 'submitting', detail: `sending to ${model}`, label: `Sending to ${model}…` })

  const submit = await falFetch(`${ep.queue}/${model}`, { key, method: 'POST', body, timeout: 60000 })
  if (!submit.ok) {
    let error = describeError(submit.status, submit.json || submit.text)
    // a reference that fal will not take is the likeliest cause of a rejected edit
    if (imageUrl && submit.status === 422) {
      error +=
        ' The reference image may be too large, or this endpoint may want a hosted URL rather than inline data — try another edit model in Settings → Images.'
    }
    return { ok: false, error, status: submit.status }
  }

  const { request_id, status_url, response_url } = submit.json || {}
  if (!status_url || !response_url) {
    return { ok: false, error: 'fal.ai accepted the request but returned no status URL.' }
  }
  onProgress({ phase: 'queued', detail: `request ${request_id || ''}`.trim(), label: 'Waiting in the queue…' })

  const started = Date.now()
  const deadline = started + 6 * 60 * 1000
  let last = ''
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const st = await falFetch(status_url, { key, timeout: 30000 })
    if (!st.ok) return { ok: false, error: describeError(st.status, st.json || st.text) }
    const state = String(st.json?.status || '').toUpperCase()
    if (state === 'COMPLETED' || state === 'OK') break
    // what the user reads while they wait: words, never a raw queue position. fal's position 0
    // means "next in line", and a bare number on its own told nobody anything.
    const ahead = Number(st.json?.queue_position)
    const label =
      state === 'IN_QUEUE'
        ? !Number.isFinite(ahead) || ahead <= 0
          ? 'Waiting in the queue…'
          : `Waiting in the queue — ${ahead} request${ahead === 1 ? '' : 's'} ahead…`
        : state === 'IN_PROGRESS'
          ? 'Generating image…'
          : `${state || 'Working'}…`
    const detail =
      state === 'IN_QUEUE'
        ? `queued${st.json?.queue_position != null ? ` · position ${st.json.queue_position}` : ''}`
        : state === 'IN_PROGRESS'
          ? 'generating…'
          : state || 'working…'
    if (label !== last) {
      last = label
      onProgress({ phase: state === 'IN_QUEUE' ? 'queued' : 'running', detail, label })
    }
    if (state === 'FAILED' || state === 'ERROR') {
      return { ok: false, error: st.json?.error || 'fal.ai reported the request failed.' }
    }
  }
  if (Date.now() >= deadline) return { ok: false, error: 'fal.ai timed out after 6 minutes.' }

  const out = await falFetch(response_url, { key, timeout: 60000 })
  if (!out.ok) return { ok: false, error: describeError(out.status, out.json || out.text) }

  const list = Array.isArray(out.json?.images) ? out.json.images : []
  if (!list.length) {
    const kind = out.json?.video ? 'video' : out.json?.audio ? 'audio' : 'unknown'
    return {
      ok: false,
      error: `That model returned ${kind} output, not images — pick a text-to-image model.`,
    }
  }

  fs.mkdirSync(imagesDir, { recursive: true })
  const saved = []
  for (let i = 0; i < list.length; i += 1) {
    onProgress({ phase: 'downloading', detail: `image ${i + 1} of ${list.length}`, label: `Saving image ${i + 1} of ${list.length}…` })
    try {
      saved.push(await persistImage(list[i], imagesDir, i))
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  return {
    ok: true,
    images: saved,
    model,
    requestId: request_id || '',
    tookMs: Date.now() - started,
    params: applied,
    seed: out.json?.seed ?? null,
  }
}

module.exports = {
  listModels,
  generate,
  schemaFor,
  persistImage,
  buildBody,
  imageParamFor,
  SIZE_PRESETS,
  describeError,
  pricingMap,
  estimateCost,
  formatCost,
  priceFor,
  costFromRate,
}
