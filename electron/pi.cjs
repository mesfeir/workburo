/**
 * Agent mode — Pi in the backend, hands on the machine.
 *
 * Agent mode hands a turn to Pi (https://pi.dev), the agent harness, instead of sending it
 * straight to the chat model. Pi runs the loop and calls real tools: shell, read, write, edit,
 * grep, find, ls. When agent mode is off, none of this runs.
 *
 * Three deliberate choices, all of them tested in scripts/test-agent.cjs:
 *
 *   1. Pi is installed from its own pinned GitHub release, as a standalone binary. There is no
 *      npm step and no Node dependency: Electron 35 ships Node 22.16.0 and Pi requires
 *      >= 22.19.0, so hosting Pi in-process is not possible. The release zip bundles its own
 *      runtime, and the download is verified against the SHA256SUMS published beside it.
 *   2. Pi is pointed at the same endpoint and the same model the chat already uses. The provider
 *      config is generated from this app's own settings at runtime, so "which model" never
 *      becomes a second thing to keep in sync.
 *   3. The API key is handed to Pi as an environment variable at spawn. It is never written into
 *      Pi's config directory.
 *
 * Pi's own documentation is explicit that it has no built-in permission system, so the workspace
 * is a real choice made by the user, shown while agent mode is on.
 */

'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

/*
 * A turn that hits the ceiling is stopped, and the user is told in words they can act on: how long it
 * ran, and that sending anything carries on from where it left off (the work lives in Pi's own
 * session, so nothing is lost -- which is the only reason being cut off is survivable at all).
 */
