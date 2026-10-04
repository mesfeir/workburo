/*
 * WorkBuro server mode.
 *
 * The app can serve itself: this file answers HTTP for the phone (and anything else on the network
 * you point at it) while the app is running. It is the same application, not a second one -- the
 * app's own modules do the work (messages.cjs maps the conversation, documents.cjs reads the
 * attachments, images.cjs talks to fal, pi.cjs runs the agent), so this file is transport, identity
 * and auth rather than a parallel implementation. Those modules are required, never edited.
 *
 * Two rules hold the design together:
 *
 *   1. The provider keys never reach the client. The browser talks to this server; this server holds
 *      the keys. Nothing on the network is ever handed a credential that spends money.
 *   2. Every path comes from the app. Windows puts user data in %APPDATA%, macOS in
 *      ~/Library/Application Support -- so nothing here may assume a platform or a repository
 *      location. main.cjs passes the real directories in when it starts the server.
 *
 * Auth is an API key. Every /api route requires it; the page gets it once (from the QR code the
 * settings pane shows), keeps it in its own storage, and immediately drops it out of the URL. The
 * key is compared in constant time, failed attempts are counted, and regenerating it evicts every
 * device at once.
 */
'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const messagesLib = require('./messages.cjs')       // toChatMessages: the app's own conversation mapping
const documentsLib = require('./documents.cjs')     // blocksFor: reads attached documents into text
const filesLib = require('./files.cjs')             // extract: pdf/docx/xlsx/csv/text
const imagesLib = require('./images.cjs')           // generate/listModels: the app's fal pipeline
const titlesLib = require('./title.cjs')            // the app's own title rules
const sourcesLib = require('./model-sources.cjs')   // sourcesFor/keyFor/parseModels: which providers to ask
const piLib = require('./pi.cjs')                   // the agent harness: spawns Pi, streams its events
const pathsLib = require('./paths.cjs')             // agentContextNote: what the agent has not been told yet

/*
 * Filled in by start(). Nothing is derived from the environment, because the app already knows where
 * its own renderer, store, images, agent and uploads live -- and on macOS they are not where Windows
 * would put them.
 */
const where = {}
let apiKey = ''
let agentAllowed = false
const activeTurns = new Map()

/* Where the phone reaches this server, for the QR code and the settings pane. */
let addresses = []
let listening = null

const span = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160)

/* ---------------------------------------------------------------- identity */

const keyEquals = (given) => {
  if (!apiKey || !given) return false
  const a = Buffer.from(String(given))
  const b = Buffer.from(apiKey)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

let failedAttempts = 0
const requestLog = []
let lastRefusal = 0

function logRequest(req, status, ms, note) {
  const ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '')
  requestLog.push({ at: Date.now(), method: req.method, path: req.url.split('?')[0], ip, status, ms, note })
  if (requestLog.length > 300) requestLog.splice(0, requestLog.length - 300)
}

/* The key may arrive as a header (every normal call) or once as ?key= (the QR code link). */
function presentedKey(req, url) {
  const h = req.headers.authorization || ''
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim()
  const q = url.searchParams.get('key')
  return q ? String(q).trim() : ''
}

function authorised(req, url) {
  if (keyEquals(presentedKey(req, url))) return true
  failedAttempts += 1
  lastRefusal = Date.now()
  return false
}

/* ---------------------------------------------------------------- the store, read-only */

function config() {
  const s = JSON.parse(fs.readFileSync(where.store, 'utf8'))
  return s.config || {}
}

/* What the page is allowed to know: settings, never secrets. */
function publicConfig() {
  const c = config()
  return {
    baseUrl: c.baseUrl,
    model: c.model,
    systemPrompt: c.systemPrompt || '',
    temperature: c.temperature,
    maxTokens: c.maxTokens,
    thinking: c.thinking,
    modelPrefs: c.modelPrefs || {},
    imageGen: {
      enabled: c.imageGen?.enabled !== false,
      model: c.imageGen?.model || 'fal-ai/flux/schnell',
      editModel: c.imageGen?.editModel || 'fal-ai/flux-pro/kontext',
      size: c.imageGen?.size || 'square_hd',
      count: c.imageGen?.count || 1,
    },
    agent: {
      workspace: c.agent?.workspace || '',
      enabled: Boolean(c.agent?.enabled),
      allowed: agentAllowed,
      piInstalled: piLib.status(where.pi).installed,
      piVersion: piLib.status(where.pi).version,
    },
    hasFalKey: Boolean(c.imageGen?.falKey || process.env.ZEN_FAL_KEY),
  }
}

/* The provider in use, with its key. Never logged, never returned. */
function upstream() {
  const c = config()
  let base = String(c.baseUrl || '').replace(/\/+$/, '')
  return { base, key: String(c.apiKey || '').trim(), cfg: c }
}

