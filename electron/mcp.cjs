/**
 * MCP servers, spoken to directly.
 *
 * A Model Context Protocol client, hand-rolled rather than taken from the SDK. The reason is the
 * era split: the spec revision 2026-07-28 removed the `initialize` handshake (a session's version,
 * client identity and capabilities ride on every request in `params._meta`), while the official
 * TypeScript SDK still tops out at 2025-11-25 — so a client built on it cannot talk to a
 * modern-only server at all, and compatibility runs both ways. A client has to detect the era per
 * server. Hand-rolling also means per-call timeouts, tolerance of the banner-on-stdout bug that
 * most community servers have, and a tree-kill on Windows, none of which the SDK gives us.
 *
 * State lives at module scope on purpose: windows are recreated on reload and on activate, and a
 * client held in a window payload dies with it. Nothing here connects until a chat actually needs
 * tools, so a user who never turns this on never gets a child process.
 */

'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

/** The revision this client prefers, and the one it falls back to for older servers. */
const MODERN = '2026-07-28'
const LEGACY = '2025-11-25'

const CLIENT_NAME = 'workburo-desktop'
const CLIENT_VERSION = '1.0.0'

/** Long enough for a slow `tools/list`, short enough that a dead server cannot hang the app. */
const HANDSHAKE_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 60_000
const LIST_TIMEOUT_MS = 15_000

/**
 * Per-connection timeouts, so a caller can tighten them. The tests do: a server that never answers
 * has to be caught in a second or two, not ten.
 */
function timeoutsFor(opts) {
  const t = (opts && opts.timeouts) || {}
  const pick = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback)
  return {
    handshake: pick(t.handshake, HANDSHAKE_TIMEOUT_MS),
    list: pick(t.list, LIST_TIMEOUT_MS),
    call: pick(t.call, CALL_TIMEOUT_MS),
  }
}

/**
 * Environment handed to a stdio server: a baseline that any child needs to start, plus exactly the
 * entries the user configured for that server. Never this process's whole environment — it holds
 * the app's own API keys, and a third-party server has no business reading them.
 */
const ENV_BASELINE = [
  'PATH',
  'Path',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'USERNAME',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ComSpec',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'LANG',
  'LC_ALL',
  'HOME',
  // The Unix side of the same list. Without TMPDIR a program that writes a temporary file is left
  // guessing, and without USER or SHELL a script that asks who it is running as gets nothing. Names
  // that are absent on this platform are skipped, so carrying both sets costs nothing.
  'TMPDIR',
  'USER',
  'LOGNAME',
  'SHELL',
  'TZ',
  'SSH_AUTH_SOCK',
]

