/**
 * ComfyUI, as another way to make a picture.
 *
 * A workflow the user has already built and exported (Workflow → Export (API)) is used as-is: the
 * graph is never rewritten, only its inputs are set. That means this module has to *find* those
 * inputs in an arbitrary graph rather than being told where they are, so `detect` walks the wiring
 * the same way a person reading the canvas would: the prompt is whatever feeds the guider's positive
 * input, the picture to edit is a LoadImage, the seeds are the noise nodes.
 *
 * Nothing here invents a capability. A workflow with no image input cannot edit a picture, and it
 * says so instead of quietly drawing a new one; a workflow whose prompt node cannot be found is
 * refused rather than run with the prompt baked into the file.
 *
 * The server is found, not assumed: ComfyUI's own default is 8188, but the Desktop build listens on
 * 8000, so both are probed and whichever answers is reported.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** ComfyUI's own default first, then the port the Desktop build uses. */
const DEFAULT_PORTS = [8188, 8000]

/** Class names that only carry conditioning through, for walking back from a guider input. */
const CONDITIONING_PASSTHROUGH = new Set([
  'ConditioningZeroOut',
  'ConditioningCombine',
  'ConditioningConcat',
  'ConditioningSetTimestepRange',
  'ConditioningSetArea',
  'ConditioningAverage',
  'ConditioningSetAreaPercentage',
  'ConditioningSetTimestepRangePercent',
])

/** Loader nodes whose filename widget can be checked against what the server actually has. */
const MODEL_FIELDS = {
  CheckpointLoaderSimple: 'ckpt_name',
  CheckpointLoader: 'ckpt_name',
  UNETLoader: 'unet_name',
  CLIPLoader: 'clip_name',
  DualCLIPLoader: 'clip_name1',
  VAELoader: 'vae_name',
  LoraLoader: 'lora_name',
  AV_LoraLoader: 'lora_name',
  UpscaleModelLoader: 'model_name',
  ControlNetLoader: 'control_net_name',
  StyleModelLoader: 'style_model_name',
  IPAdapterModelLoader: 'ipadapter_file',
  ImageOnlyCheckpointLoader: 'ckpt_name',
}

function baseFor(host, port) {
  const h = String(host || '127.0.0.1').trim() || '127.0.0.1'
  return `http://${h}:${Number(port) || DEFAULT_PORTS[0]}`
}

async function req(base, url, { method = 'GET', body, json, timeout = 20000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(`${base}${url}`, {
      method,
      signal: ctrl.signal,
      headers: json ? { 'Content-Type': 'application/json' } : undefined,
      body: json ? JSON.stringify(json) : body,
    })
    const text = await res.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    return { ok: res.ok, status: res.status, json: parsed, text, buf: null }
  } catch (err) {
    return { ok: false, status: 0, json: null, text: '', error: err?.name === 'AbortError' ? 'timed out' : err?.message || 'could not reach it' }
  } finally {
    clearTimeout(timer)
  }
}

async function fetchBytes(base, url, { timeout = 60000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(`${base}${url}`, { signal: ctrl.signal })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || '' }
  } catch (err) {
    return { ok: false, error: err?.message || 'could not be downloaded' }
  } finally {
    clearTimeout(timer)
  }
}

/** Is something ComfyUI-shaped answering on this exact address? */
async function probeOne(base, timeout = 4000) {
  const r = await req(base, '/system_stats', { timeout })
  if (!r.ok || !r.json) return { ok: false, base, error: r.error || `HTTP ${r.status}` }
  const dev = Array.isArray(r.json.devices) ? r.json.devices[0] : null
  return {
    ok: true,
    base,
    stats: {
      version: r.json.system?.comfyui_version || '',
      python: r.json.system?.python_version?.split(' ')[0] || '',
      device: dev?.name || '',
      vramTotal: dev?.vram_total || 0,
      vramFree: dev?.vram_free || 0,
      queueRemaining: Number(r.json.exec_info?.queue_remaining) || 0,
    },
  }
}

/**
 * Find the server. The saved port is tried first because it was chosen deliberately; the defaults
 * come after, because a port that moved should be noticed rather than reported as "ComfyUI is down".
 */
