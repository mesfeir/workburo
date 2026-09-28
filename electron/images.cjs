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
  { id: 'square_hd', label: 'Square · 1024×1024' },
  { id: 'square', label: 'Square (small) · 512×512' },
  { id: 'landscape_4_3', label: 'Landscape · 4:3' },
  { id: 'landscape_16_9', label: 'Wide · 16:9' },
  { id: 'portrait_4_3', label: 'Portrait · 3:4' },
  { id: 'portrait_16_9', label: 'Tall · 9:16' },
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

/** id -> human pricing sentence, from the catalogue the fal website itself uses */
async function pricingMap() {
  try {
    const res = await falFetch(`${PUBLIC_CATALOGUE}?size=50`, { timeout: 20000 })
    if (!res.ok || !res.json?.items) return {}
    const map = {}
    for (const it of res.json.items) {
      const p = it.pricingInfoOverride || it.pricing || ''
      if (it.id && p) {
        map[it.id] = String(p)
          .replace(/\*\*/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 160)
      }
    }
    return map
  } catch {
    return {}
  }
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

/**
 * Build the smallest body the model actually understands: prompt always, the
 * rest only when the schema declares it.
 */
async function buildBody(model, { prompt, count, size, schemaUrl }) {
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
  imagesDir,
  endpoints,
  onProgress = () => {},
}) {
  const ep = { ...DEFAULT_ENDPOINTS, ...(endpoints || {}) }
  if (!key) return { ok: false, error: 'No fal.ai API key saved yet. Add one in Settings → Images.' }
  if (!model) return { ok: false, error: 'No fal.ai model selected. Pick one in Settings → Images.' }
  if (!prompt || !prompt.trim()) return { ok: false, error: 'Nothing to draw — the prompt was empty.' }

  const { body, applied } = await buildBody(model, {
    prompt: prompt.trim(),
    count,
    size,
    schemaUrl: ep.schema,
  })
  onProgress({ phase: 'submitting', detail: `sending to ${model}` })

  const submit = await falFetch(`${ep.queue}/${model}`, { key, method: 'POST', body, timeout: 60000 })
  if (!submit.ok) {
    return { ok: false, error: describeError(submit.status, submit.json || submit.text), status: submit.status }
  }

  const { request_id, status_url, response_url } = submit.json || {}
  if (!status_url || !response_url) {
    return { ok: false, error: 'fal.ai accepted the request but returned no status URL.' }
  }
  onProgress({ phase: 'queued', detail: `request ${request_id || ''}`.trim() })

  const started = Date.now()
  const deadline = started + 6 * 60 * 1000
  let last = ''
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const st = await falFetch(status_url, { key, timeout: 30000 })
    if (!st.ok) return { ok: false, error: describeError(st.status, st.json || st.text) }
    const state = String(st.json?.status || '').toUpperCase()
    if (state === 'COMPLETED' || state === 'OK') break
    const detail =
      state === 'IN_QUEUE'
        ? `queued${st.json?.queue_position != null ? ` · position ${st.json.queue_position}` : ''}`
        : state === 'IN_PROGRESS'
          ? 'generating…'
          : state || 'working…'
    if (detail !== last) {
      last = detail
      onProgress({ phase: state === 'IN_QUEUE' ? 'queued' : 'running', detail })
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
    onProgress({ phase: 'downloading', detail: `image ${i + 1} of ${list.length}` })
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
  SIZE_PRESETS,
  describeError,
  pricingMap,
}