function humanDuration(ms) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} ${hours === 1 ? 'hour' : 'hours'}`
}

/* The one place the stop is worded, so the wording is what the timer actually shows and can be tested. */
function stopMessage(ms) {
  return `Agent turn stopped after ${humanDuration(ms)}. Send anything to carry on from where it left off.`
}

/** The Pi release this app installs. Pinned: upgrading is a deliberate act, not a surprise. */
const PI_VERSION = '0.87.1'
const RELEASE_BASE = 'https://github.com/earendil-works/pi/releases/download'
/** Pi talks to the same endpoint the chat does, under this provider name. */
const PROVIDER = 'zen'
/** Pi reads the key from this environment variable at run time — never from disk. */
const KEY_ENV = 'ZEN_RELAY_KEY'

/** Pi's tool names, in the words the chat uses for its own rows. */
const TOOL_LABELS = {
  bash: 'Shell command',
  powershell: 'PowerShell',
  shell: 'Shell command',
  read: 'Read file',
  write: 'Write file',
  edit: 'Edit file',
  multi_edit: 'Edit files',
  grep: 'Search inside files',
  find: 'Find files',
  ls: 'List files',
  todo_write: 'Plan',
  todo_read: 'Read plan',
  web_search: 'Web search',
  fetch_url: 'Fetch page',
  generate_image: 'Generate image',
  task: 'Sub-agent',
  notebook_edit: 'Edit notebook'
}

/** One-line summary of a tool call, for the row's headline. */
function summarize (name, args) {
  const a = args && typeof args === 'object' ? args : {}
  const pick = (...keys) => {
    for (const k of keys) {
      if (typeof a[k] === 'string' && a[k].trim()) return a[k].trim()
    }
    return ''
  }
  const text = pick('command', 'file_path', 'path', 'filePath', 'pattern', 'query', 'url', 'prompt', 'glob')
  const oneLine = text.replace(/\s+/g, ' ')
  if (!oneLine) return ''
  return oneLine.length > 120 ? oneLine.slice(0, 117) + '…' : oneLine
}

/** Pi returns structured tool results; a row wants the sentence inside. */
function resultText (result) {
  if (typeof result === 'string') return result
  const parts = result && Array.isArray(result.content) ? result.content : []
  const text = parts.filter(p => p && typeof p.text === 'string').map(p => p.text).join('\n').trim()
  if (text) return text
  try { return JSON.stringify(result) } catch { return '' }
}

/** Pictures worth posting into the chat, and documents worth posting. */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'])
const FILE_EXT = new Set(['xlsx', 'csv', 'tsv', 'docx', 'doc', 'pdf', 'md', 'txt', 'json', 'html', 'pptx', 'ods'])
/** Tools whose own arguments name the file they touch, so the path needs no guessing. */
const PATH_ARG_TOOLS = {
  write: ['path', 'file_path', 'filePath'],
  edit: ['path', 'file_path', 'filePath'],
  multi_edit: ['path', 'file_path', 'filePath'],
  notebook_edit: ['path', 'file_path', 'filePath']
}
const SHELL_TOOLS = new Set(['bash', 'shell', 'powershell', 'sh'])
/**
 * Tools whose arguments name no file but whose result does: generate_image writes a picture and
 * reports its path. Without this the picture was never looked for, so it existed on disk, the model
 * truthfully said it had saved it, and nothing was posted. Their result is trustworthy, because the
 * tool itself aimed at that path.
 */
const PRODUCING_TOOLS = new Set(['generate_image'])

/** Absolute paths mentioned in a command or its output. Quotes and trailing punctuation are not. */
function pathsInText (text) {
  const s = String(text || '')
  const out = []
  for (const m of s.matchAll(/[A-Za-z]:[\\/][^\s"'<>|,;]+/g)) out.push(m[0])
  for (const m of s.matchAll(/\/(?:[^\s"'<>|:,;]+\/)+[^\s"'<>|:,;]+/g)) out.push(m[0])
  return out
}

/** Is this path inside the folder the session was told to work in? */
function insideWorkspace (abs, workspace) {
  if (!workspace) return false
  const rel = path.relative(path.resolve(workspace), path.resolve(abs))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Files under the workspace touched since a moment in time. Bounded: this can sit on a big folder. */
function touchedSince (workspace, since, depth = 3, seen = { n: 0 }) {
  const found = []
  if (!workspace || depth < 1 || seen.n > 600) return found
  let entries = []
  try {
    entries = fs.readdirSync(workspace, { withFileTypes: true })
  } catch {
    return found
  }
  for (const ent of entries) {
    if (seen.n++ > 600) break
    if (ent.name.startsWith('.')) continue
    const abs = path.join(workspace, ent.name)
    if (ent.isDirectory()) {
      found.push(...touchedSince(abs, since, depth - 1, seen))
      continue
    }
    const ext = path.extname(ent.name).slice(1).toLowerCase()
    if (!IMAGE_EXT.has(ext) && !FILE_EXT.has(ext)) continue
    try {
      const st = fs.statSync(abs)
      if (st.mtimeMs >= since) found.push(abs)
    } catch {}
  }
  return found
}

/**
 * What a tool call left on disk, in the shape the chat already renders.
 *
 * The bug this exists for: agent mode could write a document or draw a picture and the chat showed
 * only the tool's text. The file was really there, the model truthfully said it had saved it, and
 * nothing ever appeared on the reply — a silent drop, the third time a return shape has gone
 * missing here. So the rule is: if a tool produced a file, the file travels with the tool's own
 * result, in the same `files` / `images` shape the built-in tools use.
 *
 * The workspace is the boundary. A session is told which folder it may work in and the window says
 * so, so a file from outside it is not posted: an agent must not be able to surface any file on the
 * machine as an attachment. When something plausible cannot be posted, the reason is returned
 * rather than swallowed, because "nothing happened" is the failure being fixed.
 */
function outputsFromTool ({ name, args, result, workspace, imagesDir, since, isError } = {}) {
  const files = []
  const images = []
  const notPosted = []
  const a = args && typeof args === 'object' ? args : {}
  // A failed call produced nothing, and posting a path it merely mentioned on the way to failing
  // would put a card on the reply for a file that was never written.
  if (isError) return { files, images, notPosted }

  const named = []
  for (const key of PATH_ARG_TOOLS[name] || []) {
    if (typeof a[key] === 'string' && a[key].trim()) named.push(a[key].trim())
  }
  for (const f of Array.isArray(a.files) ? a.files : []) {
    if (f && typeof f.path === 'string' && f.path.trim()) named.push(f.path.trim())
  }

  // A shell command names no single output file, so its paths are read out of the command and its
  // output instead. Only shell tools guess: a read or a grep result also mentions paths, and
  // posting those would put a card on the reply for a file the agent merely looked at.
  const guessed = named.length || !(SHELL_TOOLS.has(name) || PRODUCING_TOOLS.has(name))
    ? []
    : [...pathsInText(a.command), ...pathsInText(resultText(result))]

  const add = (raw, trusted) => {
    const abs = path.resolve(workspace || '.', raw)
    const base = path.basename(abs)
    const ext = path.extname(abs).slice(1).toLowerCase()
    if (!IMAGE_EXT.has(ext) && !FILE_EXT.has(ext)) return
    let st
    try {
      st = fs.statSync(abs)
    } catch {
      if (trusted) notPosted.push(`${base} was not written`)
      return
    }
    if (!st.isFile()) return
    if (!insideWorkspace(abs, workspace) && !(imagesDir && insideWorkspace(abs, imagesDir))) {
      // Only worth saying when the tool itself aimed there: a command mentioning a path outside the
      // folder is usually something it read, not something it made. A picture this app generated is
      // the app's own file, so its folder counts as ours.
      if (trusted) notPosted.push(`${base} is outside the folders this chat may post from`)
      return
    }
    if (since && st.mtimeMs < since) {
      if (trusted) notPosted.push(`${base} was not changed by this call`)
      return
    }
    if (images.some((i) => i.path === abs) || files.some((f) => f.path === abs)) return
    const entry = { name: base, path: abs, bytes: st.size }
    if (IMAGE_EXT.has(ext)) images.push(entry)
    else files.push({ ...entry, kind: ext })
  }

  for (const raw of named) add(raw, true)
  // A tool that produces a file names it in its own result, so a refusal there is worth saying: the
  // model has just told the user it saved something, and nothing would appear.
  for (const raw of guessed) add(raw, PRODUCING_TOOLS.has(name))

  // Last resort, shell tools only: a command that writes a file without printing its name leaves
  // nothing to find in the text. So look at the folder itself for files that changed while that
  // one command ran.
  if (SHELL_TOOLS.has(name) && !files.length && !images.length && workspace) {
    for (const abs of touchedSince(workspace, since || 0, 3).slice(0, 8)) add(abs, false)
  }

  return { files, images, notPosted }
}

function assetFor (platform = process.platform, arch = process.arch) {
  const a = arch === 'arm64' ? 'arm64' : 'x64'
  if (platform === 'win32') return `pi-windows-${a}.zip`
  if (platform === 'darwin') return `pi-darwin-${a}.tar.gz`
  return `pi-linux-${a}.tar.gz`
}

/** Where everything lives. The version directory is disposable; the agent directory is not. */
function layout (piRoot) {
  const exe = process.platform === 'win32' ? 'pi.exe' : 'pi'
  return {
    root: piRoot,
    versionDir: path.join(piRoot, PI_VERSION),
    exe: path.join(piRoot, PI_VERSION, exe),
    agentDir: path.join(piRoot, 'agent'),
    configFile: path.join(piRoot, 'agent', 'models.json'),
    /** one directory per conversation, so a chat's agent memory is that chat's alone */
    sessionsDir: path.join(piRoot, 'agent', 'sessions'),
    download: path.join(piRoot, `download-${PI_VERSION}${assetFor().endsWith('.zip') ? '.zip' : '.tar.gz'}`)
  }
}

/** Is agent mode usable right now? Never claims installed unless the binary is really there. */
function status (piRoot) {
  const L = layout(piRoot)
  const installed = fs.existsSync(L.exe)
  return {
    installed,
    version: installed ? PI_VERSION : null,
    exe: installed ? L.exe : null,
    agentDir: L.agentDir,
    configured: installed && fs.existsSync(L.configFile)
  }
}

/**
 * A conversation gets its own session directory. A conversation id becomes a folder name, so
 * it is sanitised rather than trusted.
 */
function sessionDirFor (piRoot, conversationId) {
  const safe =
    String(conversationId || 'default')
      .replace(/[^a-zA-Z0-9._-]/g, '')
      .slice(0, 64) || 'default'
  return path.join(layout(piRoot).sessionsDir, safe)
}

/** One agent dir per session. Pi writes its provider config into this directory, so a single
 *  shared one meant two turns running at the same time could overwrite each other's model and key.
 *  The name comes from the session id, stripped of anything a filesystem would object to. */
function sessionAgentDirFor (piRoot, sessionId) {
  const safe =
    String(sessionId || '')
      .replace(/[^A-Za-z0-9._-]/g, '-')
      // A segment of exactly '..' would resolve to the parent directory, so a leading run of dots is
      // stripped rather than trusted. Everything else that is not a safe character became a dash,
      // which also removes every path separator.
      .replace(/^\.+/, '')
      .slice(0, 64) || 'default'
  return path.join(layout(piRoot).sessionsDir, 'agents', safe)
}

/** Has Pi written a session here yet? If it has, there is context to continue from. */
function hasSession (sessionDir) {
  try {
    return fs.readdirSync(sessionDir).some(f => f.endsWith('.jsonl'))
  } catch {
    return false
  }
}

function shaFor (sumsText, asset) {
  for (const line of String(sumsText).split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i)
    if (m && m[2].trim() === asset) return m[1].toLowerCase()
  }
  return null
}

function sha256File (file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const s = fs.createReadStream(file)
    s.on('data', d => h.update(d))
    s.on('end', () => resolve(h.digest('hex')))
    s.on('error', reject)
  })
}

/** Combine the caller's signal with a deadline, so a request cannot outlive it. */
function deadline (ms, outer) {
  const t = AbortSignal.timeout(ms)
  return outer ? AbortSignal.any([outer, t]) : t
}

/** Silence is the failure worth naming. A firewall that drops packets leaves a fetch pending for
 *  good, which is why the install button sat at "Installing…" and nothing ever happened. */
const STALL_MS = 30000
const CAP_MS = 15 * 60 * 1000

/**
 * Download with byte progress, so a 42 MB install is not a frozen button, and bounded at both ends:
 * a stall timer that resets on every chunk, and a cap on the whole thing. Neither existed, so an
 * unreachable GitHub left the promise pending forever and the UI with no error to show.
 */
async function download (url, dest, onProgress, signal) {
  const ctl = new AbortController()
  const relay = () => ctl.abort(signal && signal.reason)
  if (signal) {
    if (signal.aborted) ctl.abort(signal.reason)
    else signal.addEventListener('abort', relay, { once: true })
  }
  let quiet = setTimeout(() => ctl.abort(new Error(`nothing arrived for ${STALL_MS / 1000} seconds, so the connection was blocked or dropped`)), STALL_MS)
  const cap = setTimeout(() => ctl.abort(new Error('the download took longer than fifteen minutes')), CAP_MS)
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctl.signal })
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length')) || 0
    let received = 0
    const out = fs.createWriteStream(dest)
    try {
      for await (const chunk of res.body) {
        out.write(chunk)
        received += chunk.length
        clearTimeout(quiet)
        quiet = setTimeout(() => ctl.abort(new Error('the download stalled')), STALL_MS)
        if (onProgress) onProgress({ phase: 'download', received, total, pct: total ? Math.round((received / total) * 100) : null })
      }
    } finally {
      await new Promise(r => out.end(r))
    }
    return received
  } finally {
    clearTimeout(quiet)
    clearTimeout(cap)
    if (signal) signal.removeEventListener('abort', relay)
  }
}

function run (cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...opts })
    let err = ''
    child.stderr?.on('data', d => { err += d })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited ${code}${err ? ': ' + err.trim().split('\n').pop() : ''}`)))
  })
}