/** What the process table must never see, and what a log must never keep. */
function redact(value) {
  return String(value == null ? '' : value)
    .replace(/\b(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{8,}/g, '$1…')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-…')
    .replace(/\boc_sk_[A-Za-z0-9_-]{4,}/g, 'oc_sk_…')
    .replace(/\bak_[A-Za-z0-9_-]{6,}/g, 'ak_…')
    .replace(/\bck_[A-Za-z0-9_-]{6,}/g, 'ck_…')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{6,}/g, 'xox…')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, '$1 …')
    .replace(/\b(token|key|apikey|api_key|password|passwd|secret)=([^\s&"']+)/gi, '$1=…')
}

/** A redacted view for the window: the renderer never needs the value, only proof it is set. */
function redactedValue(value) {
  const v = String(value == null ? '' : value)
  if (!v) return ''
  if (v.length <= 4) return '••••'
  return `••••${v.slice(-4)}`
}

/** One line of the child's environment map, already filtered to what it is allowed to see. */
function childEnv(entries) {
  const env = {}
  for (const name of ENV_BASELINE) {
    if (process.env[name] != null) env[name] = process.env[name]
  }
  for (const [k, v] of Object.entries(entries || {})) {
    if (!k || v == null) continue
    // A configured entry wins over the baseline, and an empty value means "unset", not "blank".
    if (String(v) === '') delete env[k]
    else env[k] = String(v)
  }
  return env
}

/* ------------------------------------------------------------------ the live servers */

/**
 * serverKey -> connection. Module scope, deliberately: see the note at the top of the file.
 * A connection is { key, spec, child, era, info, tools, stderr, nextId, pending, exited, attempts }
 */
const live = new Map()

function keyOf(spec) {
  return String((spec && spec.name) || '').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')
}

/** The name a tool is exposed under: stable, prefixed, and impossible to collide with a built-in. */
function toolId(serverName, toolName) {
  return `mcp__${keyOf({ name: serverName })}__${String(toolName || '')}`
}

function splitToolId(id) {
  const parts = String(id || '').split('__')
  if (parts.length < 3 || parts[0] !== 'mcp') return null
  return { server: parts[1], tool: parts.slice(2).join('__') }
}

/* ------------------------------------------------------------------ JSON-RPC over stdio */

/**
 * Send one request and wait for its reply. Every await has a timeout: a server that stops
 * answering must never hang the app, and the timeout path kills the process tree before returning.
 */
function request(conn, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!conn.child || conn.exited) return reject(new Error(`${conn.spec.name} is not running`))
    const id = conn.nextId++
    const body = { jsonrpc: '2.0', id, method }
    if (params !== undefined) body.params = params
    const timer = setTimeout(() => {
      conn.pending.delete(id)
      // Judged dead rather than merely slow: kill the tree so a half-open server cannot be reused.
      killTree(conn)
      reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    conn.pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      },
    })
    try {
      conn.child.stdin.write(`${JSON.stringify(body)}\n`)
    } catch (err) {
      clearTimeout(timer)
      conn.pending.delete(id)
      reject(new Error(`could not write to ${conn.spec.name}: ${redact(err.message)}`))
    }
  })
}

/** A notification has no reply and must not be awaited. */
function notify(conn, method, params) {
  if (!conn.child || conn.exited) return
  const body = { jsonrpc: '2.0', method }
  if (params !== undefined) body.params = params
  try {
    conn.child.stdin.write(`${JSON.stringify(body)}\n`)
  } catch {
    /* a notification that cannot be sent is not worth failing a turn over */
  }
}

/**
 * The `_meta` block for a modern request. The revision has no handshake, so the session's identity
 * travels on every message; a mismatch comes back as -32022 with the supported list in `data`.
 */
function modernMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': MODERN,
    'io.modelcontextprotocol/clientInfo': { name: CLIENT_NAME, version: CLIENT_VERSION },
    'io.modelcontextprotocol/clientCapabilities': { tools: {} },
  }
}

function isModernError(err) {
  const code = err && err.code
  return code === -32022 || code === -32020
}

/**
 * Work out which protocol era a server speaks, then keep speaking only that one.
 *
 * Modern servers answer `server/discover`; a recognised modern error counts as an answer, because
 * the server understood the revision well enough to reject it and told us what it does support.
 * Anything else — an old error code, or silence — means the legacy `initialize` handshake. Never
 * key the fallback to one code: legacy servers answer -32601, -32602, or nothing at all.
 */
async function detectEra(conn) {
  try {
    const res = await request(conn, 'server/discover', { _meta: modernMeta() }, conn.t.handshake)
    if (res && typeof res === 'object') {
      conn.era = 'modern'
      conn.info = res.serverInfo || res
      return conn.era
    }
  } catch (err) {
    if (isModernError(err.rpc)) {
      conn.era = 'modern'
      conn.info = { supported: (err.rpc.data && err.rpc.data.supported) || [] }
      return conn.era
    }
    // Anything else means the server does not know the modern revision.
  }
  await initializeLegacy(conn)
  conn.era = 'legacy'
  return conn.era
}

async function initializeLegacy(conn) {
  const res = await request(
    conn,
    'initialize',
    {
      protocolVersion: LEGACY,
      capabilities: { tools: {} },
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    },
    conn.t.handshake,
  )
  conn.info = (res && res.serverInfo) || conn.info || {}
  notify(conn, 'notifications/initialized', {})
  return res
}

/** The params wrapper a modern server expects, versus the legacy flat body. */
function callParams(conn, params) {
  if (conn.era !== 'modern') return params
  return { ...(params || {}), _meta: modernMeta() }
}

