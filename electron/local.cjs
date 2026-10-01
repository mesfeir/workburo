'use strict'

/**
 * A local model, so someone with no key can still type and get an answer.
 *
 * The point of this module is the first thirty seconds of the app's life. WorkBuro is the quick
 * pull-up: if the first run needs an account, a sign-in and a multi-gigabyte download before the
 * input takes a keystroke, then the app has the same problem it was built to avoid. So the local
 * path is one click, one file, and an OpenAI-compatible endpoint on localhost that the chat already
 * knows how to talk to.
 *
 * Measured on the development machine (RTX 5090, CPU only, 24 threads):
 *
 *   Qwen3-0.6B Q4_0   429 MB   loaded and answering in 1138 ms   first token 163 ms
 *   gemma-3-270m Q8   292 MB   loaded and answering in 1219 ms   first token  59 ms
 *
 * Load is the whole wait: about a second from clicking to an answer, with no account anywhere.
 *
 * Three deliberate choices:
 *
 *   1. llama.cpp, not vLLM. One prebuilt binary, no Python, no CUDA toolkit, runs on CPU or GPU.
 *      vLLM is a serving engine for many concurrent users: it needs Python and CUDA and gigabytes
 *      of dependencies, it is Linux-first, and this machine has no cuBLAS — exactly the class of
 *      dependency that turns an installer into a support thread.
 *   2. Everything is pinned: version, asset, byte count, and the SHA-256 of both the archive and
 *      the model. llama.cpp publishes no checksums of its own, so the digest is captured here and
 *      checked on install; that is stronger than trusting the transport, and it means a
 *      substituted file is refused rather than run.
 *   3. Nothing is bundled. The installer stays around 105 MB and the model is fetched on first
 *      run, with its size shown before it starts, because the complaint about the alternative was
 *      the surprise as much as the wait.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

/** Pinned. Upgrading is a deliberate act with a new digest, not a silent surprise. */
const LLAMA_VERSION = 'b11284'
/** Each platform's archive is a different file with a different size and digest. The macos build is
 *  a .tar.gz and carries a set of .dylibs beside the binary; the Windows one is a .zip. */
const LLAMA_PINS = {
  win32: {
    bytes: 19197239,
    sha256: 'd1ae718af63497d74caf4a012e4550bbbdfab2d9faceefbd5f06b73dacbe903a'
  },
  darwin: {
    bytes: 11797542,
    sha256: 'f26782642b52467e1c1f7814349c478d5477d61887aeb237b7fe1ee1527554e5'
  }
}
/** This platform's pin, falling back to the Windows one so an unpinned platform fails on its digest
 *  rather than silently downloading something unverified. */
function llamaPin (platform = process.platform) {
  return LLAMA_PINS[platform] || LLAMA_PINS.win32
}
const LLAMA_BYTES = llamaPin().bytes
const LLAMA_SHA256 = llamaPin().sha256

function llamaAsset (platform = process.platform, arch = process.arch) {
  const a = arch === 'arm64' ? 'arm64' : 'x64'
  if (platform === 'win32') return `llama-${LLAMA_VERSION}-bin-win-cpu-${a}.zip`
  if (platform === 'darwin') return `llama-${LLAMA_VERSION}-bin-macos-${a}.tar.gz`
  return `llama-${LLAMA_VERSION}-bin-ubuntu-${a}.zip`
}