function headersFor(cfg, accept, keyOverride) {
  const h = {
    'Content-Type': 'application/json',
    // opencode's WAF answers a request with no User-Agent with a 403
    'User-Agent': 'WorkBuro/1.0 (Windows; Electron)',
    Accept: accept || 'application/json',
  }
  const key = String(keyOverride !== undefined ? keyOverride : cfg.apiKey || '').trim()
  if (key) h.Authorization = `Bearer ${key}`
  let host = ''
  try {
    host = new URL(String(cfg.baseUrl || '').replace(/\/+$/, '')).hostname
  } catch {}
  if (cfg.sendAffinity !== false && /opencode\.ai$/i.test(host)) {
    h['x-opencode-session'] = cfg.affinityId || 'wb-web'
  }
  return h
}

/* The endpoint a turn goes to, and the key that belongs to it, resolved the way the app does it. */
function endpointFor(chosenBase) {
  const cfg = config()
  const base = sourcesLib.normalize(chosenBase || cfg.baseUrl)
  const profile = (cfg.profiles || []).find((p) => p && sourcesLib.normalize(p.baseUrl) === base)
  return {
    base,
    key: sourcesLib.keyFor({ ...cfg, baseUrl: base }),
    affinity: profile ? Boolean(profile.affinity) : /opencode\.ai$/i.test((() => {
      try {
        return new URL(base).hostname
      } catch {
        return ''
      }
    })()),
  }
}

/* ---------------------------------------------------------------- chat */

/* the same body main builds in buildChatBody */
function chatBody(req, cfgIn) {
  const cfg = cfgIn || config()
  const model = req.model || cfg.model
  const prefs = (cfg.modelPrefs || {})[model] || {}
  const vision = prefs.vision || 'unknown'
  const thinking = prefs.thinking !== undefined ? prefs.thinking : cfg.thinking

  const mapped = (req.messages || []).map((m) => {
    if (!m || m.role !== 'user' || !Array.isArray(m.documents) || !m.documents.length) return m
    let docBlock = ''
    try {
      docBlock = documentsLib.blocksFor(m) || ''
    } catch (err) {
      docBlock = `[could not read the attachment: ${err.message}]`
    }
    return { ...m, docBlock }
  })

  const body = {
    model,
    messages: messagesLib.toChatMessages(mapped, req.systemPrompt ?? cfg.systemPrompt, vision),
    stream: true,
    // reasoning models spend max_tokens on hidden thinking, so keep the same floor main uses
    max_tokens: Math.max(Number(Number(req.maxTokens ?? cfg.maxTokens) || 0), 2048),
    reasoning_effort: cfg.thinking === false || prefs.thinking === false ? 'none' : 'medium',
  }
  const temp = Number(req.temperature ?? cfg.temperature)
  if (Number.isFinite(temp) && temp !== 1) body.temperature = temp
  return { body, model, vision }
}