async function findServer({ host = '127.0.0.1', port = 0, timeout = 4000 } = {}) {
  const tried = []
  const wanted = Number(port) || 0
  const order = []
  if (wanted) order.push(wanted)
  for (const p of DEFAULT_PORTS) if (!order.includes(p)) order.push(p)

  for (const p of order) {
    const base = baseFor(host, p)
    tried.push(p)
    const r = await probeOne(base, timeout)
    if (r.ok) return { ...r, host, port: p, tried }
  }
  return {
    ok: false,
    host,
    tried,
    error: wanted
      ? `Nothing answered on ${host}:${order.join(' or ')}.`
      : `Nothing answered on ${host}:${order.join(' or ')}. Start ComfyUI, or set the port by hand.`,
  }
}

/**
 * Where the inputs are in this graph.
 *
 * Pure, so it can be tested against the file itself. Returns node ids and field names; it never
 * writes. `missing` names what a run would need and cannot find, which is what the UI reports.
 */
function detect(graph) {
  const nodes = graph && typeof graph === 'object' ? graph : {}
  const ids = Object.keys(nodes)
  const linkTo = (id, field) => {
    const v = nodes[id]?.inputs?.[field]
    return Array.isArray(v) && v.length ? String(v[0]) : null
  }
  const textNode = (id) => {
    const n = nodes[id]
    if (!n || typeof n.inputs?.text !== 'string') return null
    // a text widget on something other than a text encoder is not a prompt
    if (!/text|prompt/i.test(String(n.class_type))) return null
    return { id, field: 'text', value: n.inputs.text }
  }

  // the guider is whatever node takes a `positive` conditioning input
  const guider = ids.find((id) => linkTo(id, 'positive')) || null

  // walk back from a guider input to the first text encoder behind it
  const walk = (from, avoid) => {
    let cur = from
    for (let hop = 0; hop < 4 && cur; hop += 1) {
      const n = nodes[cur]
      if (!n) return null
      const t = textNode(cur)
      if (t && cur !== avoid) return t
      if (!CONDITIONING_PASSTHROUGH.has(String(n.class_type)) && hop > 0) return null
      // only follow a passthrough's conditioning input, so a zeroed or combined chain is followed
      // and a sampler's unrelated wiring is not
      const next = linkTo(cur, 'conditioning') || linkTo(cur, 'conditioning_1') || linkTo(cur, 'conditioning_2')
      if (!next) return null
      cur = next
    }
    return null
  }

  const positive = guider ? walk(linkTo(guider, 'positive')) : null
  // the negative is only a real, separate prompt when it is its own text encoder: a graph whose
  // negative is the zeroed positive (the Flux2 edit templates) must not have its prompt overwritten
  const negative = guider ? walk(linkTo(guider, 'negative'), positive?.id) : null

  const imageNode = ids.find((id) => String(nodes[id]?.class_type) === 'LoadImage') || null

  const seeds = []
  for (const id of ids) {
    const ins = nodes[id]?.inputs || {}
    if (typeof ins.noise_seed === 'number') seeds.push({ id, field: 'noise_seed' })
    else if (typeof ins.seed === 'number') seeds.push({ id, field: 'seed' })
  }

  const saves = ids
    .filter((id) => /^(SaveImage|SaveImageWebsocket)$/.test(String(nodes[id]?.class_type)))
    .map((id) => ({
      id,
      prefix: String(nodes[id]?.inputs?.filename_prefix || ''),
      // the node ids in these graphs are numbers, and the later stage is the one the user wants
      order: /^\d+$/.test(id) ? Number(id) : 0,
    }))
    .sort((a, b) => a.order - b.order)

  const missing = []
  if (!positive) missing.push('prompt')
  if (imageNode && !nodes[imageNode]?.inputs) missing.push('image')

  return {
    ok: missing.length === 0,
    missing,
    guider,
    positive,
    negative,
    image: imageNode ? { id: imageNode, field: 'image', value: String(nodes[imageNode]?.inputs?.image || '') } : null,
    seeds,
    saves,
    kind: imageNode ? 'edit' : 'txt2img',
  }
}

