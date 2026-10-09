/* Google Gemini — both halves of the app's Gemini support.
 *
 * Chat: the app talks to Gemini through its OpenAI-compatible layer, which is just another entry in
 * the profile list (baseUrl https://generativelanguage.googleapis.com/v1beta/openai), so the existing
 * OpenAI client, streaming and model listing all work untouched.
 *
 * Pictures: Gemini's image models ("Nano Banana") are not an OpenAI-shaped endpoint, so they live
 * here and are reached by the same "way of making a picture" the fal and ComfyUI providers use.
 *
 * The API surface this talks to (from Google's own docs, not invented):
 *   POST /v1beta/models/{model}:generateContent   x-goog-api-key   {contents:[{parts:[…]}], generationConfig:{responseModalities:['IMAGE']}}
 *   POST /v1beta/interactions                     x-goog-api-key   {model, input:[{type:'text'|'image', …}]}
 *   GET  /v1beta/models                           x-goog-api-key   (the catalogue)
 * The interactions endpoint is the newer of the two and generateContent the long-standing one; both
 * are attempted, and the reply is parsed liberally because neither can be exercised without a key.
 *
 * A picture comes back as base64 inside the JSON. It is written to disk here and never carried
 * around as a data URL. The key is only ever read from the store by the caller and is never logged.
 */

const fs = require('fs')
const path = require('path')

const API = 'https://generativelanguage.googleapis.com/v1beta'

/* The image family. Used only to label what the picker shows — the list itself is read from the API
 * so a new Nano Banana appears without shipping an app build. */
const IMAGE_HINT = /(-image|-image-preview|nano-banana)/i

/* What the app offers before it has ever asked Google. Kept small and honest: the picker refreshes
 * from the API as soon as there is a key. */
const FALLBACK_IMAGE_MODELS = [
  { id: 'gemini-3.1-flash-image', name: 'Nano Banana 2 (Gemini 3.1 Flash Image)' },
  { id: 'gemini-3.1-flash-lite-image', name: 'Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image)' },
  { id: 'gemini-3-pro-image', name: 'Nano Banana Pro (Gemini 3 Pro Image)' },
  { id: 'gemini-2.5-flash-image', name: 'Nano Banana (Gemini 2.5 Flash Image)' },
]

function describeError(status, body) {
  let text = ''
  try {
    const j = typeof body === 'string' ? JSON.parse(body) : body
    text = (j && j.error && (j.error.message || j.error.status)) || (j && j.message) || ''
  } catch {
    text = String(body || '').slice(0, 300)
  }
  if (status === 401 || status === 403) {
    return `Google rejected the Gemini key (HTTP ${status}). Check the key in Settings.${text ? ` Google said: ${text}` : ''}`
  }
  if (status === 429) return `Gemini is rate-limiting or the quota is used up (HTTP 429).${text ? ` Google said: ${text}` : ''}`
  if (status === 404) return `Google has no such model or route (HTTP 404).${text ? ` Google said: ${text}` : ''}`
  return `Gemini request failed (HTTP ${status}).${text ? ` Google said: ${text}` : ''}`
}

async function call(url, { key, method = 'GET', body, timeout = 180000 } = {}) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeout)
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'x-goog-api-key': String(key || ''),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      const err = new Error(describeError(res.status, text))
      err.status = res.status
      throw err
    }
    try {
      return text ? JSON.parse(text) : {}
    } catch {
      throw new Error('Gemini answered with something that is not JSON.')
    }
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Gemini took too long to answer and was given up on.')
    throw e
  } finally {
    clearTimeout(t)
  }
}

/* ------------------------------------------------------------------ catalogue */

/** Every model Google will admit to, filtered down to the picture-making ones. */
async function listImageModels(key) {
  if (!key) return { models: FALLBACK_IMAGE_MODELS, live: false }
  try {
    const j = await call(`${API}/models?pageSize=200`, { key })
    const all = Array.isArray(j.models) ? j.models : []
    const images = all
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((id) => IMAGE_HINT.test(id))
      .map((id) => ({ id, name: id }))
    return images.length ? { models: images, live: true } : { models: FALLBACK_IMAGE_MODELS, live: false }
  } catch {
    // A key that cannot list models can still generate; the fallback keeps the picker usable.
    return { models: FALLBACK_IMAGE_MODELS, live: false }
  }
}

/** True when the id is one this module can run. */
function isImageModel(model) {
  const id = String(model || '')
  return id.startsWith('gemini:') && !!id.slice('gemini:'.length)
}

function modelFromId(model) {
  return String(model || '').slice('gemini:'.length)
}

/* ------------------------------------------------------------------ the reply */

/** Pull the first base64 picture out of any shape Google has been seen to answer with.
 *
 * The reply is scanned rather than picked apart field-by-field on purpose: generateContent returns
 * candidates[].content.parts[].inlineData, and the interactions endpoint returns its own block.
 * Accepting any object that carries base64 image bytes makes a working call succeed even if the
 * wrapper around it moved, and it cannot turn a text-only reply into a fake picture.
 */