async function chat(req, res) {
  const cfg = config()
  // the model the renderer picked carries the endpoint it belongs to, so a turn goes to the provider
  // that model came from rather than to whichever endpoint happens to be first
  const target = endpointFor(req.baseUrl)
  if (!target.base) return json(res, 400, { ok: false, error: 'no endpoint is configured in the app' })
  const { body } = chatBody(req, cfg)

  const ac = new AbortController()
  res.on('close', () => ac.abort())

  let up
  try {
    up = await fetch(`${target.base}/chat/completions`, {
      method: 'POST',
      headers: headersFor({ ...cfg, baseUrl: target.base, sendAffinity: target.affinity }, 'text/event-stream', target.key),
      body: JSON.stringify(body),
      signal: ac.signal,
    })
  } catch (err) {
    return json(res, 502, { ok: false, error: `could not reach ${target.base}: ${err.message}` })
  }

  if (!up.ok || !up.body) {
    const text = await up.text().catch(() => '')
    let detail = text.slice(0, 400)
    try {
      detail = JSON.parse(text).error?.message || detail
    } catch {}
    return json(res, up.status || 502, { ok: false, error: detail || `the provider answered ${up.status}` })
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
  try {
    for await (const chunk of up.body) res.write(chunk)
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: { message: `the stream broke: ${err.message}` } })}\n\n`)
  }
  res.end()
}

/* ---------------------------------------------------------------- models */

let modelCache = null

/*
 * Every provider the app would ask, each with its own key, merged the way the app merges them: the
 * endpoint in use first, then the saved profiles, then a server on this machine. Asking only the
 * active endpoint is why the picker showed one model while the app showed all of them.
 */
async function models(res) {
  const cfg = config()
  if (modelCache && Date.now() - modelCache.at < 60_000) return json(res, 200, modelCache.value)

  const sources = sourcesLib.sourcesFor(cfg, null)
  const groups = []
  const flat = []

  await Promise.all(
    sources.map(async (s) => {
      const group = { provider: s.provider, baseUrl: s.baseUrl, models: [], key: '', affinity: Boolean(s.affinity) }
      try {
        const up = await fetch(`${s.baseUrl}/models`, {
          headers: headersFor({ ...cfg, baseUrl: s.baseUrl, sendAffinity: s.affinity }, 'application/json', s.key),
        })
        if (!up.ok) {
          const t = await up.text().catch(() => '')
          let detail = t.slice(0, 120)
          try {
            detail = JSON.parse(t).error?.message || detail
          } catch {}
          group.error = sourcesLib.tidyError(up.status, detail)
        } else {
          group.models = sourcesLib.parseModels(await up.json().catch(() => ({}))).map((m) => ({
            ...m,
            provider: s.provider,
            baseUrl: s.baseUrl,
          }))
        }
      } catch (err) {
        group.error = sourcesLib.tidyError(0, err.message)
      }
      groups.push(group)
      flat.push(...group.models)
    }),
  )

  const value = { ok: true, count: flat.length, models: flat, groups, base: cfg.baseUrl }
  modelCache = { at: Date.now(), value }
  json(res, 200, value)
}

/* ---------------------------------------------------------------- images */

let imageModelCache = null

async function imageModels(res) {
  const key = String(config().imageGen?.falKey || process.env.ZEN_FAL_KEY || '').trim()
  if (!key) return json(res, 200, { ok: false, error: 'no fal key saved in the app' })
  if (imageModelCache && Date.now() - imageModelCache.at < 10 * 60_000) return json(res, 200, imageModelCache.value)
  try {
    const out = await imagesLib.listModels(key, { pages: 2, categories: 'text-to-image' })
    // listModels answers { ok, models: [...] }, not an array: wrapping that again handed the picker an
    // object where it wanted a list, so the image models never appeared
    const list = Array.isArray(out) ? out : out.models || []
    const value = { ok: out.ok !== false, models: list, total: list.length, error: out.error }
    imageModelCache = { at: Date.now(), value }
    json(res, 200, value)
  } catch (err) {
    json(res, 200, { ok: false, error: err.message, models: [] })
  }
}

async function image(req, res) {
  const cfg = config()
  const key = String(cfg.imageGen?.falKey || process.env.ZEN_FAL_KEY || '').trim()
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
  const send = (type, value) => res.write(`data: ${JSON.stringify({ type, value })}\n\n`)

  if (!key) {
    send('result', { ok: false, error: 'No fal.ai key saved in the app. Add one in Settings, Images.' })
    return res.end()
  }

  try {
    const out = await imagesLib.generate({
      key,
      model: req.model || cfg.imageGen?.model || 'fal-ai/flux/schnell',
      prompt: req.prompt || '',
      count: req.count || cfg.imageGen?.count || 1,
      size: req.size || cfg.imageGen?.size,
      imageUrl: req.imageUrl || undefined,
      strength: req.strength,
      imagesDir: where.images,
      onProgress: (p) => send('progress', p),
    })
    send('result', out)
  } catch (err) {
    send('result', { ok: false, error: err.message })
  }
  res.end()
}

/* ---------------------------------------------------------------- the store, shared */

/*
 * The phone and the desktop are one application, so they share one list of conversations. Two rules
 * make that safe:
 *
 *   - Going out, only what the phone needs is sent. The store holds provider keys; publicConfig()
 *     already strips them, and conversations carry no secrets, so the payload is settings-plus-chats
 *     and nothing else.
 *   - Coming in, only conversations are taken. A phone may add or edit chats; it may never rewrite
 *     the machine's settings, and it can never overwrite or erase a key it was never given.
 */
function readStore() {
  return JSON.parse(fs.readFileSync(where.store, 'utf8'))
}

function writeStoreAtomic(data) {
  const tmp = `${where.store}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, where.store)
}

function storeOut() {
  const s = readStore()
  return { ok: true, config: publicConfig(), conversations: s.conversations || [], activeId: s.activeId || null }
}

function storeIn(body) {
  const incoming = JSON.parse(body || '{}')
  const current = readStore()
  const before = JSON.stringify(current.conversations || [])
  if (Array.isArray(incoming.conversations)) current.conversations = incoming.conversations
  if (typeof incoming.activeId === 'string' || incoming.activeId === null) current.activeId = incoming.activeId
  const after = JSON.stringify(current.conversations || [])
  if (before !== after) writeStoreAtomic(current)
  /* the desktop window is showing this list too, so it is told to re-read rather than guess */
  if (before !== after && typeof where.onStoreChanged === 'function') {
    try { where.onStoreChanged() } catch {}
  }
  return { ok: true, changed: before !== after, conversations: (current.conversations || []).length }
}

/* ---------------------------------------------------------------- pairing */

/*
 * Nobody should have to type a 43-character key on a phone, and a key in a URL ends up in history and
 * in bookmarks. So the settings pane shows a six-digit code that is good for five minutes; the phone
 * opens /pair, types it once, and receives the key into its own storage. The code is single use and
 * dies after a handful of wrong guesses, which is what makes six digits enough.
 */