/** Read a workflow file and describe it. Editor-format files get a message naming the fix. */
function readWorkflow(file) {
  let text
  try {
    text = fs.readFileSync(String(file || ''), 'utf8')
  } catch (err) {
    return { ok: false, error: `That file could not be read (${err?.code || err?.message || 'unknown'}).` }
  }
  let graph
  try {
    graph = JSON.parse(text)
  } catch {
    return { ok: false, error: 'That file is not JSON.' }
  }
  if (graph && Array.isArray(graph.nodes) && Array.isArray(graph.links)) {
    return {
      ok: false,
      error:
        'That is the editor\'s own workflow format. Open it in ComfyUI and use Workflow → Export (API), then add that file.',
    }
  }
  const nodes = graph && typeof graph === 'object' ? Object.keys(graph) : []
  if (!nodes.length || !nodes.every((k) => graph[k] && typeof graph[k].class_type === 'string')) {
    return { ok: false, error: 'That file does not look like an API-format workflow.' }
  }
  const d = detect(graph)
  return {
    ok: true,
    graph,
    detect: d,
    name: path.basename(String(file)).replace(/\.json$/i, ''),
    kind: d.kind,
    nodes: nodes.length,
  }
}

/** The node catalog, cached: it is a large response and it changes only when ComfyUI does. */
const objectInfoCache = new Map()
async function objectInfo(base, { refresh = false } = {}) {
  const hit = objectInfoCache.get(base)
  if (!refresh && hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value
  const r = await req(base, '/object_info', { timeout: 60000 })
  if (!r.ok || !r.json) return null
  objectInfoCache.set(base, { at: Date.now(), value: r.json })
  return r.json
}

/**
 * Can this server actually run this workflow? Node classes first, then the model files the loaders
 * name. A missing custom node is the most common reason a shared workflow fails, and the answer is
 * worth having before a run rather than as a traceback.
 */
async function checkWorkflow(graph, { base }) {
  const info = await objectInfo(base)
  if (!info) return { ok: false, error: 'Could not read the node list from ComfyUI.' }

  const d = detect(graph)
  const missingNodes = []
  for (const id of Object.keys(graph)) {
    const ct = String(graph[id]?.class_type || '')
    if (ct && !info[ct]) missingNodes.push(ct)
  }

  const missingModels = []
  for (const id of Object.keys(graph)) {
    const node = graph[id] || {}
    const field = MODEL_FIELDS[String(node.class_type)]
    if (!field) continue
    const wanted = node.inputs?.[field]
    if (typeof wanted !== 'string' || !wanted) continue
    const options = info[String(node.class_type)]?.input?.required?.[field]
    const list = Array.isArray(options) && Array.isArray(options[0]) ? options[0] : null
    if (!list) continue
    if (!list.includes(wanted)) missingModels.push({ class_type: String(node.class_type), field, wanted })
  }

  return {
    ok: missingNodes.length === 0 && missingModels.length === 0,
    missingNodes: [...new Set(missingNodes)],
    missingModels,
    detect: d,
    nodeCount: Object.keys(graph).length,
  }
}

/** Upload one file to ComfyUI's input folder; its returned name is what LoadImage wants. */
async function uploadImage(base, file) {
  const buf = fs.readFileSync(file)
  const name = path.basename(file).replace(/[^\w.\-]+/g, '_')
  const form = new FormData()
  form.append('image', new Blob([buf]), name)
  form.append('type', 'input')
  form.append('overwrite', 'true')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 60000)
  try {
    const res = await fetch(`${base}/upload/image`, { method: 'POST', body: form, signal: ctrl.signal })
    const json = await res.json().catch(() => null)
    if (!res.ok || !json?.name) return { ok: false, error: `Upload failed (HTTP ${res.status}).` }
    // subfolder is where ComfyUI put it; LoadImage wants "subfolder/name" when it is not at the root
    const stored = json.subfolder ? `${json.subfolder}/${json.name}` : json.name
    return { ok: true, name: stored, raw: json }
  } catch (err) {
    return { ok: false, error: `Could not upload the picture to ComfyUI (${err?.message || 'failed'}).` }
  } finally {
    clearTimeout(timer)
  }
}