/* ------------------------------------------------------------------ process lifetime */

/**
 * Kill a launched server properly on Windows.
 *
 * `child.kill()` kills only the PID it was given. A server launched as `npx @scope/thing` is
 * cmd.exe, which starts node, which starts the real server: killing the first leaves the rest
 * holding locks, ports and auth. Close stdin, give it a moment to leave on its own, then take the
 * whole tree.
 */
async function killTree(conn) {
  const child = conn && conn.child
  conn.child = null
  conn.exited = true
  if (!child) return
  const done = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve()
    child.once('exit', resolve)
    setTimeout(resolve, 2000)
  })
  try {
    child.stdin.end()
  } catch {
    /* already gone */
  }
  await done
  if (child.exitCode === null && !child.signalCode) {
    try {
      const { execFile } = require('node:child_process')
      await new Promise((resolve) => {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => resolve())
        setTimeout(resolve, 1500)
      })
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* nothing left to do */
      }
    }
  }
}

/** Stop one server, by name or by the connection itself. */
async function stop(keyOrConn) {
  const conn = typeof keyOrConn === 'string' ? live.get(keyOf({ name: keyOrConn })) : keyOrConn
  if (!conn) return false
  live.delete(keyOf(conn.spec))
  await killTree(conn)
  return true
}

/** Everything, for app quit. Bounded so quitting is never blocked. */
async function closeAll() {
  const all = [...live.values()]
  live.clear()
  await Promise.all(all.map((c) => killTree(c).catch(() => {})))
  return all.length
}

function logLine(conn, line) {
  if (!line) return
  conn.stderr.push(redact(line).slice(0, 400))
  if (conn.stderr.length > 12) conn.stderr.shift()
  conn.log(redact(line))
}

/**
 * Read the child's stdout as JSON-RPC.
 *
 * A line that is not JSON is handed to the log instead of failing the connection. This is the
 * single most common community-server bug — a banner or an npm notice printed on stdout — and a
 * strict parser turns it into "this server does not work".
 */
function attachReader(conn) {
  let buffer = ''
  conn.child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let nl = buffer.indexOf('\n')
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        logLine(conn, line.startsWith('{') ? `[unparsable] ${line.slice(0, 200)}` : line)
        continue
      }
      if (msg && msg.id != null && conn.pending.has(msg.id)) {
        const waiter = conn.pending.get(msg.id)
        conn.pending.delete(msg.id)
        if (msg.error) {
          const err = new Error(redact(msg.error.message || 'the server returned an error'))
          err.rpc = msg.error
          waiter.reject(err)
        } else {
          waiter.resolve(msg.result)
        }
      }
      // notifications from the server (logging, progress) are logged, not awaited
      else if (msg && msg.method) logLine(conn, `${msg.method} ${JSON.stringify(msg.params || {}).slice(0, 200)}`)
    }
  })
  conn.child.stderr.on('data', (chunk) => {
    for (const line of chunk.toString('utf8').split('\n')) logLine(conn, line)
  })
}

/**
 * Find the real file a configured command refers to.
 *
 * `shell: true` is the easy way to reach an `npx` shim, but Node concatenates arguments in shell
 * mode instead of escaping them (it warns about exactly this, DEP0190), which turns a configured
 * argument into part of the command line. So a bare name is looked up on PATH with PATHEXT, the way
 * cmd.exe would, and only a `.cmd`/`.bat` shim is handed to cmd.exe, with every argument quoted.
 */
function resolveCommand(command) {
  const c = String(command || '').trim()
  if (!c) return null
  if (c.includes('/') || c.includes('\\')) {
    const here = fs.existsSync(c)
    return { file: c, needsShell: /\.(cmd|bat)$/i.test(c), missing: !here }
  }
  // Windows resolves a bare name by trying PATHEXT extensions; everywhere else the name itself is
  // the file, and appending .EXE to it finds nothing. This is why an MCP server configured with a
  // plain command name could never start on macOS.
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((e) => e.trim())
      .filter(Boolean)
    : ['']
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, c + ext)
      try {
        if (fs.existsSync(candidate)) {
          return { file: candidate, needsShell: /\.(cmd|bat)$/i.test(candidate), missing: false }
        }
      } catch {
        /* an unreadable PATH entry is not a reason to give up on the rest */
      }
    }
  }
  return { file: c, needsShell: false, missing: true }
}