const PAIR_TTL_MS = 5 * 60 * 1000
const PAIR_TRIES = 5
let pair = { code: '', at: 0, tries: 0 }

function issuePairCode() {
  pair = { code: String(crypto.randomInt(100000, 1000000)), at: Date.now(), tries: 0 }
  return { code: pair.code, expiresAt: pair.at + PAIR_TTL_MS, seconds: PAIR_TTL_MS / 1000 }
}

function pairState() {
  const left = Math.max(0, Math.round((pair.at + PAIR_TTL_MS - Date.now()) / 1000))
  return { active: Boolean(pair.code) && left > 0, expiresIn: left, triesLeft: Math.max(0, PAIR_TRIES - pair.tries) }
}

/* Returns the key on a good code, null otherwise. Single use, and it burns out after PAIR_TRIES. */
function redeemPairCode(given) {
  const left = pair.at + PAIR_TTL_MS - Date.now()
  if (!pair.code || left <= 0) return null
  if (String(given || '').trim() !== pair.code) {
    pair.tries += 1
    if (pair.tries >= PAIR_TRIES) pair = { code: '', at: 0, tries: 0 }
    return null
  }
  pair = { code: '', at: 0, tries: 0 }
  return apiKey
}

/* The page a phone opens to pair: one field, one button, and it keeps the key in its own storage
 * rather than in the address bar. */
const PAIR_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Pair with WorkBuro</title>
<style>
  html,body{margin:0;height:100%;background:#121212;color:#f2f2f2;
    font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    display:flex;align-items:center;justify-content:center}
  main{width:100%;max-width:340px;padding:24px}
  h1{font-size:19px;margin:0 0 6px}
  p{margin:0 0 20px;color:#a6a6a6;font-size:14px}
  input{width:100%;box-sizing:border-box;padding:14px;font-size:24px;letter-spacing:.24em;text-align:center;
    background:#1c1c1c;color:#f2f2f2;border:1px solid #333;border-radius:10px;margin-bottom:12px}
  button{width:100%;padding:14px;font-size:16px;font-weight:600;color:#fff;background:#2f6feb;border:0;border-radius:10px}
  button:disabled{opacity:.5}
  .note{margin-top:16px;font-size:13px;color:#a6a6a6;min-height:20px}
</style></head>
<body><main>
  <h1>Pair this phone</h1>
  <p>Type the six digits shown in WorkBuro, under Settings, Server.</p>
  <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
  <button id="go">Pair</button>
  <div class="note" id="note"></div>
</main>
<script>
  var note = document.getElementById('note'), go = document.getElementById('go'), field = document.getElementById('code');
  field.focus();
  go.onclick = async function () {
    go.disabled = true; note.textContent = 'Checking...';
    try {
      var r = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: field.value.trim() }) });
      var j = await r.json();
      if (!r.ok || !j.key) throw new Error(j.error || 'That code was not accepted.');
      localStorage.setItem('wb-server-key', j.key);
      note.textContent = 'Paired. Opening WorkBuro...';
      location.replace('/');
    } catch (err) {
      note.textContent = err.message;
      go.disabled = false;
    }
  };