function findInlineImage(node, depth = 0) {
  if (!node || depth > 12) return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findInlineImage(item, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (typeof node !== 'object') return null

  const mime = node.mimeType || node.mime_type || node.media_type
  const data = node.data || node.bytesBase64Encoded || node.inline_data?.data
  // Long enough to be bytes and shaped like base64. Deliberately not a size contest: a 1x1 PNG is a
  // perfectly valid answer, and judging by bulk rejected small-but-real pictures while telling nobody
  // why. Prose fails the character test instead, which is the thing actually being guarded against.
  const plausible = typeof data === 'string' && data.length >= 64 && /^[A-Za-z0-9+/=\r\n]+$/.test(data)
  if (plausible && (!mime || /^image\//i.test(String(mime)))) {
    return { data, mimeType: String(mime || 'image/png') }
  }
  for (const v of Object.values(node)) {
    const hit = findInlineImage(v, depth + 1)
    if (hit) return hit
  }
  return null
}

/** Any text the model wrote alongside (or instead of) a picture — used for honest failures. */
function findText(node, depth = 0) {
  if (!node || depth > 12) return ''
  if (Array.isArray(node)) return node.map((n) => findText(n, depth + 1)).filter(Boolean).join('\n')
  if (typeof node !== 'object') return ''
  if (typeof node.text === 'string' && node.text.trim()) return node.text.trim()
  return Object.values(node).map((v) => findText(v, depth + 1)).filter(Boolean).join('\n')
}

function extForMime(mime) {
  const m = String(mime || '').toLowerCase()
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg'
  if (m.includes('webp')) return 'webp'
  return 'png'
}

/* ------------------------------------------------------------------ making one */

function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Build the request parts. A reference picture makes it an edit; without one it is a generation,
 * which is the same endpoint and the same model — Gemini edits by being shown an image. */
function parts({ prompt, reference }) {
  const out = []
  const text = String(prompt || '').trim()
  if (text) out.push({ text })
  if (reference && reference.data) {
    out.push({ inline_data: { mime_type: reference.mimeType || 'image/png', data: reference.data } })
  }
  return out
}

/**
 * Make one picture. Returns { file, mimeType, model, text } — the file being a real path on disk.
 *
 * `reference` is optional: { data (base64), mimeType }. With it the model is asked to change the
 * picture it is shown; without it, to draw a new one.
 */
async function generate({ key, model, prompt, reference, imagesDir, count = 1, timeout = 240000 }) {
  if (!key) throw new Error('No Gemini key. Add one in Settings, under Google Gemini.')
  const id = modelFromId(model)
  if (!id) throw new Error('No Gemini image model was chosen.')
  // Google refuses a request that carries neither words nor a picture, and its 400 does not say so
  // in plain terms. Say it plainly here instead. Either one alone is fine — an instruction, or an
  // image to work on.
  if (!String(prompt || '').trim() && !(reference && reference.data)) {
    throw new Error('Gemini needs something to work with: describe what to draw or change, or attach a picture.')
  }

  const body = {
    contents: [{ role: 'user', parts: parts({ prompt, reference }) }],
    generationConfig: { responseModalities: ['IMAGE'] },
  }

  let reply
  let firstError = null
  try {
    reply = await call(`${API}/models/${encodeURIComponent(id)}:generateContent`, { key, method: 'POST', body, timeout })
  } catch (e) {
    firstError = e
    // Google has moved this call to /interactions on newer models, so a 404 — "no such route" — is
    // worth a second attempt in the other shape. A 400 is not: it means Google read the request and
    // refused it, and retrying it elsewhere only buries the real explanation under an unrelated one.
    // That happened for real: an empty prompt 400'd, the fallback 404'd with "model not found", and
    // the user was told a model that works perfectly well does not exist.
    if (e.status !== 404) throw e
    const input = []
    const text = String(prompt || '').trim()
    if (text) input.push({ type: 'text', text })
    if (reference && reference.data) {
      input.push({ type: 'image', mime_type: reference.mimeType || 'image/png', data: reference.data })
    }
    try {
      reply = await call(`${API}/interactions`, { key, method: 'POST', body: { model: id, input }, timeout })
    } catch (second) {
      // Neither route worked. The first one is the real story; the second is only context.
      throw new Error(`${firstError.message} (the newer /interactions route also refused: ${second.message})`)
    }
  }

  const found = findInlineImage(reply)
  if (!found) {
    const said = findText(reply).slice(0, 400)
    throw new Error(said ? `Gemini did not return a picture. It said: ${said}` : 'Gemini did not return a picture.')
  }

  const dir = imagesDir || process.cwd()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `gemini-${stamp()}-${Math.random().toString(36).slice(2, 7)}.${extForMime(found.mimeType)}`)
  fs.writeFileSync(file, Buffer.from(found.data, 'base64'))

  return { file, mimeType: found.mimeType, model: id, text: findText(reply).slice(0, 2000), count: Number(count) || 1 }
}

/** Is the key good? One authenticated call that needs it, per the hosted-API rule. */
async function checkKey(key) {
  if (!key) return { ok: false, error: 'no key' }
  try {
    await call(`${API}/models?pageSize=1`, { key, timeout: 30000 })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

module.exports = {
  API,
  IMAGE_HINT,
  FALLBACK_IMAGE_MODELS,
  listImageModels,
  isImageModel,
  modelFromId,
  generate,
  checkKey,
  findInlineImage,
  describeError,
}