/** Quote one argument for cmd.exe. Anything that could split or chain a command gets wrapped. */
function winQuote(value) {
  const s = String(value == null ? '' : value)
  if (!/[\s"^&|<>()%!]/.test(s)) return s
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
}

/**
 * Start one server and complete its handshake. Readiness *is* the handshake — there is no port to
 * poll — so nothing is returned until the era is known and `tools/list` has answered.
 */
function connect(spec, opts = {}) {
  const key = keyOf(spec)
  const logger = typeof opts.log === 'function' ? opts.log : () => {}
  return new Promise((resolve, reject) => {
    let child
    try {
      const command = String(spec.command || '').trim()
      if (!command) return reject(new Error(`${spec.name} has no command to run`))
      const found = resolveCommand(command)
      if (!found || found.missing) {
        return reject(new Error(`"${command}" was not found on this machine`))
      }
      const args = (Array.isArray(spec.args) ? spec.args : []).map(String)
      const spawnOpts = {
        cwd: spec.cwd || undefined,
        env: childEnv(spec.env),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
      if (found.needsShell && process.platform === 'win32') {
        // A .cmd/.bat shim is a batch file, so cmd.exe has to run it. Every argument is quoted, and
        // windowsVerbatimArguments keeps Node from quoting the line a second time.
        const line = `"${found.file}"${args.length ? ` ${args.map(winQuote).join(' ')}` : ''}`
        child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
          ...spawnOpts,
          windowsVerbatimArguments: true,
        })
      } else {
        child = spawn(found.file, args, spawnOpts)
      }
    } catch (err) {
      return reject(new Error(`${spec.name} could not start: ${redact(err.message)}`))
    }

    const conn = {
      spec,
      child,
      era: null,
      info: {},
      tools: [],
      stderr: [],
      nextId: 1,
      pending: new Map(),
      exited: false,
      log: logger,
      t: timeoutsFor(opts),
    }
    live.set(key, conn)
    attachReader(conn)

    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      live.delete(key)
      killTree(conn)
      const tail = conn.stderr.length ? ` Last output: ${conn.stderr.slice(-2).join(' | ')}` : ''
      reject(new Error(redact(err.message) + tail))
    }

    // A command that does not exist is an ENOENT on the spawn event: name the missing binary.
    child.on('error', (err) => {
      fail(
        err && err.code === 'ENOENT'
          ? new Error(`"${spec.command}" was not found on this machine`)
          : new Error(`${spec.name} could not start: ${err.message}`),
      )
    })

    // An unexpected exit is reported, never silently swallowed, and never auto-retried mid-call:
    // a write-side tool would fire twice.
    child.on('exit', (code, signal) => {
      conn.exited = true
      for (const waiter of conn.pending.values()) waiter.reject(new Error(`${spec.name} exited`))
      conn.pending.clear()
      if (!settled) return fail(new Error(`${spec.name} exited during startup (code ${code}${signal ? `, ${signal}` : ''})`))
      logger(`[mcp] ${spec.name} exited (code ${code})`)
      if (opts.onExit) opts.onExit(key, code)
    })

    ;(async () => {
      try {
        await detectEra(conn)
        const listed = await request(conn, 'tools/list', callParams(conn, {}), conn.t.list)
        conn.tools = Array.isArray(listed && listed.tools) ? listed.tools : []
        if (!settled) {
          settled = true
          resolve(conn)
        }
      } catch (err) {
        fail(err)
      }
    })()
  })
}

/* ------------------------------------------------------------------ what the app asks for */

/**
 * Make sure every enabled server is up. Called once per chat that needs tools, so a user with the
 * feature off never pays for a child process, and a server that is already running is not
 * restarted on every message.
 */