</script>
</body></html>`

/* ---------------------------------------------------------------- attachments and titles */

/*
 * A request body is read exactly once. The dispatcher reads it before it knows which route will want
 * it (so the key can be checked and the route table consulted), and the route then asks for the same
 * bytes -- a stream that has already been drained would otherwise hand back an empty attachment.
 */
const bodyCache = new WeakMap()

function readBody(req, limit = 40 * 1024 * 1024) {
  const cached = bodyCache.get(req)
  if (cached) return Promise.resolve(cached)
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('that file is too large to attach'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const buf = Buffer.concat(chunks)
      bodyCache.set(req, buf)
      resolve(buf)
    })
    req.on('error', reject)
  })
}

const bodyText = (req) => (bodyCache.get(req) || Buffer.alloc(0)).toString()

/* A file picked on the phone is written here, so the app's own reader can open it by path. */
async function upload(req, res, url) {
  const name = path.basename(url.searchParams.get('name') || 'attachment')
  const buf = await readBody(req)
  fs.mkdirSync(where.uploads, { recursive: true })
  const file = path.join(where.uploads, `${Date.now()}-${name}`)
  fs.writeFileSync(file, buf)
  const kind = filesLib.kindFor ? filesLib.kindFor(file) : 'document'
  const ex = await filesLib.extract(file).catch((e) => ({ ok: false, error: e.message, kind }))
  json(res, 200, {
    ok: Boolean(ex.ok),
    path: file,
    name,
    bytes: buf.length,
    docKind: ex.kind || kind,
    chars: (ex.text || '').length,
    preview: (ex.text || '').slice(0, 400),
    error: ex.error,
  })
}

/* The app names a conversation from its own rules, then a short non-streaming call. */
async function title(req, res) {
  const cfg = config()
  const { base } = upstream()
  const text = String((req.messages || []).find((m) => m.role === 'user')?.content || '')
  if (!text.trim()) return json(res, 200, { ok: false })
  const framing = (titlesLib.transcript && titlesLib.transcript(req.messages)) || `Name this conversation in at most five words, no quotes:\n\n${text.slice(0, 400)}`
  try {
    const up = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: headersFor(cfg, 'application/json'),
      body: JSON.stringify({
        model: cfg.titleModel || cfg.model,
        messages: [{ role: 'user', content: framing }],
        stream: false,
        max_tokens: 24,
        temperature: 0.2,
      }),
    })
    if (!up.ok) return json(res, 200, { ok: false, error: `provider ${up.status}` })
    const out = await up.json()
    let t = String(out.choices?.[0]?.message?.content || '').trim().replace(/^["'#\s]+|["'.\s]+$/g, '')
    t = t.split('\n')[0].slice(0, 48)
    json(res, 200, t ? { ok: true, title: t } : { ok: false })
  } catch (err) {
    json(res, 200, { ok: false, error: err.message })
  }
}

/* ---------------------------------------------------------------- the agent, on this PC */

/* Pi's model list: the one the chat offers, plus whichever model this turn actually asked for. */
function modelsForPi(cfg, alsoModel) {
  const ids = [...new Set([cfg.model, alsoModel].filter(Boolean))]
  const list = ids.map((id) => {
    const prefs = (cfg.modelPrefs || {})[id] || {}
    return { id, name: id, input: prefs.vision === 'yes' ? ['text', 'image'] : ['text'] }
  })
  return piLib.modelsFor(list)
}

function agentStatus() {
  const cfg = config()
  const st = piLib.status(where.pi)
  const workspace = (cfg.agent || {}).workspace || ''
  return {
    installed: st.installed,
    version: st.version,
    pinned: piLib.PI_VERSION,
    exe: st.exe,
    agentDir: st.agentDir,
    workspace,
    workspaceExists: Boolean(workspace && fs.existsSync(workspace)),
    // the app's own agent switch, and this server's own permission
    appEnabled: Boolean((cfg.agent || {}).enabled),
    allowed: agentAllowed,
    configured: st.configured,
  }
}

/* Pi's events in the shape the renderer already understands (main.cjs's agentEventFor). */
function mapAgentEvent(ev) {
  switch (ev.kind) {
    case 'text':
      return { type: 'text', value: ev.delta }
    case 'thinking':
      return { type: 'reasoning', value: ev.delta }
    case 'usage': {
      // Pi reports usage as input/output/totalTokens; the window prints prompt/completion/total.
      // Passing it straight through is why the agent's usage line read "undefined in / undefined out".
      const u = ev.usage || {}
      return {
        type: 'usage',
        value: {
          prompt: u.prompt ?? u.input ?? 0,
          completion: u.completion ?? u.output ?? 0,
          total: u.total ?? u.totalTokens ?? 0,
          reasoning: u.reasoning ?? u.completion_tokens_details?.reasoning_tokens ?? 0,
        },
      }
    }
    case 'tool_start':
      return {
        type: 'tool',
        value: { id: ev.tool.id, name: ev.tool.name, label: ev.tool.label, phase: 'start', args: ev.tool.args, query: ev.tool.summary },
      }
    case 'tool_end':
      return {
        type: 'tool',
        value: {
          id: ev.id,
          name: ev.name,
          phase: 'end',
          ok: ev.ok,
          preview: [ev.text, ...(ev.notPosted || [])].filter(Boolean).join(' · '),
          error: ev.ok ? null : ev.text || 'the command failed',
        },
      }
    case 'notice':
      return { type: 'notice', value: ev.text || ev.message || '' }
    case 'error':
      return { type: 'error', value: ev.message || 'the agent failed' }
    default:
      return null
  }
}

/* A picture arriving from a phone is a data URL with no file behind it, exactly like a pasted one:
   it has to be written out before Pi can be handed it as @path. */
function writeAgentImages(req, workspace) {
  const out = []
  const dir = path.join(workspace, 'attachments')
  for (const im of req.images || []) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(String(im.url || im.dataUrl || ''))
    if (!m) {
      if (im.path && fs.existsSync(im.path)) out.push({ path: im.path, name: im.name || path.basename(im.path) })
      continue
    }
    try {
      fs.mkdirSync(dir, { recursive: true })
      const safe = String(im.name || 'picture.png').replace(/[^\w.\-]+/g, '_')
      const file = path.join(dir, `${Date.now()}-${safe}`)
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'))
      out.push({ path: file, name: im.name || path.basename(file) })
    } catch (err) {
      console.warn('could not write an attached picture:', err.message)
    }
  }
  return out
}

async function agentTurn(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
  const send = (type, value) => res.write(`data: ${JSON.stringify({ type, value })}\n\n`)
  const fail = (message) => {
    send('event', { type: 'error', value: message })
    send('done', { ok: false })
    res.end()
  }

  const cfg = config()
  const agent = cfg.agent || {}
  const requestId = req.requestId || crypto.randomBytes(4).toString('hex')

  if (!agentAllowed) return fail('Agent mode is switched off for this preview. Restart the server with WB_PREVIEW_AGENT=1 to allow it.')
  const st = piLib.status(where.pi)
  if (!st.installed) return fail('Agent mode needs Pi installed. Add it in Settings, Agent, in the app.')
  const workspace = agent.workspace
  if (!workspace) return fail('Agent mode needs a workspace folder, set in the app.')
  if (!fs.existsSync(workspace)) return fail(`The agent workspace no longer exists: ${workspace}`)

  const conversationId = req.conversationId || 'preview'
  const agentDir = piLib.sessionAgentDirFor(where.pi, conversationId)
  // the agent runs on the endpoint the picked model belongs to, exactly as a chat turn does
  const target = endpointFor(req.baseUrl)
  try {
    piLib.writeConfig({ agentDir, baseUrl: target.base, models: modelsForPi(cfg, req.model || cfg.model) })
  } catch (err) {
    return fail(`could not write the agent's provider config: ${err.message}`)
  }
  const sessionDir = piLib.sessionDirFor(where.pi, conversationId)

  // what the agent has not been told: anything said before agent mode was switched on
  const context = pathsLib.agentContextNote(req.messages || [], {
    sinceId: '',
    sinceText: '',
    currentPrompt: req.prompt,
  })
  const images = writeAgentImages(req, workspace)
  // a document picked on a phone lives in this server's upload folder, which is outside the agent's
  // workspace, so it is copied in: the agent is then certain to be able to open it
  const documents = []
  try {
    const dir = path.join(workspace, 'attachments')
    for (const d of req.documents || []) {
      if (!d || !d.path || !fs.existsSync(d.path)) continue
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, path.basename(d.path))
      if (path.resolve(file) !== path.resolve(d.path)) fs.copyFileSync(d.path, file)
      documents.push({ path: file, name: d.name || path.basename(file) })
    }
  } catch (err) {
    console.warn('could not copy a document into the workspace:', err.message)
  }
  const attachmentNote = images.length || documents.length
    ? `Attached files are on disk and can be opened: ${[...documents, ...images]
        .map((f) => `${f.name} at ${f.path}`)
        .join(', ')}.`
    : ''
  const prompt = [context, attachmentNote, req.prompt].filter(Boolean).join('\n\n---\n\n')

  const localEndpoint = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(String(target.base || ''))
  const relayKey = String(target.key || '').trim() || (localEndpoint ? 'local-server-no-key-needed' : '')

  let handle
  try {
    handle = piLib.runTurn({
      piRoot: where.pi,
      workspace,
      sessionDir,
      agentDir,
      model: req.model || cfg.model,
      relayKey,
      prompt,
      images: images.map((f) => f.path),
      extension: piLib.ensureImageExtension(where.agentExt),
      falKey: (cfg.imageGen || {}).falKey || '',
      imagesDir: where.images,
      imageModel: (cfg.imageGen || {}).model || '',
      imageEditModel: (cfg.imageGen || {}).editModel || '',
      timeoutMs: 15 * 60 * 1000,
      onEvent: (ev) => {
        const mapped = mapAgentEvent(ev)
        if (mapped) send('event', mapped)
      },
    })
  } catch (err) {
    return fail(`the agent could not start: ${err.message}`)
  }

  activeTurns.set(requestId, handle)
  res.on('close', () => {
    const h = activeTurns.get(requestId)
    if (h) {
      try {
        h.kill()
      } catch {}
      activeTurns.delete(requestId)
    }
  })

  try {
    const result = await handle.promise
    send('done', { ok: true, result: typeof result === 'string' ? result.slice(0, 400) : undefined })
  } catch (err) {
    send('event', { type: 'error', value: err.message })
    send('done', { ok: false })
  } finally {
    activeTurns.delete(requestId)
  }
  res.end()
}