/** A fresh seed per run. ComfyUI caches on an identical graph, so a repeated seed returns the old picture. */
function randomSeed() {
  return Math.floor(Math.random() * 2 ** 48)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Live progress from the server's own socket, when this runtime has one. Never fatal. */
function watchProgress(base, clientId, graph, onProgress) {
  let ws = null
  try {
    if (typeof globalThis.WebSocket !== 'function') return () => {}
    ws = new globalThis.WebSocket(`${base.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`)
  } catch {
    return () => {}
  }
  ws.addEventListener('message', (ev) => {
    try {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
      if (m.type === 'progress' && m.data) {
        onProgress({
          phase: 'running',
          detail: `step ${m.data.value} of ${m.data.max}`,
          label: `Drawing — step ${m.data.value} of ${m.data.max}…`,
        })
      } else if (m.type === 'executing' && m.data?.node) {
        const cls = String(graph[m.data.node]?.class_type || '')
        if (cls) onProgress({ phase: 'running', detail: cls, label: `Drawing — ${cls}…` })
      }
    } catch {
      /* a message this runtime cannot read is not a reason to stop watching */
    }
  })
  ws.addEventListener('error', () => {})
  return () => {
    try {
      ws.close()
    } catch {
      /* already gone */
    }
  }
}

/** What the server said went wrong, out of the history entry, in words worth showing. */
function errorFromHistory(entry) {
  const msgs = entry?.status?.messages || []
  for (const m of [...msgs].reverse()) {
    const info = m?.[1]
    if (!info) continue
    if (typeof info.exception_message === 'string' && info.exception_message) return info.exception_message
    if (typeof info.message === 'string' && info.message && /error|fail/i.test(m[0] || '')) return info.message
  }
  const st = String(entry?.status?.status_str || '')
  return st === 'error' ? 'ComfyUI reported an error while running the workflow.' : ''
}

/**
 * Run one workflow. Same contract as the fal path: phases into onProgress, saved images out, with
 * the graph's own shape deciding what an "edit" means.
 */
async function generate({
  base,
  graph,
  prompt,
  negative = '',
  imagePath = '',
  imagesDir,
  label = 'ComfyUI',
  onProgress = () => {},
  timeoutMs = 15 * 60 * 1000,
}) {
  const started = Date.now()
  const d = detect(graph)
  if (!d.positive) {
    return {
      ok: false,
      error:
        'No prompt input could be found in that workflow. It needs a text encoder wired into the guider\'s positive input.',
    }
  }
  if (d.image && !imagePath) {
    return {
      ok: false,
      error: `“${label}” needs a picture to work on. Attach one, or pick a text-to-image workflow.`,
    }
  }
  if (!d.image && imagePath) {
    return {
      ok: false,
      error: `“${label}” has no image input, so it cannot change a picture — it only makes new ones. Pick it in Picture, not Edit.`,
    }
  }

  const work = JSON.parse(JSON.stringify(graph))
  work[d.positive.id].inputs[d.positive.field] = String(prompt || '')
  if (negative && d.negative) work[d.negative.id].inputs[d.negative.field] = String(negative)

  let uploaded = null
  if (d.image && imagePath) {
    onProgress({ phase: 'submitting', detail: 'sending the picture', label: 'Sending the picture to ComfyUI…' })
    const up = await uploadImage(base, imagePath)
    if (!up.ok) return { ok: false, error: up.error }
    uploaded = up.name
    work[d.image.id].inputs[d.image.field] = uploaded
  }

  // a repeat of the same graph returns the cached picture, so every run gets its own noise
  const seeds = {}
  for (const s of d.seeds) {
    const v = randomSeed()
    work[s.id].inputs[s.field] = v
    seeds[s.id] = v
  }

  const clientId = `workburo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const stopWatch = watchProgress(base, clientId, work, onProgress)

  onProgress({ phase: 'submitting', detail: label, label: `Sending to ${label}…` })
  const submitted = await req(base, '/prompt', { method: 'POST', json: { prompt: work, client_id: clientId }, timeout: 60000 })
  if (!submitted.ok || !submitted.json?.prompt_id) {
    stopWatch()
    const why = submitted.json?.error?.message || submitted.json?.error || submitted.text?.slice(0, 200) || submitted.error
    return { ok: false, error: `ComfyUI refused the workflow: ${why || `HTTP ${submitted.status}`}` }
  }
  const promptId = String(submitted.json.prompt_id)
  onProgress({ phase: 'queued', detail: promptId.slice(0, 8), label: 'Waiting for ComfyUI…' })

  let entry = null
  let said = 0
  while (Date.now() - started < timeoutMs) {
    await sleep(600)
    const h = await req(base, `/history/${promptId}`, { timeout: 30000 })
    if (h.ok && h.json && h.json[promptId]) {
      entry = h.json[promptId]
      if (entry.status?.completed || entry.status?.status_str === 'error' || entry.outputs) break
    }
    // say something every so often so a slow run does not read as a hang
    if (Date.now() - said > 12000) {
      said = Date.now()
      const q = await req(base, '/queue', { timeout: 8000 })
      const ahead = Array.isArray(q.json?.queue_pending) ? q.json.queue_pending.length : 0
      onProgress({
        phase: 'running',
        detail: ahead ? `${ahead} ahead` : 'drawing',
        label: ahead ? `Waiting — ${ahead} job${ahead === 1 ? '' : 's'} ahead…` : `Drawing with ${label}…`,
      })
    }
  }
  stopWatch()

  if (!entry) return { ok: false, error: `ComfyUI did not finish within ${Math.round(timeoutMs / 60000)} minutes.` }
  const err = errorFromHistory(entry)
  if (err) return { ok: false, error: err, promptId }
  if (String(entry.status?.status_str || '') !== 'success' && !entry.outputs) {
    return { ok: false, error: 'ComfyUI finished without a result.', promptId }
  }

  // every picture the graph saved, in node order, so the last stage is the one shown first
  const produced = []
  for (const nodeId of Object.keys(entry.outputs || {})) {
    const imgs = entry.outputs[nodeId]?.images
    if (!Array.isArray(imgs)) continue
    for (const im of imgs) produced.push({ nodeId, ...im })
  }
  if (!produced.length) {
    return { ok: false, error: 'The workflow ran but saved no image — add a Save Image node.', promptId }
  }
  produced.sort((a, b) => {
    const na = /^\d+$/.test(a.nodeId) ? Number(a.nodeId) : 0
    const nb = /^\d+$/.test(b.nodeId) ? Number(b.nodeId) : 0
    return na - nb
  })

  fs.mkdirSync(imagesDir, { recursive: true })
  const saved = []
  for (let i = 0; i < produced.length; i += 1) {
    const im = produced[i]
    onProgress({
      phase: 'downloading',
      detail: `image ${i + 1} of ${produced.length}`,
      label: `Saving image ${i + 1} of ${produced.length}…`,
    })
    const qs = new URLSearchParams({
      filename: String(im.filename || ''),
      subfolder: String(im.subfolder || ''),
      type: String(im.type || 'output'),
    })
    const got = await fetchBytes(base, `/view?${qs.toString()}`)
    if (!got.ok) return { ok: false, error: `Could not fetch the picture from ComfyUI (${got.error}).`, promptId }
    const slug = String(label).replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'comfy'
    const name = `comfy-${slug}-${Date.now()}-${i + 1}.png`
    const file = path.join(imagesDir, name)
    fs.writeFileSync(file, got.buf)
    saved.push({
      path: file,
      name,
      url: `data:image/png;base64,${got.buf.toString('base64')}`,
      width: null,
      height: null,
      bytes: got.buf.length,
      node: im.nodeId,
    })
  }

  // the last stage saved is the finished picture; the earlier ones are kept as well
  const primary = saved[saved.length - 1]
  const ordered = [primary, ...saved.filter((s) => s !== primary)]

  return {
    ok: true,
    provider: 'comfy',
    label,
    images: ordered,
    promptId,
    seeds,
    uploaded,
    tookMs: Date.now() - started,
    graph: { nodes: Object.keys(graph).length, kind: d.kind, saves: d.saves.length },
  }
}

/** Stop whatever is running. Exported so a cancel button has somewhere to go later. */
async function interrupt(base) {
  return req(base, '/interrupt', { method: 'POST', json: {}, timeout: 15000 })
}

module.exports = {
  DEFAULT_PORTS,
  baseFor,
  probeOne,
  findServer,
  detect,
  readWorkflow,
  checkWorkflow,
  objectInfo,
  uploadImage,
  generate,
  interrupt,
}