async function ensure(servers, opts = {}) {
  const wanted = (servers || []).filter((s) => s && s.enabled !== false && String(s.command || '').trim())
  const results = []
  for (const spec of wanted) {
    const key = keyOf(spec)
    const existing = live.get(key)
    if (existing && !existing.exited && existing.child) {
      results.push({ ok: true, name: spec.name, era: existing.era, tools: existing.tools.length, already: true })
      continue
    }
    try {
      const conn = await connect(spec, opts)
      results.push({ ok: true, name: spec.name, era: conn.era, tools: conn.tools.length })
    } catch (err) {
      results.push({ ok: false, name: spec.name, error: err.message })
    }
  }
  return results
}

/** Tool definitions in chat/completions shape, for every connected server. */
function defs() {
  const out = []
  for (const conn of live.values()) {
    if (conn.exited) continue
    for (const t of conn.tools || []) {
      if (!t || !t.name) continue
      const description = String(t.description || '').trim()
      out.push({
        type: 'function',
        function: {
          name: toolId(conn.spec.name, t.name),
          description:
            (description ? description.slice(0, 900) : `A tool named ${t.name}`) +
            ` (from the MCP server "${conn.spec.name}")`,
          parameters:
            t.inputSchema && typeof t.inputSchema === 'object'
              ? t.inputSchema
              : { type: 'object', properties: {} },
        },
      })
    }
  }
  return out
}

/** The names currently exposed, for the app's own bookkeeping. */
function toolNames() {
  return defs().map((d) => d.function.name)
}

/**
 * Run one tool. A protocol failure throws; a tool that ran and failed comes back as a normal
 * result carrying isError, so the model sees the reason and can correct itself instead of the
 * turn dying.
 */
async function callTool(id, args) {
  const parts = splitToolId(id)
  if (!parts) throw new Error(`"${id}" is not an MCP tool name`)
  const conn = live.get(parts.server)
  if (!conn || conn.exited) throw new Error(`The MCP server "${parts.server}" is not running`)
  const result = await request(
    conn,
    'tools/call',
    callParams(conn, { name: parts.tool, arguments: args && typeof args === 'object' ? args : {} }),
    conn.t.call,
  )
  const content = Array.isArray(result && result.content) ? result.content : []
  const text = content
    .map((c) => {
      if (!c || typeof c !== 'object') return ''
      if (c.type === 'text') return String(c.text || '')
      if (c.type === 'resource') return `[resource: ${(c.resource && c.resource.uri) || 'unnamed'}]`
      if (c.type === 'image') return '[image]'
      return `[${c.type || 'content'}]`
    })
    .filter(Boolean)
    .join('\n')
    .slice(0, 8000)
  return {
    ok: !(result && result.isError),
    text: text || (result && result.isError ? 'the tool reported an error with no message' : '(the tool returned nothing)'),
    error: result && result.isError ? text || 'the tool reported an error' : null,
  }
}

/** What Settings shows: names, eras, tool counts, and any last error. Never a secret. */
function status() {
  return [...live.values()].map((conn) => ({
    name: conn.spec.name,
    key: keyOf(conn.spec),
    running: !conn.exited && !!conn.child,
    era: conn.era,
    info: conn.info && conn.info.name ? { name: conn.info.name, version: conn.info.version || '' } : {},
    tools: (conn.tools || []).map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 200) })),
    lastOutput: conn.stderr.slice(-3),
  }))
}

/**
 * Check one server without leaving it connected: this is what the Test button calls. It also
 * proves the command exists, which is the failure a user can actually fix.
 */
async function test(spec, opts = {}) {
  try {
    const conn = await connect(spec, { ...opts, onExit: undefined })
    const summary = {
      ok: true,
      name: spec.name,
      era: conn.era,
      info: conn.info && conn.info.name ? { name: conn.info.name, version: conn.info.version || '' } : {},
      tools: (conn.tools || []).map((t) => t.name),
    }
    await stop(conn)
    return summary
  } catch (err) {
    return { ok: false, name: spec.name, error: err.message }
  }
}

module.exports = {
  MODERN,
  LEGACY,
  ensure,
  connect,
  stop,
  closeAll,
  defs,
  toolNames,
  callTool,
  status,
  test,
  redact,
  redactedValue,
  toolId,
  splitToolId,
  keyOf,
  childEnv,
  resolveCommand,
  winQuote,
  live,
}