/* ---------------------------------------------------------------- plumbing */

function json(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(body)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
}

/* ---------------------------------------------------------------- the page the phone gets */

/*
 * The packaged renderer's filenames carry a content hash that changes on every build, and the phone
 * needs more than the desktop's index.html: a head that locks the viewport and respects the safe
 * areas, and the bridge that gives the page a window.zen over HTTP. Rather than hardcode an asset
 * name that the next build invalidates, the app's own index.html is read and the additions are
 * injected into it. Whatever the app ships, the phone gets.
 */
const PHONE_HEAD = `
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
<meta name="color-scheme" content="dark">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="WorkBuro">
<style>
/*
 * A phone is not a desktop window. Four things have to be said here, none of which change the app:
 * the page must not be zoomable (a zoomed page can be dragged in x and y, which is exactly what a
 * finger does), the frame must be guaranteed a height to be full OF, the safe areas must be kept out
 * of the app's way while being painted the app's own colour, and iOS must not inflate the text.
 */
html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
  overscroll-behavior: none; touch-action: pan-y; background: #121212; color-scheme: dark;
  -webkit-text-size-adjust: 100%; -webkit-tap-highlight-color: transparent; }
#root { box-sizing: border-box; width: 100%; height: 100%; overflow: hidden; }
@media (display-mode: standalone) {
  #root { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px);
          padding-left: env(safe-area-inset-left, 0px); padding-right: env(safe-area-inset-right, 0px); }
}
</style>
<script src="/bridge.js"></script>
`