function llamaUrl (platform, arch) {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/${llamaAsset(platform, arch)}`
}

/**
 * What can be downloaded. One entry on purpose: a first run should not be a decision about models,
 * and every one of these has to be honest about what it is. A 0.6B model is not a good writer — it
 * is a first impression, and the note says so, because the risk is someone deciding the app is dumb
 * rather than the model being small.
 */
const CATALOGUE = [
  {
    id: 'qwen3-0.6b',
    label: 'Qwen3 0.6B',
    file: 'Qwen3-0.6B-Q4_0.gguf',
    bytes: 428970080,
    sha256: 'da2572f16c06133561ce56accaa822216f2391ef4d37fba427801cd6736417d4',
    url: 'https://huggingface.co/ggml-org/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_0.gguf',
    note: 'Small enough to start in a second. It reasons before it answers, so its thinking is switched off for chatting with /no_think. Good for quick questions, not for writing anything long.',
  },
]

const DEFAULT_MODEL = 'qwen3-0.6b'

/** Where the pieces live. The version directory is disposable; the model is not. */
function layout (root) {
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  return {
    root,
    versionDir: path.join(root, LLAMA_VERSION),
    exe: path.join(root, LLAMA_VERSION, exe),
    binDir: path.join(root, LLAMA_VERSION),
    modelsDir: path.join(root, 'models'),
    archive: path.join(root, `llama-${LLAMA_VERSION}.zip`),
  }
}

function modelPath (root, id = DEFAULT_MODEL) {
  const entry = CATALOGUE.find((m) => m.id === id) || CATALOGUE[0]
  return path.join(layout(root).modelsDir, entry.file)
}

function entryFor (id = DEFAULT_MODEL) {
  return CATALOGUE.find((m) => m.id === id) || CATALOGUE[0]
}

/**
 * A model id that is a path on disk is a leftover: llama.cpp used to report its model as the full
 * path, and the app saved that path as the selection, so the model control showed a filesystem path
 * and the server's own name never matched it in the list.
 *
 * Only a real Windows path is touched. `meta-llama/Llama-3-8B` has a slash and is an ordinary model
 * id; tidying that would break a working setup, which is a far worse outcome than a long label.
 */
function tidyModelId (id) {
  const s = String(id || '')
  const isWindowsPath = /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\')
  if (!isWindowsPath) return s
  const base = s.split(/[\\/]/).pop() || ''
  return base.replace(/\.gguf$/i, '') || s
}

/** "429 MB" rather than 428970080, because that is what a person is deciding about. */
function humanSize (bytes) {
  const mb = Number(bytes || 0) / 1e6
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`
  if (mb >= 100) return `${Math.round(mb)} MB`
  return `${mb.toFixed(1)} MB`
}

/**
 * Is the local model usable right now? Never claims ready unless the binary is on disk and the
 * model file is complete: a half-downloaded model that reports itself ready is worse than no model.
 */
function status (root, id = DEFAULT_MODEL) {
  const L = layout(root)
  const installed = fs.existsSync(L.exe)
  const mPath = modelPath(root, id)
  let modelReady = false
  let bytes = 0
  try {
    const st = fs.statSync(mPath)
    bytes = st.size
    modelReady = st.isFile() && st.size === entryFor(id).bytes
  } catch {}
  return {
    installed,
    version: installed ? LLAMA_VERSION : null,
    exe: installed ? L.exe : null,
    model: entryFor(id).id,
    modelPath: modelReady ? mPath : null,
    modelReady,
    modelBytes: bytes,
    ready: installed && modelReady,
  }
}

function sha256File (file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(1 << 20)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (!n) break
      hash.update(buf.subarray(0, n))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

/**
 * Download to a temporary name, check it, then move it into place. An interrupted download can
 * therefore never look like a finished one, and a file that does not match its digest is deleted
 * rather than kept.
 */
async function download ({ url, dest, bytes, sha256, onProgress, fetchImpl = fetch, signal }) {
  const part = `${dest}.partial`
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.rmSync(part, { force: true })

  const res = await fetchImpl(url, { signal, redirect: 'follow' })
  if (!res.ok) throw new Error(`the download was refused (${res.status}). ${url}`)
  const total = Number(res.headers.get('content-length') || bytes || 0)
  const out = fs.createWriteStream(part)
  let got = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      got += value.length
      if (onProgress) onProgress({ got, total })
      if (!out.write(Buffer.from(value))) {
        await new Promise((resolve) => out.once('drain', resolve))
      }
    }
  } catch (err) {
    out.destroy()
    fs.rmSync(part, { force: true })
    throw err
  }
  await new Promise((resolve, reject) => {
    out.end((err) => (err ? reject(err) : resolve()))
  })

  const size = fs.statSync(part).size
  if (bytes && size !== bytes) {
    fs.rmSync(part, { force: true })
    throw new Error(`the download is the wrong size: ${size} bytes, expected ${bytes}.`)
  }
  if (sha256) {
    const got256 = sha256File(part)
    if (got256 !== sha256) {
      fs.rmSync(part, { force: true })
      throw new Error(`the download does not match its checksum, so it was not kept.`)
    }
  }
  fs.rmSync(dest, { force: true })
  fs.renameSync(part, dest)
  return dest
}

