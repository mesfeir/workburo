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

/** Download with byte progress, so a 42 MB install is not a frozen button. */
async function download (url, dest, onProgress, signal) {
  const res = await fetch(url, { redirect: 'follow', signal })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  let received = 0
  const out = fs.createWriteStream(dest)
  try {
    for await (const chunk of res.body) {
      out.write(chunk)
      received += chunk.length
      if (onProgress) onProgress({ phase: 'download', received, total, pct: total ? Math.round((received / total) * 100) : null })
    }
  } finally {
    await new Promise(r => out.end(r))
  }
  return received
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
  const sumsRes = await fetch(`${base}/SHA256SUMS`, { redirect: 'follow', signal: opts.signal })
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
    if (!fs.existsSync(path.join(staging, path.basename(L.exe)))) {
      throw new Error('the release did not contain the expected program')
    }
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
  const entries = (models || [])
    .filter(m => m && m.id)
    .map(m => ({
      id: m.id,
      name: m.name || m.id,
      ...(m.reasoning ? { reasoning: true } : {}),
      input: ['text']
    }))
  const config = {
    providers: {
      [PROVIDER]: {
        baseUrl,
        api: 'openai-completions',
        apiKey: `$${KEY_ENV}`,
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
function createTranslator (onEvent) {
  const emit = onEvent || (() => {})
  const state = { text: '', thinking: '', tools: [], usage: null, sessionId: null, lines: 0, unparsed: 0 }
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
        state.tools.push(tool)
        emit({ kind: 'tool_start', tool })
        break
      }
      case 'tool_execution_end': {
        const tool = state.tools.find(t => t.id === e.toolCallId)
        if (tool) tool.ok = !e.isError
        emit({ kind: 'tool_end', id: e.toolCallId, name: e.toolName, ok: !e.isError, text: resultText(e.result), result: e.result })
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
 * One turn, one process. Resolves when Pi settles, with the text it produced.
 * Returns a handle so the Stop button can end it.
 */
function runTurn (opts) {
  const L = layout(opts.piRoot)
  const model = `${PROVIDER}/${opts.model}`
  const args = ['--mode', 'json']
  // A conversation keeps its own Pi session, so a follow-up turn remembers the previous one —
  // including what its tools did. With no session directory the turn is a one-off.
  if (opts.sessionDir) {
    fs.mkdirSync(opts.sessionDir, { recursive: true })
    args.push('--session-dir', opts.sessionDir)
    if (hasSession(opts.sessionDir)) args.push('--continue')
  } else {
    args.push('--no-session')
  }
  args.push('--model', model, opts.prompt)

  const child = spawn(L.exe, args, {
    cwd: opts.workspace || opts.piRoot,
    windowsHide: true,
    // stdin is closed on purpose. Pi is TUI-first, and a piped stdin that never ends can leave
    // it waiting for input that will never arrive — a turn that hangs instead of finishing.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: L.agentDir,
      [KEY_ENV]: opts.relayKey || ''
    }
  })

  let stderr = ''
  const translator = createTranslator(opts.onEvent)
  const emit = opts.onEvent || (() => {})
  let settled = false
  let killed = false

  const promise = new Promise((resolve) => {
    let timer = null
    if (opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        killed = true
        emit({ kind: 'error', message: `Agent turn timed out after ${Math.round(opts.timeoutMs / 1000)}s.` })
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

/** The models Pi may use: the same list the chat offers, so the two never disagree. */
function modelsFor (catalog) {
  const seen = new Set()
  const out = []
  for (const m of catalog || []) {
    const id = typeof m === 'string' ? m : m && m.id
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: (m && m.name) || id, reasoning: !!(m && m.reasoning) })
  }
  return out
}

module.exports = {
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
  hasSession,
  install,
  writeConfig,
  createTranslator,
  runTurn,
  modelsFor,
  shaFor
}