function phonePage(res) {
  const file = path.join(where.renderer, 'index.html')
  let html
  try {
    html = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return json(res, 500, { ok: false, error: `the app's renderer was not found at ${file}: ${err.message}` })
  }
  /*
   * The app's own viewport tag is removed rather than left beside ours: two viewport tags with
   * different zoom rules is a coin toss, and the phone's rules have to win. The head is then placed
   * before the first script, so the bridge is defined before the app's bundle asks for it.
   */
  html = html.replace(/<meta\s+name=["']viewport["'][^>]*>\s*/gi, '')
  const at = html.search(/<script/i)
  html = at === -1
    ? (html.includes('</head>') ? html.replace('</head>', `${PHONE_HEAD}</head>`) : PHONE_HEAD + html)
    : html.slice(0, at) + PHONE_HEAD + html.slice(at)
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(html)
}

function phoneManifest(res) {
  res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify({
    name: 'WorkBuro',
    short_name: 'WorkBuro',
    start_url: '/',
    display: 'standalone',
    background_color: '#121212',
    theme_color: '#121212',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  }, null, 2))
}

function staticFile(req, res, url) {
  let rel = decodeURIComponent(url.pathname)
  if (rel === '/' || rel === '') return phonePage(res)
  if (rel === '/pair' || rel === '/pair/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end(PAIR_PAGE)
  }
  if (rel === '/manifest.webmanifest') return phoneManifest(res)

  /* the bridge and the icons ship beside this file; everything else comes out of the app's build */
  const fromWebclient = path.join(__dirname, 'webclient', path.basename(rel))
  const bases = [where.renderer, path.dirname(fromWebclient)]
  const wanted = rel.startsWith('/bridge.js') || /^\/(icon|apple-touch-icon)/.test(rel)
    ? fromWebclient
    : path.join(where.renderer, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''))
  const file = bases.some((b) => wanted.startsWith(b)) ? wanted : path.join(where.renderer, 'index.html')

  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { ok: false, error: 'not found' })
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    res.end(data)
  })
}

/* ---------------------------------------------------------------- requests */

const ROUTES = {
  '/api/config': { GET: (_req, res) => json(res, 200, publicConfig()) },
  '/api/health': { GET: (_req, res) => json(res, 200, status()) },
  '/api/pair': {
    POST: (req, res) => {
      /* bodyText hands back the raw body -- the parsing belongs here, next to the field being read */
      let code = ''
      try { code = (JSON.parse(bodyText(req) || '{}') || {}).code } catch { code = '' }
      const key = redeemPairCode(code)
      if (!key) {
        logRequest(req, 401, Date.now(), 'bad pairing code')
        return json(res, 401, { ok: false, error: 'That code was not accepted. Check the six digits in the app.' })
      }
      json(res, 200, { ok: true, key })
    }
  },
  '/api/log': { GET: (_req, res) => json(res, 200, { entries: requestLog.slice(-120), refusals: failedAttempts }) },
  '/api/store': {
    GET: (_req, res) => json(res, 200, storeOut()),
    POST: (_req, res) => json(res, 200, storeIn(bodyText(_req))),
  },
  '/api/models': { GET: (_req, res) => models(res) },
  '/api/image-models': { GET: (_req, res) => imageModels(res) },
  '/api/pi/status': { GET: (_req, res) => json(res, 200, agentStatus()) },
  '/api/pi/sessions': {
    GET: (_req, res) => json(res, 200, [...activeTurns.keys()].map((requestId) => ({ requestId, startedAt: Date.now() }))),
  },
  '/api/pi/stop': {
    POST: async (req, res) => {
      const { requestId } = JSON.parse((await readBody(req)).toString() || '{}')
      const h = activeTurns.get(requestId)
      if (!h) return json(res, 200, { stopped: false })
      try { h.kill() } catch {}
      activeTurns.delete(requestId)
      json(res, 200, { stopped: true })
    },
  },
  '/api/pi/turn': { POST: (req, res) => agentTurn(JSON.parse(bodyText(req) || '{}'), res) },
  '/api/chat': { POST: (req, res) => chat(JSON.parse(bodyText(req) || '{}'), res) },
  '/api/image': { POST: (req, res) => image(JSON.parse(bodyText(req) || '{}'), res) },
  '/api/title': { POST: (req, res) => title(JSON.parse(bodyText(req) || '{}'), res) },
  '/api/upload': { POST: (req, res, url) => upload(req, res, url) },
}