/** Extract quietly with the tar Windows ships; PowerShell Expand-Archive is the fallback. */
function extractArchive (archive, dest) {
  fs.mkdirSync(dest, { recursive: true })
  const tar = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
  const r = require('node:child_process').spawnSync(tar, ['-xf', archive, '-C', dest], { windowsHide: true })
  if (r.status !== 0) {
    const why = String(r.stderr || r.error?.message || '').trim()
    throw new Error(`could not unpack the download: ${why || `tar exited ${r.status}`}`)
  }
}

/** Ask the binary what it is. Proves the unpack really produced something that runs. */
function binaryVersion (exe, timeoutMs = 60000, attempts = 2) {
  let last = null
  for (let i = 0; i < attempts; i += 1) {
    const r = require('node:child_process').spawnSync(exe, ['--version'], { windowsHide: true, timeout: timeoutMs })
    const text = `${r.stdout || ''}${r.stderr || ''}`.trim()
    if (r.status === 0 && text) {
      const m = text.match(/build\s+(\d+)/i)
      return { ok: true, text: text.split('\n')[0].trim(), build: m ? m[1] : null }
    }
    // Say why. "Would not run" on its own sends someone hunting for a day, and the cases are
    // different problems: the file is not there, the spawn itself failed (blocked, no permission),
    // or it ran and refused (usually a DLL missing beside it).
    last = r.error
      ? r.error.message
      : r.status === null
        ? 'it did not finish'
        : `exit ${r.status}${text ? `: ${text.split('\n')[0].slice(0, 140)}` : ''}`
    // The first run of a freshly unpacked binary can be slow while antivirus reads every one of the
    // fifty files beside it. A second attempt costs a second and a half and turns that cold start
    // into a working install, instead of throwing away a completed download over it.
    if (i < attempts - 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
  }
  return { ok: false, why: last }
}

/**
 * Fetch a model and the binary that serves it. Progress is reported per byte so a first run can
 * show a real bar with a real total instead of a spinner.
 */
async function install (opts = {}) {
  const root = opts.root
  if (!root) return { ok: false, error: 'no directory to install into' }
  const id = opts.model || DEFAULT_MODEL
  const entry = entryFor(id)
  const L = layout(root)
  const onProgress = opts.onProgress || (() => {})

  try {
    if (!fs.existsSync(L.exe)) {
      onProgress({ phase: 'runtime', total: LLAMA_BYTES, got: 0, note: `llama.cpp ${LLAMA_VERSION}` })
      await download({
        url: llamaUrl(),
        dest: L.archive,
        bytes: llamaPin().bytes,
        sha256: llamaPin().sha256,
        signal: opts.signal,
        fetchImpl: opts.fetchImpl,
        onProgress: (p) => onProgress({ phase: 'runtime', ...p }),
      })
      onProgress({ phase: 'unpacking' })
      // Extract into a staging directory and rename it into place, so an interrupted unpack cannot
      // leave a directory that looks installed.
      const staging = `${L.versionDir}.partial`
      fs.rmSync(staging, { recursive: true, force: true })
      extractArchive(L.archive, staging)
      const exe = path.join(staging, path.basename(L.exe))
      const version = binaryVersion(exe)
      if (!version.ok) {
        // Keep the staging directory and the archive. Removing them made the failure invisible and
        // threw away a finished 19 MB download, so a retry had to fetch the whole thing again.
        return { ok: false, error: `the unpacked runtime would not run (${version.why}). The download was kept, so retrying will not fetch it again.` }
      }
      fs.rmSync(L.versionDir, { recursive: true, force: true })
      fs.renameSync(staging, L.versionDir)
      fs.rmSync(L.archive, { force: true })
      onProgress({ phase: 'runtime-done', note: version.text })
    }

    const mPath = modelPath(root, id)
    if (!status(root, id).modelReady) {
      onProgress({ phase: 'model', total: entry.bytes, got: 0, note: entry.label })
      await download({
        url: entry.url,
        dest: mPath,
        bytes: entry.bytes,
        sha256: entry.sha256,
        signal: opts.signal,
        fetchImpl: opts.fetchImpl,
        onProgress: (p) => onProgress({ phase: 'model', ...p }),
      })
      onProgress({ phase: 'model-done', note: entry.label })
    }

    return { ok: true, status: status(root, id) }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

/** A port nothing is using, so two copies of the app never fight over one. */
function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function fetchWithTimeout (url, ms, init) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    return await fetch(url, { ...(init || {}), signal: ac.signal })
  } finally {
    clearTimeout(t)
  }
}

/** Wait for the server to say it is up, rather than sleeping and hoping. */
async function waitHealthy (port, timeoutMs = 60000, onTick) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const r = await fetchWithTimeout(`http://127.0.0.1:${port}/health`, 2000)
      if (r.ok) return true
    } catch {}
    if (Date.now() > deadline) return false
    if (onTick) onTick()
    await new Promise((r) => setTimeout(r, 120))
  }
}