/** Windows 10 1803+ ships tar.exe, which handles zip and never shows a window. */
async function extract (file, dest) {
  const isZip = file.endsWith('.zip')
  if (process.platform !== 'win32') {
    await run('tar', ['-xf', file, '-C', dest])
    return
  }
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  if (isZip && fs.existsSync(tar)) {
    await run(tar, ['-xf', file, '-C', dest])
    return
  }
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${file.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`])
}

/**
 * Make a downloaded program runnable.
 *
 * The Windows archive is a .zip, which carries no permission bits at all, and a .tar.gz only
 * restores the modes it was built with. Spawning a file that is missing its execute bit fails with
 * EACCES, which is exactly what a Mac reported: "could not start Pi: spawn .../pi EACCES". Nothing
 * on Windows can catch this, because there is no such bit there.
 */
function makeExecutable (file) {
  if (process.platform === 'win32') return
  try {
    fs.chmodSync(file, 0o755)
  } catch {
    /* the spawn that follows names the path and the reason */
  }
}

/**
 * Rename, giving Windows a few tries first.
 *
 * A rename fails with EPERM or EBUSY while anything still holds the file open, and on Windows a
 * virus scanner or the search indexer routinely holds a freshly unpacked file for a moment. This was
 * seen for real: unpacking a nested archive failed with EPERM while the disk was busy, and it would
 * have failed on a person's machine in exactly the same way. Trying again briefly is the difference
 * between an installer that works every time and one that works most times.
 */
function renameWithRetry (from, to, attempts = 10, waitMs = 150) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      const transient =
        err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')
      if (!transient || i >= attempts - 1) throw err
      sleepSync(waitMs)
    }
  }
}

/** The same courtesy for removing the folder once it has been emptied. */
function rmdirWithRetry (dir, attempts = 10, waitMs = 150) {
  for (let i = 0; ; i++) {
    try {
      fs.rmdirSync(dir)
      return
    } catch (err) {
      const transient =
        err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'ENOTEMPTY')
      if (!transient || i >= attempts - 1) throw err
      sleepSync(waitMs)
    }
  }
}

/** A synchronous pause. Everything around an install is synchronous on purpose, so it stays so. */
function sleepSync (ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Move an archive's contents up when it packed them inside a folder.
 *
 * The same release is packed differently per platform. The Windows Pi .zip has `pi.exe` at its
 * root; the macOS .tar.gz puts everything under a top-level `pi/` folder. Unpacking either into the
 * version directory therefore does not leave the program where layout() says it is: on a Mac it
 * landed at <version>/pi/pi, and the app spawns <version>/pi, which is a directory, so starting Pi
 * failed with "spawn ... EACCES". llama.cpp's macOS build nests under `llama-b11284/` the same way.
 * The layout is normalised here rather than assumed.
 *
 * Returns true when something was moved, so a caller can tell which layout it got.
 */
function hoistContents (dir, program) {
  try {
    if (fs.statSync(path.join(dir, program)).isFile()) return false
  } catch {
    /* not at the top level: that is the case this exists for */
  }
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      if (!fs.statSync(path.join(dir, entry.name, program)).isFile()) continue
    } catch {
      continue
    }
    // Move the folder aside first, because the program is often named the same as the folder
    // holding it and a file cannot be moved onto a directory that still exists.
    const aside = path.join(dir, `.${entry.name}.unpacked`)
    renameWithRetry(path.join(dir, entry.name), aside)
    for (const inner of fs.readdirSync(aside)) {
      renameWithRetry(path.join(aside, inner), path.join(dir, inner))
    }
    rmdirWithRetry(aside)
    return true
  }
  return false
}

/**
 * Install Pi. Verified download, extract to a staging directory, and only then swap it into
 * place — an interrupted install never leaves something that looks installed.
 */
async function install (piRoot, opts = {}) {
  const L = layout(piRoot)
  const asset = assetFor()
  const base = `${RELEASE_BASE}/v${PI_VERSION}`
  const onProgress = opts.onProgress || (() => {})
  fs.mkdirSync(piRoot, { recursive: true })

  onProgress({ phase: 'checksums' })
  const sumsRes = await fetch(`${base}/SHA256SUMS`, { redirect: 'follow', signal: deadline(30000, opts.signal) })
  if (!sumsRes.ok) throw new Error(`could not read checksums: HTTP ${sumsRes.status}`)
  const want = shaFor(await sumsRes.text(), asset)
  if (!want) throw new Error(`no published checksum for ${asset}`)

  await download(`${base}/${asset}`, L.download, onProgress, opts.signal)

  onProgress({ phase: 'verify' })
  const got = await sha256File(L.download)
  if (got !== want) {
    fs.rmSync(L.download, { force: true })
    throw new Error('checksum mismatch — the download was discarded')
  }

  onProgress({ phase: 'extract' })
  const staging = `${L.versionDir}.partial`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  try {
    await extract(L.download, staging)
    // the macOS archive nests everything under `pi/`, the Windows one does not
    hoistContents(staging, path.basename(L.exe))
    const staged = path.join(staging, path.basename(L.exe))
    if (!fs.existsSync(staged)) {
      throw new Error('the release did not contain the expected program')
    }
    // before it is moved into place: a program with no execute bit cannot be started at all
    makeExecutable(staged)
    fs.rmSync(L.versionDir, { recursive: true, force: true })
    fs.renameSync(staging, L.versionDir)
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw err
  }
  fs.rmSync(L.download, { force: true })
  onProgress({ phase: 'done' })
  return status(piRoot)
}

/**
 * Write Pi's provider config from this app's own settings: same base URL, same models, key by
 * environment reference so no credential touches the disk.
 */
function writeConfig ({ agentDir, baseUrl, models }) {
  fs.mkdirSync(agentDir, { recursive: true })
  // `input` is the whole reason an attached picture reached the model and was never sent. Pi sends a
  // picture only to a model it believes can read one, and reads an unstated capability as text-only.
  // `modelsFor` decided this already; writing `['text']` for everything threw that decision away, so
  // the picture was accepted, recorded in Pi's own session, and never sent — while the same model
  // read the same file through the chat path. The capability is decided in one place and carried.
  const entries = (models || [])
    .filter(m => m && m.id)
    .map(m => ({
      id: m.id,
      name: m.name || m.id,
      ...(m.reasoning ? { reasoning: true } : {}),
      input: Array.isArray(m.input) && m.input.length ? m.input : ['text', 'image']
    }))
  const config = {
    providers: {
      [PROVIDER]: {
        baseUrl,
        api: 'openai-completions',
        apiKey: '$' + KEY_ENV,
        models: entries
      }
    }
  }
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(config, null, 2) + '\n', 'utf8')
  return config
}

/**
 * The stream translator, as a pure unit so it can be tested without spawning anything.
 *
 * Pi writes JSONL, and its own documentation warns that Node's readline is not protocol
 * compliant: it splits on U+2028/U+2029, which are legal inside JSON strings. So framing is done
 * here by hand, on LF only.
 */
function createTranslator (onEvent, opts = {}) {
  const emit = onEvent || (() => {})
  const state = { text: '', thinking: '', tools: [], usage: null, sessionId: null, lines: 0, unparsed: 0 }
  // When each tool began, so what it produced can be told apart from what was already on disk.
  const startedAt = new Map()
  let buf = ''

  function handle (line) {
    if (!line.trim()) return
    let e
    try { e = JSON.parse(line) } catch { state.unparsed++; return }
    state.lines++

    switch (e.type) {
      case 'session':
        state.sessionId = e.id || null
        emit({ kind: 'session', id: state.sessionId })
        break
      case 'message_update': {
        const a = e.assistantMessageEvent || {}
        const kind = String(a.type || '')
        const payload = typeof a.delta === 'string' ? a.delta : (typeof a.text === 'string' ? a.text : '')
        if (payload && /text/i.test(kind)) {
          state.text += payload
          emit({ kind: 'text', delta: payload })
        } else if (payload && /think|reason/i.test(kind)) {
          state.thinking += payload
          emit({ kind: 'thinking', delta: payload })
        }
        if (e.usage) { state.usage = e.usage; emit({ kind: 'usage', usage: e.usage }) }
        break
      }
      case 'tool_execution_start': {
        const tool = { id: e.toolCallId, name: e.toolName, label: TOOL_LABELS[e.toolName] || e.toolName, summary: summarize(e.toolName, e.args), args: e.args, ok: null }
        startedAt.set(e.toolCallId, Date.now())
        state.tools.push(tool)
        emit({ kind: 'tool_start', tool })
        break
      }
      case 'tool_execution_end': {
        const tool = state.tools.find(t => t.id === e.toolCallId)
        if (tool) tool.ok = !e.isError
        // What the call produced, in the shape the chat renders. A failed call produced nothing
        // worth posting, and guessing at files after a failure is how a stray path gets a card.
        const outs = e.isError
          ? { files: [], images: [], notPosted: [] }
          : outputsFromTool({
              name: e.toolName,
              args: (tool && tool.args) || e.args,
              result: e.result,
              isError: e.isError,
              workspace: opts.workspace,
              imagesDir: opts.imagesDir,
              // a little slack: mtime and Date.now() come from the same clock but not the same instant
              since: (startedAt.get(e.toolCallId) || opts.startedAt || 0) - 2000
            })
        if (tool) {
          tool.files = outs.files
          tool.images = outs.images
        }
        emit({ kind: 'tool_end', id: e.toolCallId, name: e.toolName, ok: !e.isError, text: resultText(e.result), result: e.result, files: outs.files, images: outs.images, notPosted: outs.notPosted })
        break
      }
      case 'agent_end':
        emit({ kind: 'agent_end', willRetry: !!e.willRetry })
        break
      case 'agent_settled':
        emit({ kind: 'settled' })
        break
      default:
        break
    }
  }

  return {
    state,
    /** Push a chunk of stdout. Only LF ends a record. */
    push (chunk) {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        handle(line)
      }
    },
    /** Anything left when the process exits. */
    flush () {
      if (buf.trim()) handle(buf)
      buf = ''
    }
  }
}

/**
 * The image tool, written out where Pi can read it. It lives inside the app's archive, and that is
 * not a place a separate process can load from, so it is copied to a real folder first. Written on
 * every run so an updated app never leaves a stale extension behind.
 */
function ensureImageExtension (dir) {
  const source = path.join(__dirname, 'agent-ext', 'generate-image.ts')
  try {
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, 'generate-image.ts')
    fs.writeFileSync(target, fs.readFileSync(source))
    return target
  } catch {
    return ''
  }
}

/**
 * Pi's argument list for one turn. Pure, so the shape can be asserted without spawning anything.
 *
 * Attached files ride as `@path` before the message, which is how Pi takes a file into a turn. A
 * picture pasted into the composer exists only as a data URL, so the caller writes it to disk first
 * and passes that path: a data URL has no path for a tool to open.
 */
function turnArgs (opts) {
  const o = opts || {}
  const args = ['--mode', 'json']
  // A conversation keeps its own Pi session, so a follow-up turn remembers the previous one —
  // including what its tools did. With no session directory the turn is a one-off.
  if (o.sessionDir) {
    args.push('--session-dir', o.sessionDir)
    if (o.continueSession) args.push('--continue')
  } else {
    args.push('--no-session')
  }
  // The picture tool, loaded for this run only. It is registered alongside Pi's own tools, so the
  // agent can make a picture instead of saying it has no way to.
  if (o.extension) args.push('--extension', o.extension)
  args.push('--model', `${PROVIDER}/${o.model}`)
  for (const f of o.images || []) {
    const p = String(f || '').trim()
    if (p) args.push('@' + p)
  }
  args.push(o.prompt)
  return args
}

/**
 * One turn, one process. Resolves when Pi settles, with the text it produced.
 * Returns a handle so the Stop button can end it.
 */
function runTurn (opts) {
  const L = layout(opts.piRoot)
  if (opts.sessionDir) fs.mkdirSync(opts.sessionDir, { recursive: true })
  const args = turnArgs({
    ...opts,
    continueSession: opts.sessionDir ? hasSession(opts.sessionDir) : false,
  })

  const child = spawn(L.exe, args, {
    cwd: opts.workspace || opts.piRoot,
    windowsHide: true,
    // stdin is closed on purpose. Pi is TUI-first, and a piped stdin that never ends can leave
    // it waiting for input that will never arrive — a turn that hangs instead of finishing.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: opts.agentDir || L.agentDir,
      [KEY_ENV]: opts.relayKey || '',
      // The image tool reads these. The key rides the environment rather than the extension file,
      // which is written to disk in the clear.
      WORKBURO_FAL_KEY: opts.falKey || '',
      WORKBURO_IMAGES_DIR: opts.imagesDir || '',
      WORKBURO_IMAGE_MODEL: opts.imageModel || '',
      WORKBURO_IMAGE_EDIT_MODEL: opts.imageEditModel || '',
      WORKBURO_WORKSPACE: opts.workspace || ''
    }
  })

  let stderr = ''
  const translator = createTranslator(opts.onEvent, { workspace: opts.workspace, startedAt: Date.now() })
  const emit = opts.onEvent || (() => {})
  let settled = false
  let killed = false

  const promise = new Promise((resolve) => {
    let timer = null
    if (opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        killed = true
        emit({ kind: 'error', message: stopMessage(opts.timeoutMs) })
        try { child.kill() } catch {}
      }, opts.timeoutMs)
    }
    child.stderr.on('data', d => { stderr += d })
    child.stdout.on('data', d => translator.push(d.toString('utf8')))
    child.on('error', err => {
      if (timer) clearTimeout(timer)
      if (settled) return
      settled = true
      emit({ kind: 'error', message: `could not start Pi: ${err.message}` })
      resolve({ ok: false, error: err.message, text: '', tools: [], events: translator.state })
    })
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      if (settled) return
      settled = true
      translator.flush()
      const tail = stderr.trim().split('\n').filter(Boolean).slice(-4).join('\n')
      const ok = code === 0 && !killed
      if (!ok) {
        const why = killed
          ? 'Stopped.'
          : (tail || `Pi exited with code ${code}`)
        emit({ kind: 'error', message: why })
      }
      resolve({
        ok,
        stopped: killed,
        exitCode: code,
        text: translator.state.text,
        thinking: translator.state.thinking,
        tools: translator.state.tools,
        usage: translator.state.usage,
        sessionId: translator.state.sessionId,
        unparsed: translator.state.unparsed,
        stderr: tail,
        events: translator.state
      })
    })
  })

  return {
    promise,
    kill () {
      killed = true
      try { child.kill() } catch {}
    }
  }
}

/**
 * The provider config Pi is given.
 *
 * `input` matters more than it looks. Pi sends a picture only to a model it believes can read one,
 * and anything left undeclared is taken as text-only: the picture was accepted, recorded in Pi's own
 * session, and then never sent, while the same model read the same file correctly through the chat
 * path. A model known to be text-only says so; everything else is offered pictures.
 */
function modelsFor (catalog) {
  const seen = new Set()
  const out = []
  for (const m of catalog || []) {
    const id = typeof m === 'string' ? m : m && m.id
    if (!id || seen.has(id)) continue
    seen.add(id)
    const input = Array.isArray(m && m.input) && m.input.length ? m.input : ['text', 'image']
    out.push({ id, name: (m && m.name) || id, reasoning: !!(m && m.reasoning), input })
  }
  return out
}

module.exports = { ensureImageExtension,
  humanDuration,
  stopMessage,
  PI_VERSION,
  PROVIDER,
  KEY_ENV,
  TOOL_LABELS,
  summarize,
  resultText,
  assetFor,
  layout,
  status,
  sessionDirFor,
  sessionAgentDirFor,
  hasSession,
  install,
  writeConfig,
  createTranslator,
  outputsFromTool,
  runTurn,
  turnArgs,
  modelsFor,
  shaFor,
  makeExecutable,
  hoistContents,
  renameWithRetry
}