async function handle(req, res) {
  const started = Date.now()
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname

  if (!p.startsWith('/api/')) {
    staticFile(req, res, url)
    logRequest(req, 200, Date.now() - started, 'static')
    return
  }

  let body = ''
  if (req.method === 'POST') {
    try { body = (await readBody(req)).toString() } catch { body = '' }
  }

  /*
   * Everything under /api is the user's own machine and their own keys, so it is all behind the key.
   * Two exceptions, both deliberate: health, which the settings pane uses to check its own server
   * from the outside, and pair, whose whole job is to hand the key to a device that does not have
   * one yet -- the single-use code in the request body is the credential there.
   */
  if (p !== '/api/health' && p !== '/api/pair' && !authorised(req, url)) {
    logRequest(req, 401, Date.now() - started, 'wrong or missing key')
    return json(res, 401, { ok: false, error: 'This server needs the API key. Add it in the app under Settings, Server.' })
  }

  const route = ROUTES[p]
  if (!route) {
    logRequest(req, 404, Date.now() - started, 'no such route')
    return json(res, 404, { ok: false, error: 'no such route' })
  }
  const fn = route[req.method] || route.GET
  if (!fn) {
    logRequest(req, 405, Date.now() - started, 'wrong method')
    return json(res, 405, { ok: false, error: `${req.method} is not allowed here` })
  }

  try {
    await fn(req, res, url)
    logRequest(req, res.statusCode || 200, Date.now() - started, 'ok')
  } catch (err) {
    logRequest(req, 500, Date.now() - started, err.message)
    if (!res.headersSent) json(res, 500, { ok: false, error: err.message })
  }
}

/* ---------------------------------------------------------------- lifecycle */

function lanAddresses() {
  const out = []
  try {
    for (const list of Object.values(require('node:os').networkInterfaces() || {})) {
      for (const i of list || []) {
        if (i.family === 'IPv4' && !i.internal) out.push(i.address)
      }
    }
  } catch {}
  return out
}

function status() {
  /* every address that has reached this server with the key, most recent first */
  const seen = new Map()
  for (const e of requestLog) {
    if (e.status === 200 && e.ip) seen.set(e.ip, Math.max(seen.get(e.ip) || 0, e.at))
  }
  return {
    running: Boolean(listening),
    port: listening ? listening.address().port : null,
    addresses,
    lan: lanAddresses(),
    devices: [...seen.entries()].map(([ip, at]) => ({ ip, at })).sort((a, b) => b.at - a.at).slice(0, 20),
    refusals: failedAttempts,
    lastRefusal: lastRefusal || null,
    agentAllowed,
    keySet: Boolean(apiKey),
    keyLength: apiKey.length,
    // The last few requests, for the settings pane. Never the key: only who asked for what, and what
    // they got.
    requests: requestLog.slice(-25),
  }
}

/*
 * start() is what main.cjs calls when the setting is switched on. Everything platform-specific is
 * handed in: the renderer to serve, the store to read, where images, Pi and uploads live, the key
 * to demand, and how to bind.
 */
async function start(opts = {}) {
  if (listening) return status()

  where.renderer = opts.rendererDir
  where.store = opts.store
  where.images = opts.imagesDir
  where.pi = opts.piRoot
  where.agentExt = opts.agentExt
  where.uploads = opts.uploadsDir || path.join(path.dirname(opts.store), 'server-uploads')
  where.onStoreChanged = opts.onStoreChanged

  apiKey = String(opts.key || '').trim()
  if (!apiKey) throw new Error('server mode needs an API key')
  if (!where.renderer) throw new Error('server mode needs the renderer to serve')
  if (!where.store) throw new Error('server mode needs the store to read')

  agentAllowed = opts.agent !== false
  addresses = []
  listening = http.createServer(handle)
  const port = Number(opts.port || 8123)
  const bind = String(opts.bind || '0.0.0.0')

  await new Promise((resolve, reject) => {
    listening.once('error', reject)
    listening.listen(port, bind, resolve)
  })

  const bound = listening.address().port
  /*
   * Only the addresses it is actually listening on. A LAN address printed for a server bound to
   * localhost is a link that cannot work but looks like it can, which is worse than no link.
   */
  const onLan = bind === '0.0.0.0' || bind === '::'
  addresses = [
    `http://127.0.0.1:${bound}/`,
    ...(onLan ? lanAddresses().map((ip) => `http://${ip}:${bound}/`) : []),
  ]
  return status()
}

async function stop() {
  if (!listening) return status()
  const s = listening
  listening = null
  await new Promise((resolve) => s.close(resolve))
  addresses = []
  return status()
}

function keygen() {
  return crypto.randomBytes(32).toString('base64url')
}

module.exports = { start, stop, status, keygen, issuePairCode, pairState, PHONE_ASSETS: 'webclient' }