/**
 * Start the server on a free port. Returns a handle, because the app has to be able to stop it:
 * one child process, owned by the call that started it.
 */
async function serve (opts = {}) {
  const root = opts.root
  const id = opts.model || DEFAULT_MODEL
  const st = status(root, id)
  if (!st.ready) return { ok: false, error: 'the local model is not installed yet.' }
  const port = opts.port || (await freePort())
  // Name it ourselves. Left alone, llama.cpp reports the model as its full path on disk, so the
  // app's model control read "C:\Users\...\local\models\Qwen3-0.6B-Q4_0.gguf" with a seven-tab
  // truncation of the same. An alias makes the server call it by a name worth showing.
  const alias = path.basename(st.modelPath).replace(/\.gguf$/i, '')
  const args = [
    '-m', st.modelPath,
    '--alias', alias,
    '--port', String(port),
    '-c', String(opts.context || 4096),
    '-t', String(opts.threads || Math.max(4, os.cpus().length - 2)),
  ]
  const child = spawn(st.exe, args, {
    cwd: path.dirname(st.exe),
    windowsHide: true,
    // never a piped stdin: a server waiting on input that never comes looks like a hang
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })

  const started = Date.now()
  const up = await waitHealthy(port, opts.timeoutMs || 60000)
  if (!up) {
    try { child.kill() } catch {}
    return { ok: false, error: `the local model did not start. Last output: ${log.slice(-300)}` }
  }
  return {
    ok: true,
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    tookMs: Date.now() - started,
    child,
    stop () {
      try { child.kill() } catch {}
    },
  }
}

/**
 * Something already running on this machine that speaks OpenAI on localhost. The local-LLM
 * audience has LM Studio or Ollama open already, and using what is there costs nothing to offer.
 */
const KNOWN_LOCAL = [
  { id: 'lmstudio', label: 'LM Studio', url: 'http://127.0.0.1:1234/v1/models' },
  { id: 'ollama', label: 'Ollama', url: 'http://127.0.0.1:11434/v1/models' },
]

async function detect (opts = {}) {
  const found = []
  for (const k of KNOWN_LOCAL) {
    try {
      const r = await fetchWithTimeout(k.url, opts.timeoutMs || 1500)
      if (!r.ok) continue
      const j = await r.json().catch(() => null)
      const models = Array.isArray(j?.data) ? j.data.map((m) => m && m.id).filter(Boolean) : []
      found.push({ id: k.id, label: k.label, baseUrl: k.url.replace(/\/models$/, ''), models })
    } catch {}
  }
  return { found, tried: KNOWN_LOCAL.map((k) => k.url) }
}

module.exports = {
  LLAMA_VERSION,
  LLAMA_BYTES,
  LLAMA_SHA256,
  LLAMA_PINS,
  llamaPin,
  CATALOGUE,
  DEFAULT_MODEL,
  KNOWN_LOCAL,
  llamaAsset,
  llamaUrl,
  layout,
  modelPath,
  entryFor,
  humanSize,
  tidyModelId,
  status,
  sha256File,
  download,
  extractArchive,
  binaryVersion,
  install,
  freePort,
  waitHealthy,
  serve,
  detect,
}
