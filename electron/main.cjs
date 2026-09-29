// WorkBuro — Electron main process
// Owns: window, on-disk store, and the streaming network layer for any
// OpenAI-compatible endpoint (Chat Completions + Responses protocols).

const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  Tray,
  Menu,
  nativeImage,
  screen,
  globalShortcut,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const falImages = require('./images.cjs')

const DEV_URL = 'http://localhost:5173'
const isDev = !app.isPackaged

// --selftest [--keep]  drives the real UI and writes a report + screenshots.
// The relay key comes from ZEN_SELFTEST_KEY in the environment, never from the command line: a
// process command line is readable by any process on the machine, which is how a key leaks.
const SELFTEST = process.argv.includes('--selftest')
// --capture <api-key>  drives a curated conversation and writes README screenshots
const CAPTURE = process.argv.includes('--capture')
const KEEP_OPEN = process.argv.includes('--keep')
// launched by the Windows "Run" entry: register the hotkey and stay in the tray
const START_HIDDEN = process.argv.includes('--hidden')
// the argument written alongside the exe in the Windows "Run" key
const STARTUP_FLAG = '--hidden'
/**
 * A key for a test run: from the environment, never argv.
 *
 * Anything on a command line is visible to every process on the box — a probe during this work
 * read `electron.exe . --selftest oc_sk_…` straight out of the Windows process table. Secrets go
 * in the environment (or a file the caller deletes), and argv carries flags only.
 */
const testKey = () => String(process.env.ZEN_SELFTEST_KEY || '').trim()

const argAfter = (flag) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const DEFAULT_WINDOW = { width: 480, height: 660 }
const MIN_WINDOW = { width: 380, height: 420 }

// The product was renamed from Zen Chat to WorkBuro. Its data folder is pinned explicitly rather
// than left to be derived from the app name: a derived path would follow the rename to a new
// folder and quietly leave the store, the API keys and every saved picture behind in one that
// nothing reads any more. Existing installs are carried across once, and if the move cannot happen
// (a running copy still holding the folder) the old path is kept rather than starting empty.
const APP_DATA_DIR = app.getPath('appData')
const DATA_OLD = path.join(APP_DATA_DIR, 'zen-chat')
const DATA_NEW = path.join(APP_DATA_DIR, 'WorkBuro')
try {
  if (fs.existsSync(DATA_OLD) && !fs.existsSync(DATA_NEW)) fs.renameSync(DATA_OLD, DATA_NEW)
} catch {
  // fall through: keep using the old folder this run
}
app.setPath('userData', fs.existsSync(DATA_NEW) ? DATA_NEW : DATA_OLD)

if (SELFTEST || CAPTURE) {
  // isolate the test/capture run from the real profile
  const dir = path.join(require('node:os').tmpdir(), 'zen-selftest-profile')
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {}
  fs.mkdirSync(dir, { recursive: true })
  app.setPath('userData', dir)
}

let win = null
let tray = null
let activeHotkey = null
// what the user asked for vs. what Windows actually let us register
let hotkeyStatus = { requested: '', active: null, fallback: false, error: null }
// tried in order when the stored shortcut is already owned by another app
const HOTKEY_FALLBACKS = ['Ctrl+Alt+Space', 'Alt+Shift+Space', 'Ctrl+Alt+K', 'Ctrl+Shift+A']
const inflight = new Map() // requestId -> AbortController

/* ------------------------------------------------------------------ store */

function storePath() {
  return path.join(app.getPath('userData'), 'zen-chat-store.json')
}

/** where generated images are written; the store only keeps the path */
function imagesDir() {
  return path.join(app.getPath('userData'), 'images')
}

/** generated images live on disk — never inline megabytes of base64 into the store */
function stripInlineImages(store) {
  for (const c of Array.isArray(store?.conversations) ? store.conversations : []) {
    for (const m of c.messages || []) {
      if (!Array.isArray(m.images)) continue
      m.images = m.images.map((im) =>
        im && im.path
          ? { name: im.name, path: im.path, width: im.width, height: im.height, bytes: im.bytes, url: '' }
          : im,
      )
    }
  }
  return store
}

/** read the bytes back for display; a missing file is surfaced, never hidden */
function restoreInlineImages(store) {
  for (const c of Array.isArray(store?.conversations) ? store.conversations : []) {
    for (const m of c.messages || []) {
      if (!Array.isArray(m.images)) continue
      m.images = m.images.map((im) => {
        if (!im || !im.path || im.url) return im
        try {
          const buf = fs.readFileSync(im.path)
          const ext = path.extname(im.path).slice(1).toLowerCase()
          const mime = ext === 'png' ? 'png' : ext === 'webp' ? 'webp' : 'jpeg'
          return { ...im, url: `data:image/${mime};base64,${buf.toString('base64')}` }
        } catch {
          return { ...im, missing: true }
        }
      })
    }
  }
  return store
}

function defaultStore() {
  return {
    config: {
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: '',
      model: 'deepseek-v4.1-flash',
      systemPrompt: '',
      temperature: 1,
      maxTokens: 8192,
      thinking: true,
      stream: true,
      showUsage: true,
      protocol: 'auto',
      sendAffinity: true,
      affinityId: 'zen-chat-' + Math.random().toString(36).slice(2, 10),
      hotkey: 'Alt+Space',
      startWithWindows: false,
      // agent mode: off until Pi is installed and switched on in the chat
      agent: {
        workspace: '',
        enabled: false
      },
      titleModel: '',
      imageGen: {
        enabled: false,
        provider: 'fal',
        falKey: '',
        model: 'fal-ai/flux/schnell',
        // used when a message carries a reference image
        editModel: 'fal-ai/nano-banana/edit',
        count: 1,
        size: 'square_hd',
      },
      // MCP servers. Off until the user turns it on, and while it is off nothing is spawned at all,
      // so someone who does not use this never has child processes because of it.
      // A server is { name, command, args: [], env: {}, cwd, enabled }.
      mcp: {
        enabled: false,
        servers: [],
      },
      profiles: [
        { name: 'OpenCode Zen (Go)', baseUrl: 'https://opencode.ai/zen/go/v1', affinity: true },
        { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', affinity: false },
        { name: 'LM Studio (local)', baseUrl: 'http://127.0.0.1:1234/v1', affinity: false },
      ],
      // window behaviour: above other windows by default, and out of the way after a delay
      alwaysOnTop: true,
      autoMinimizeSec: 30,
      modelPrefs: {}, // modelId -> { vision?: boolean, protocol?: string, note?: string }
    },
    conversations: [],
    activeId: null,
    models: [],
  }
}

function readStore() {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8')
    const parsed = JSON.parse(raw)
    const base = defaultStore()
    const cfg = { ...base.config, ...(parsed.config || {}) }
    // One-time nudge, shown in Settings → Images rather than done behind the user's back: the old
    // default edit endpoint re-draws from the prompt and barely uses the picture it is given, which
    // is why "make it bigger" came back as a new picture. An instruction editor is what "the same
    // picture, with my change" actually needs.
    if (cfg.imageGen && cfg.imageGen.editModel === 'fal-ai/flux/dev/image-to-image') {
      cfg.imageGen = {
        ...cfg.imageGen,
        editModel: 'fal-ai/nano-banana/edit',
        editModelMovedFrom: 'fal-ai/flux/dev/image-to-image',
      }
    }
    return restoreInlineImages({
      config: cfg,
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
      activeId: parsed.activeId || null,
      models: Array.isArray(parsed.models) ? parsed.models : [],
    })
  } catch {
    return defaultStore()
  }
}

let saveTimer = null
function writeStore(data) {
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true })
    fs.writeFileSync(storePath(), JSON.stringify(stripInlineImages(data), null, 2), 'utf8')
    return true
  } catch (err) {
    console.error('[store] write failed', err)
    return false
  }
}

function scheduleSave(data) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => writeStore(data), 400)
}

/* ----------------------------------------------------------------- window */

function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function readWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'))
    if (s && Number.isFinite(s.width) && Number.isFinite(s.height)) return s
  } catch {}
  return null
}

function writeWindowState() {
  if (!win || win.isDestroyed()) return
  try {
    const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds()
    fs.writeFileSync(windowStatePath(), JSON.stringify(b), 'utf8')
  } catch {}
}

let boundsTimer = null
function scheduleWindowState() {
  if (boundsTimer) clearTimeout(boundsTimer)
  boundsTimer = setTimeout(writeWindowState, 500)
}

// keep a remembered window on-screen even if the monitor layout changed
function clampToDisplay(b) {
  const area = screen.getDisplayMatching({
    x: b.x ?? 0,
    y: b.y ?? 0,
    width: b.width,
    height: b.height,
  }).workArea
  const width = Math.round(Math.min(Math.max(b.width, MIN_WINDOW.width), area.width))
  const height = Math.round(Math.min(Math.max(b.height, MIN_WINDOW.height), area.height))
  const centredX = area.x + Math.round((area.width - width) / 2)
  const centredY = area.y + Math.round((area.height - height) / 2)
  const x = Math.min(Math.max(b.x ?? centredX, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(b.y ?? centredY, area.y), area.y + area.height - height)
  return { x, y, width, height }
}

function defaultWindowBounds() {
  return clampToDisplay(DEFAULT_WINDOW)
}

function createWindow() {
  const bounds = clampToDisplay(readWindowState() || DEFAULT_WINDOW)

  win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: false,
    backgroundColor: '#0d0d0d',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d0d0d', symbolColor: '#a8a8a8', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // a launch-at-login start stays quiet in the tray — the hotkey brings it up.
  // but never start hidden with no way back in: if nothing registered, show it.
  win.once('ready-to-show', () => {
    if (START_HIDDEN && !activeHotkey) {
      console.log('[startup] launched at login but no summon shortcut registered — showing the window')
      win.show()
    } else if (!START_HIDDEN) {
      win.show()
    } else {
      console.log('[startup] started quietly in the tray — press the summon shortcut to open')
    }
  })

  win.on('resize', scheduleWindowState)
  win.on('move', scheduleWindowState)
  win.on('close', writeWindowState)

  // above other windows, and away by itself once you have gone elsewhere
  win.on('blur', () => armAutoMinimize(readStore().config))
  win.on('focus', cancelAutoMinimize)
  win.on('minimize', cancelAutoMinimize)
  win.on('restore', cancelAutoMinimize)
  applyAlwaysOnTop(readStore().config)

  if (isDev) {
    win.loadURL(DEV_URL)
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  // external links open in the default browser, never inside the app shell
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:/.test(url)) shell.openExternal(url)
    }
  })

  if (isDev && !SELFTEST && !CAPTURE && !START_HIDDEN) win.webContents.openDevTools({ mode: 'detach' })
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function hideWindow() {
  if (win && !win.isDestroyed()) win.hide()
}

/** spotlight-style toggle: hidden (or unfocused) -> show; focused -> hide */
function toggleWindow() {
  if (!win || win.isDestroyed()) return createWindow()
  if (win.isVisible() && win.isFocused()) hideWindow()
  else showWindow()
}

/**
 * Window behaviour.
 *
 * This is a summoned launcher, so it sits above other windows and, once it has been left alone,
 * tucks itself away. The delay starts when the window loses focus and is called off if focus comes
 * back. Nothing is minimised while an answer or a picture is still on its way — losing sight of a
 * run in progress is worse than one extra window on screen — and a busy moment is asked about
 * again rather than skipped, so the window does put itself away once the work is done.
 */
let autoMinTimer = null
let imageJobs = 0
let lastAutoMinSec = null

function workInFlight() {
  return inflight.size > 0 || activeAgentTurns.size > 0 || imageJobs > 0
}

function autoMinimizeSecs(cfg) {
  const raw = cfg && cfg.autoMinimizeSec != null ? Number(cfg.autoMinimizeSec) : 30
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

function applyAlwaysOnTop(cfg) {
  if (!win || win.isDestroyed()) return
  // 'floating' rather than plain topmost: above ordinary windows without fighting full-screen apps
  win.setAlwaysOnTop(cfg ? cfg.alwaysOnTop !== false : true, 'floating')
}

function cancelAutoMinimize() {
  if (autoMinTimer) clearTimeout(autoMinTimer)
  autoMinTimer = null
}

function armAutoMinimize(cfg) {
  cancelAutoMinimize()
  const secs = autoMinimizeSecs(cfg)
  if (!win || win.isDestroyed() || secs <= 0) return
  if (win.isFocused() || win.isMinimized() || !win.isVisible()) return
  autoMinTimer = setTimeout(() => {
    autoMinTimer = null
    if (!win || win.isDestroyed()) return
    if (win.isFocused() || win.isMinimized() || !win.isVisible()) return
    if (workInFlight()) {
      armAutoMinimize(cfg)
      return
    }
    win.minimize()
  }, secs * 1000)
  if (autoMinTimer.unref) autoMinTimer.unref()
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/* ------------------------------------------------------------ agent mode */

// Pi in the backend, with hands. Off by default: nothing is downloaded, installed or started
// until the user asks for it, and when the toggle is off no process is ever spawned.

const pi = require('./pi.cjs')
const { dialog: piDialog } = require('electron')

/** Pi lives beside the store, so uninstalling is deleting one folder. */
const PI_ROOT = () => path.join(app.getPath('userData'), 'pi')

/** The model list Pi is offered: the one the chat offers, so the two cannot disagree. */
function agentModels (cfg, store) {
  const fromStore = Array.isArray(store && store.models) ? store.models : []
  const list = fromStore.length ? fromStore : []
  return pi.modelsFor(list.concat([{ id: cfg.model, name: cfg.model }]))
}

const activeAgentTurns = new Map()
// requestId -> what the window needs in order to show a running session. The handles above are
// kept separate because a handle has a kill() and this does not.
const agentSessions = new Map()
const sessionList = () => [...agentSessions.values()].map(m => sessionSummary(m))
const broadcastSessions = () => sendToRenderer('agent:sessions', sessionList())
let agentInstalling = false

/** Pi's events, in the words the chat already knows how to render. */
function agentEventFor (requestId, ev) {
  switch (ev.kind) {
    case 'text':
      return { type: 'text', value: ev.delta }
    case 'thinking':
      return { type: 'reasoning', value: ev.delta }
    case 'usage':
      return { type: 'usage', value: ev.usage }
    case 'tool_start':
      return {
        type: 'tool',
        value: {
          id: ev.tool.id,
          name: ev.tool.name,
          label: ev.tool.label,
          phase: 'start',
          args: ev.tool.args,
          query: ev.tool.summary
        }
      }
    case 'tool_end':
      return {
        type: 'tool',
        value: {
          id: ev.id,
          name: ev.name,
          phase: 'end',
          ok: ev.ok,
          preview: ev.text,
          error: ev.ok ? null : (ev.text || 'the command failed')
        }
      }
    case 'error':
      return { type: 'error', value: ev.message }
    default:
      return null
  }
}

function agentFail (requestId, message) {
  sendToRenderer('chat:event', { requestId, type: 'error', value: message })
  sendToRenderer('chat:event', { requestId, type: 'done' })
  return { ok: false, error: message }
}

/**
 * The first agent turn in a conversation is seeded with what was said before it, because Pi
 * has no way to know about messages the chat handled itself. Every later turn continues Pi's
 * own session instead, so nothing is repeated.
 */
function agentSeed (store, convId, currentPrompt) {
  const convo = (store.conversations || []).find(c => c.id === convId)
  if (!convo) return ''
  const now = String(currentPrompt || '').trim()
  const lines = []
  for (const m of convo.messages || []) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const text = String(m.content || '').trim()
    if (!text || text === now) continue
    lines.push(`${m.role === 'user' ? 'user' : 'assistant'}: ${text.replace(/\s+/g, ' ').slice(0, 600)}`)
  }
  const recent = lines.slice(-12)
  if (!recent.length) return ''
  return [
    'Earlier in this conversation, before agent mode was switched on, this was said. Treat it as context for what comes next; do not repeat it back.',
    '',
    ...recent
  ].join('\n')
}

/**
 * One agent turn: Pi runs the loop in the chosen folder, using the model the chat has selected.
 * The provider config is regenerated first, so switching model in the composer switches the
 * model the agent uses too.
 */
async function runAgentTurn (req) {
  const requestId = req && req.requestId
  const store = readStore()
  const cfg = store.config || {}
  const agent = cfg.agent || {}

  if (!pi.status(PI_ROOT()).installed) {
    return agentFail(requestId, 'Agent mode needs Pi installed. Add it in Settings → Agent.')
  }
  // Which folder this session works in. The request wins, then the chat's own folder, then the
  // global default. A chat can therefore point at its own folder, which is what makes running two
  // sessions at once useful rather than confusing.
  const conversation = (store.conversations || []).find(c => c.id === req.conversationId)
  const workspace = pickWorkspace({
    request: req.workspace,
    conversation: conversation && conversation.agentWorkspace,
    global: agent.workspace
  })
  if (!workspace) {
    return agentFail(requestId, 'Agent mode needs a workspace folder. Choose one in Settings → Agent.')
  }
  if (!fs.existsSync(workspace)) {
    return agentFail(requestId, `The agent workspace no longer exists: ${workspace}`)
  }

  // Every session gets its own agent dir. Pi writes its provider config (models.json) into that
  // directory, so two turns running at the same time with different models, or a different key,
  // used to overwrite each other's config. One directory per session is what makes more than one
  // agent turn at a time safe rather than merely possible.
  const agentDir = pi.sessionAgentDirFor(PI_ROOT(), req.conversationId)
  pi.writeConfig({ agentDir, baseUrl: cfg.baseUrl, models: agentModels(cfg, store) })

  // Pi keeps this conversation's own session, so a follow-up turn remembers the last one —
  // including what its tools did. Only the very first turn needs the chat's own history,
  // because Pi never saw those messages.
  const sessionDir = pi.sessionDirFor(PI_ROOT(), req.conversationId)
  const firstAgentTurn = !pi.hasSession(sessionDir)
  const seed = firstAgentTurn ? agentSeed(store, req.conversationId, req.prompt) : ''
  const prompt = seed ? `${seed}\n\n---\n\n${req.prompt}` : req.prompt

  const handle = pi.runTurn({
    piRoot: PI_ROOT(),
    workspace,
    sessionDir,
    agentDir,
    model: req.model || cfg.model,
    relayKey: cfg.apiKey,
    prompt,
    timeoutMs: 15 * 60 * 1000,
    onEvent: ev => {
      const mapped = agentEventFor(requestId, ev)
      if (mapped) sendToRenderer('chat:event', { requestId, ...mapped })
    }
  })
  activeAgentTurns.set(requestId, handle)
  agentSessions.set(requestId, {
    requestId,
    conversationId: req.conversationId || '',
    title: (conversation && conversation.title) || 'New chat',
    workspace,
    model: req.model || cfg.model,
    startedAt: Date.now()
  })
  broadcastSessions()
  let result
  try {
    result = await handle.promise
  } finally {
    activeAgentTurns.delete(requestId)
    agentSessions.delete(requestId)
    broadcastSessions()
  }
  sendToRenderer('chat:event', { requestId, type: 'done' })
  return {
    ok: result.ok,
    stopped: !!result.stopped,
    text: result.text,
    tools: result.tools.length
  }
}

/* ---------------------------------------------------------------- hotkey */

function registerHotkey(accelerator) {
  if (activeHotkey) {
    try {
      globalShortcut.unregister(activeHotkey)
    } catch {}
    activeHotkey = null
  }
  if (!accelerator) return { ok: true, registered: false, accelerator: '' }

  try {
    const ok = globalShortcut.register(accelerator, toggleWindow)
    if (ok) {
      activeHotkey = accelerator
      return { ok: true, registered: true, accelerator }
    }
    return {
      ok: false,
      registered: false,
      accelerator,
      error: `${accelerator} is already taken by another app — try a different combination.`,
    }
  } catch (err) {
    return { ok: false, registered: false, accelerator, error: `Not a valid shortcut: ${err.message}` }
  }
}

function applyStoredHotkey() {
  const cfg = readStore().config
  const requested = cfg.hotkey || ''
  hotkeyStatus = { requested, active: null, fallback: false, error: null }
  if (!requested) return hotkeyStatus

  const first = registerHotkey(requested)
  if (first.ok && first.registered) {
    hotkeyStatus.active = first.accelerator
    console.log(`[hotkey] listening on ${first.accelerator}`)
    return hotkeyStatus
  }

  // The obvious default (Alt+Space) is commonly owned by another launcher —
  // PowerToys Run takes it, Listary takes more. Fall back to a free
  // combination and say so, rather than leaving the user with no way in.
  for (const candidate of HOTKEY_FALLBACKS) {
    const r = registerHotkey(candidate)
    if (r.ok && r.registered) {
      hotkeyStatus = {
        requested,
        active: candidate,
        fallback: true,
        error: `${requested} is held by another app, so WorkBuro is using ${candidate} for now.`,
      }
      console.log(`[hotkey] ${hotkeyStatus.error}`)
      notifyHotkeyStatus()
      return hotkeyStatus
    }
  }

  hotkeyStatus = {
    requested,
    active: null,
    fallback: false,
    error: `${requested} could not be registered. Choose another shortcut in Settings → General.`,
  }
  console.log(`[hotkey] ${hotkeyStatus.error}`)
  notifyHotkeyStatus()
  return hotkeyStatus
}

function notifyHotkeyStatus() {
  try {
    if (win && !win.isDestroyed()) win.webContents.send('hotkey:status', hotkeyStatus)
  } catch {}
}

/* ------------------------------------------------------------------ tray */

function createTray() {
  if (tray) return
  const iconPath = path.join(__dirname, 'assets', 'tray.png')
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) image = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray@1x.png'))
  tray = new Tray(image)
  tray.setToolTip('WorkBuro')

  const cfg = readStore().config
  const menu = Menu.buildFromTemplate([
    { label: 'Show / hide WorkBuro', click: () => toggleWindow() },
    {
      label: 'New chat',
      click: () => {
        showWindow()
        sendToRenderer('ui:action', 'new-chat')
      },
    },
    {
      label: 'Settings',
      click: () => {
        showWindow()
        sendToRenderer('ui:action', 'settings')
      },
    },
    { type: 'separator' },
    { label: cfg.hotkey ? `Summon shortcut: ${cfg.hotkey}` : 'No summon shortcut set', enabled: false },
    { type: 'separator' },
    { label: 'Quit WorkBuro', click: () => app.quit() },
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => toggleWindow())
}

function refreshTrayMenu() {
  if (!tray) return
  tray.destroy()
  tray = null
  createTray()
}

/* --------------------------------------------------------- start on login */

function setStartWithWindows(enabled) {
  const exe = globalThis.process.execPath
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: exe,
      // a login start should not steal focus — it waits in the tray
      args: enabled ? [STARTUP_FLAG] : [],
    })
  } catch (err) {
    console.log(`[login] could not set login item: ${err.message}`)
  }
  return getLoginState()
}

function getLoginState() {
  const exe = globalThis.process.execPath
  try {
    // Windows matches the "Run" entry by path AND args, so read back with the
    // same args we write — otherwise a healthy entry reports as disabled.
    const withArgs = app.getLoginItemSettings({ path: exe, args: [STARTUP_FLAG] })
    const plain = app.getLoginItemSettings({ path: exe })
    return {
      openAtLogin: Boolean(
        withArgs.openAtLogin || withArgs.executableWillLaunchAtLogin || plain.executableWillLaunchAtLogin,
      ),
      executableWillLaunchAtLogin: Boolean(plain.executableWillLaunchAtLogin),
      startsHidden: true,
    }
  } catch {
    return { openAtLogin: false, executableWillLaunchAtLogin: false, startsHidden: true }
  }
}


// one instance only: a second launch would fight over the summon hotkey,
// so it just raises the window we already have
const HAS_LOCK = SELFTEST || CAPTURE || app.requestSingleInstanceLock()
if (!HAS_LOCK) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
}

app.whenReady().then(() => {
  if (!HAS_LOCK) return

  if (SELFTEST) {
    const seeded = defaultStore()
    seeded.config.baseUrl = 'https://opencode.ai/zen/go/v1'
    seeded.config.apiKey = argAfter('--selftest') || testKey() || ''
    seeded.config.model = 'deepseek-v4.1-flash'
    seeded.config.thinking = true
    seeded.config.maxTokens = 4096
    seeded.config.sendAffinity = true
    seeded.config.showUsage = true
    // a fal key in the environment is used only to prove drawing works; it is never printed
    if (process.env.ZEN_FAL_KEY) {
      seeded.config.imageGen = { ...seeded.config.imageGen, falKey: process.env.ZEN_FAL_KEY, enabled: true }
    }
    // A conversation that already has a document attached. This has to be written *before* the window
    // loads: seeding it during the run never shows up (the sidebar has already rendered) and a reload
    // does not help either, because the app writes its own state back over the file. Attaching one in
    // the app needs the native dialog, so this is the only way the harness can check that an attached
    // document is displayed and answered from.
    const docFixture = path.join(__dirname, '..', 'scripts', 'fixtures', 'notes.md')
    if (fs.existsSync(docFixture)) {
      seeded.conversations = [
        {
          id: 'selftest-doc',
          title: 'document test',
          createdAt: Date.now(),
          messages: [
            {
              id: 'selftest-doc-1',
              role: 'user',
              content: 'summarise the attached file',
              createdAt: Date.now(),
              documents: [{ name: 'notes.md', path: docFixture, kind: 'document', docKind: 'text' }],
            },
          ],
        },
        ...(seeded.conversations || []),
      ]
    }
    writeStore(seeded)

    createWindow()
    applyStoredHotkey()
    createTray()
    win.webContents.once('did-finish-load', async () => {
      try {
        const { run } = require('./selftest.cjs')
        const results = await run({
          win,
          apiKey: argAfter('--selftest'),
          toggle: toggleWindow,
          hide: hideWindow,
          isVisible: () => win.isVisible(),
          showInactive: () => win.showInactive(),
          alwaysOnTop: () => win.isAlwaysOnTop(),
          isMinimized: () => win.isMinimized(),
          minimize: () => win.minimize(),
          restore: () => showWindow(),
          armAutoMinimize,
          autoMinimizeSecs: () => autoMinimizeSecs(readStore().config),
          workInFlight,
          isRegistered: (a) => globalShortcut.isRegistered(a),
          readBounds: () => win.getNormalBounds(),
          setLogin: setStartWithWindows,
          getLogin: getLoginState,
          isPackaged: app.isPackaged,
          reapplyStored: () => applyStoredHotkey(),
          hasFalKey: Boolean(process.env.ZEN_FAL_KEY),
        })
        const passed = results.filter((r) => r.pass).length
        console.log(`\n${passed}/${results.length} checks passed`)
        if (!KEEP_OPEN) setTimeout(() => app.exit(passed === results.length ? 0 : 1), 600)
      } catch (err) {
        console.error('selftest crashed:', err)
        app.exit(2)
      }
    })
    return
  }

  // README screenshot pass: seeds a small curated history, drives a real
  // conversation, writes the images under ZEN_SHOT_DIR. See electron/capture.cjs
  if (CAPTURE) {
    const seeded = defaultStore()
    seeded.config.baseUrl = 'https://opencode.ai/zen/go/v1'
    seeded.config.apiKey = argAfter('--capture') || testKey() || ''
    seeded.config.model = seeded.config.model || 'deepseek-v4.1-flash'
    writeStore(seeded)

    createWindow()
    applyStoredHotkey()
    createTray()
    win.webContents.once('did-finish-load', async () => {
      try {
        const { run } = require('./capture.cjs')
        await run({
          win,
          apiKey: argAfter('--capture') || '',
          storePath: storePath(),
          readStore,
          writeStore,
        })
      } catch (err) {
        console.error('capture crashed:', err)
        app.exit(2)
        return
      }
      setTimeout(() => app.exit(0), 600)
    })
    return
  }

  createWindow()
  applyStoredHotkey()
  createTray()
  // re-assert a login entry the user asked for (e.g. after the exe moved)
  const bootCfg = readStore().config
  if (bootCfg.startWithWindows && !getLoginState().openAtLogin) setStartWithWindows(true)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * MCP servers are child processes of this app, and quitting must not leave them behind. `will-quit`
 * does not wait for async work, so the teardown runs here, once, with a short budget so a server
 * that refuses to die cannot block quitting.
 */
let mcpQuitting = false
app.on('before-quit', (event) => {
  if (mcpQuitting || mcp.live.size === 0) return
  event.preventDefault()
  mcpQuitting = true
  Promise.race([mcp.closeAll(), new Promise((resolve) => setTimeout(resolve, 3000))])
    .catch(() => {})
    .then(() => app.quit())
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  if (tray && !tray.isDestroyed()) tray.destroy()
})

app.on('window-all-closed', () => {
  if (globalThis.process.platform !== 'darwin') app.quit()
})

/* ------------------------------------------------------------- url + http */

// Normalise whatever the user pasted into a usable API root.
function normalizeBaseUrl(input) {
  let raw = String(input || '').trim()
  if (!raw) throw new Error('No API base URL configured.')
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw
  let u
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`"${input}" is not a valid URL.`)
  }
  let p = u.pathname.replace(/\/+$/, '')
  // strip a full endpoint if the user pasted one
  p = p.replace(/\/(chat\/completions|responses|completions|messages)$/i, '')
  // strip a duplicated /v1/v1 or /zen/go/v1/v1
  p = p.replace(/(\/v\d+)\/v\d+$/i, '$1')
  // add /v1 only when there is no version segment already
  if (!/\/v\d+(\/|$)/i.test(p) && !/\/api$/i.test(p)) p = p + '/v1'
  u.pathname = p
  u.search = ''
  u.hash = ''
  return u.toString().replace(/\/+$/, '')
}

function headersFor(cfg, accept) {
  const h = {
    'Content-Type': 'application/json',
    // the opencode WAF 403s requests without a real User-Agent
    'User-Agent': 'WorkBuro/1.0 (Windows; Electron)',
    Accept: accept || 'application/json',
  }
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`
  let host = ''
  try {
    host = new URL(normalizeBaseUrl(cfg.baseUrl)).hostname
  } catch {}
  if (cfg.sendAffinity && /opencode\.ai$/i.test(host)) {
    // opencode's relay needs an opaque, stable per-conversation id
    h['x-opencode-session'] = cfg.affinityId || 'zen-chat-default'
  }
  return h
}

function looksLikeHtml(text) {
  const t = (text || '').trim().slice(0, 200).toLowerCase()
  return t.startsWith('<!doctype html') || t.startsWith('<html')
}

function extractError(status, text) {
  let msg = ''
  let kind = ''
  try {
    const j = JSON.parse(text)
    const e = j.error || j
    // the explanation, not the headline: a gateway's generic "Provider returned error" hides the
    // upstream's own sentence in error.metadata.raw, and that sentence is the actionable part
    msg = upstreamDetail(e).message
    kind = (e.type || e.code || '') + ''
    if (!msg) msg = JSON.stringify(e).slice(0, 300)
  } catch {
    msg = (text || '').slice(0, 300)
  }
  if (looksLikeHtml(text)) {
    msg = 'The server returned an HTML page, not JSON. The base URL is likely wrong (a duplicated /v1 is the usual cause).'
  }
  return { status, kind, message: msg || `HTTP ${status}` }
}

const PROTOCOL_HINTS =
  /ModelProtocolUnsupported|does not support this protocol|not supported for format|cannot find any route/i
const REASONING_HINTS = /reasoning_effort|disabling thinking|thinking-only|reasoning|thinking/i
// a model/route that will not accept tool definitions at all
const TOOL_HINTS = /tool_calls|tool_choice|"tools"|tools are not supported|tool.*not supported|'function' is|invalid_parameter_error.*(tool|function)/i

const { chatToolDefs, responsesToolDefs, executeTool, ALL_TOOLS, REGISTRY } = require('./tools.cjs')
// MCP servers, spoken to directly. See ./mcp.cjs for why this is hand-rolled.
const mcp = require('./mcp.cjs')

// Stored conversation -> API payload lives in its own file, so its rules — above all "an
// assistant turn never carries an image" — can be tested directly instead of assumed.
const { toChatMessages, toResponsesInput } = require('./messages.cjs')
// a generic provider error is not an explanation — see errors.cjs
const { upstreamDetail, embeddedError } = require('./errors.cjs')
const { pickWorkspace, sessionSummary } = require('./agent-session.cjs')

// Pictures are a tool, not a mode: the model reaches for it as soon as the user
// asks to see something. Saying so up front is what turns "show me what that
// would look like" into a call instead of a paragraph of description.
const IMAGE_TOOL_NOTE =
  'You can create pictures with the generate_image tool. Whenever the user asks to see something — ' +
  '"create an image of …", "draw …", "make a picture / logo / poster of …", "show me how it would look", ' +
  '"what would X look like" — call generate_image with a detailed visual prompt instead of describing ' +
  'the scene in words. The picture appears in the conversation itself.'

/**
 * What the model can do beyond talking.
 *
 * Being *offered* a tool is not the same as believing you have it. With create_document advertised but
 * never mentioned, the model answered "I can't see an attached file" and described the spreadsheet it
 * would make instead of making one — and no tool row appeared at all, which is how it was caught. Say
 * plainly what it can do, and for the app tools say that acting is expected rather than explaining.
 */
const CREATE_TOOL_NOTE =
  'You can make files for the user and save them: spreadsheets (.xlsx), Word documents (.docx), PDFs, ' +
  'CSVs, markdown, plain text and JSON. When they ask for a file, a report, a table, a list, an export ' +
  'or anything to be saved or downloaded, call create_document with the contents. Do not describe the ' +
  'file, and never say you cannot make one — make it. When it succeeds, tell them where it went.'

const APPS_TOOL_NOTE =
  'The user has connected their own accounts (Gmail, Calendar, Slack, Drive and others). You can see ' +
  'which are connected with list_connected_apps, look up what an app can do with search_app_tools, and ' +
  'act with run_app_tool — sending, creating and posting in their real accounts. When they ask for ' +
  'something one of those apps does, do it rather than explaining how they could.'

// The picture rules — what a conversation contains, and which picture the image tool may be
// pointed at — live in ./pictures.cjs so they can be tested directly. main supplies the one thing
// that file cannot have: a way to read a drawn picture back off disk.
const pictures = require('./pictures.cjs')
const files = require('./files.cjs')
const documents = require('./documents.cjs')
const composio = require('./composio.cjs')
const createDoc = require('./create.cjs')

/**
 * The pictures the image tool may be pointed at. The model only ever *names* one ("last"), and main
 * resolves it here — so a model with no vision can still change a picture it cannot see, and a
 * model can never invent an image out of nowhere.
 *
 * A drawn picture is kept on disk with its URL stripped out of the store, so this reads the file
 * back rather than trusting the message to carry the bytes.
 */
function referencesFor(messages) {
  return pictures.referencesFor(messages, fileToDataUrl)
}

/**
 * What pictures exist in this conversation, said out loud to the model. Without this, "add a hat
 * to it" reads as a request to draw something new — which is exactly how a generated picture got
 * recreated from scratch instead of edited.
 */
function pictureNote(messages) {
  return pictures.pictureNote(messages)
}

/* ---------------------------------------------------------------- request */

// toChatMessages lives in ./messages.cjs — see the note there about images on assistant turns.

function buildChatBody(cfg, messages, withReasoning, systemPrompt, tools = {}) {
  const body = {
    model: cfg.model,
    messages: toChatMessages(messages, systemPrompt, visionFor(cfg)),
    stream: cfg.stream !== false,
  }
  // reasoning models consume max_tokens silently on hidden thinking, so keep a floor
  body.max_tokens = Math.max(Number(cfg.maxTokens) || 0, 2048)
  if (cfg.temperature !== null && cfg.temperature !== undefined && Number(cfg.temperature) !== 1) {
    body.temperature = Number(cfg.temperature)
  }
  if (withReasoning) {
    // Thinking ON: ask for it explicitly on models that support the knob.
    body.reasoning_effort = cfg.thinking ? 'medium' : 'none'
  }
  if (tools.client) {
    // tools.mcp carries the tools discovered on MCP servers this turn, so they sit in the same flat
    // list as the app's own. They are passed in, never read from a module-level constant: a list
    // captured at load would never see a tool that arrived after a server started.
    const defs = chatToolDefs(cfg, tools.mcp)
    if (defs.length) {
      body.tools = defs
      body.tool_choice = 'auto'
    }
  }
  return body
}

// toResponsesInput lives in ./messages.cjs — same rules as the chat mapping above.

function buildResponsesBody(cfg, messages, systemPrompt, tools = {}) {
  const body = {
    model: cfg.model,
    input: toResponsesInput(messages, visionFor(cfg)),
    stream: cfg.stream !== false,
    max_output_tokens: Number(cfg.maxTokens) || 4096,
  }
  if (systemPrompt) body.instructions = systemPrompt
  if (cfg.temperature !== null && cfg.temperature !== undefined && Number(cfg.temperature) !== 1) {
    body.temperature = Number(cfg.temperature)
  }
  if (cfg.thinking === false) body.reasoning = { effort: 'none' }

  let defs = tools.client ? responsesToolDefs(cfg, tools.mcp) : []
  if (tools.server) {
    // the relay's built-in search tool is ALSO called web_search, and duplicate
    // tool names are a hard 400 on this API. Native search beats our function,
    // so ours is dropped whenever the server-side one is on.
    defs = defs.filter((t) => t.name !== 'web_search')
    defs.push({ type: 'web_search' })
  }
  if (defs.length) body.tools = defs
  return body
}

function endpointFor(base, protocol) {
  return protocol === 'responses' ? `${base}/responses` : `${base}/chat/completions`
}

/* ------------------------------------------------------------------- SSE */

function makeSSEParser(onEvent) {
  let buf = ''
  return (chunk) => {
    buf += chunk
    // tolerate both \n\n and \r\n\r\n framings
    let idx
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '')
      let event = ''
      const datas = []
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) datas.push(line.slice(5).trim())
      }
      if (!datas.length) continue
      const data = datas.join('\n')
      if (data === '[DONE]') return onEvent({ kind: 'done' })
      onEvent({ kind: 'data', event, data })
    }
  }
}

function consumeChunk(protocol, payload, out) {
  if (protocol === 'responses') {
    const type = payload.type || ''
    if (type === 'response.output_text.delta' && payload.delta) out.onText(payload.delta)
    else if (type === 'response.reasoning_summary_text.delta' && payload.delta) out.onReasoning(payload.delta)
    else if (type === 'response.reasoning_text.delta' && payload.delta) out.onReasoning(payload.delta)
    else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      // function_call items and the relay's server-side web_search_call items arrive here
      if (payload.item) out.onItem(payload.item)
    } else if (type === 'response.function_call_arguments.delta' && payload.delta) {
      out.onArgsDelta(payload.item_id || payload.call_id, payload.delta)
    } else if (type === 'response.output_text.annotation.added' && payload.annotation) {
      out.onAnnotation?.(payload.annotation)
    } else if (type === 'response.completed' && payload.response) {
      for (const item of payload.response.output || []) out.onItem(item)
      out.onUsage(normalizeUsage(payload.response.usage))
      out.onFinish(payload.response.status)
    } else if (type === 'response.incomplete' && payload.response) {
      out.onUsage(normalizeUsage(payload.response.usage))
      out.onFinish('length')
    } else if (type === 'response.failed' || type === 'error') {
      const e = payload.response?.error || payload.error || payload
      out.onError(e.message || 'The model reported an error mid-stream.')
    }
    return
  }
  // chat completions
  // an error can arrive as a stream event rather than as an HTTP status, which is what OpenRouter
  // does when the upstream fails after the stream has already opened
  if (payload.error && !payload.choices) {
    out.onError(upstreamDetail(payload.error).message || 'the provider reported an error mid-stream')
    return
  }
  const choice = payload.choices?.[0]
  if (payload.usage) out.onUsage(normalizeUsage(payload.usage))
  if (!choice) return
  const d = choice.delta || choice.message || {}
  const think = d.reasoning_content || d.reasoning || d.thinking
  if (think) out.onReasoning(String(think))
  if (d.content) out.onText(d.content)
  if (Array.isArray(d.tool_calls) && d.tool_calls.length) out.onChatToolDeltas(d.tool_calls)
  if (choice.finish_reason) out.onFinish(choice.finish_reason)
}

function normalizeUsage(u) {
  if (!u) return null
  return {
    prompt: u.prompt_tokens ?? u.input_tokens ?? 0,
    completion: u.completion_tokens ?? u.output_tokens ?? 0,
    total: u.total_tokens ?? 0,
    reasoning: u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens ?? 0,
  }
}

/* ---------------------------------------------------------------- streaming */

/**
 * Whether a model can be sent pictures.
 *
 * 'unknown' must not be treated as a yes. A model that cannot read pictures rejects the request,
 * and because the picture stays in the conversation history, every later message in that
 * conversation fails the same way — which is exactly how one attached picture kills a chat.
 * What is learned here is kept in memory as well as in the store, so a stale renderer copy of
 * the settings cannot undo it mid-session.
 */
const learnedVision = new Map()

function visionFor (cfg) {
  return learnedVision.get(cfg.model) || cfg.modelPrefs?.[cfg.model]?.vision || 'unknown'
}

/** the same settings, with this model marked as unable to read pictures */
function blindConfig (cfg) {
  return {
    ...cfg,
    modelPrefs: {
      ...(cfg.modelPrefs || {}),
      [cfg.model]: { ...((cfg.modelPrefs || {})[cfg.model] || {}), vision: 'no' },
    },
  }
}

function rememberVision (model, vision) {
  learnedVision.set(model, vision)
  try {
    const store = readStore()
    const prefs = { ...(store.config.modelPrefs || {}) }
    if ((prefs[model] || {}).vision === vision) return
    prefs[model] = { ...(prefs[model] || {}), vision }
    writeStore({ ...store, config: { ...store.config, modelPrefs: prefs } })
  } catch {
    // remembering is a nicety: a turn must never fail because it could not be written down
  }
}

async function openStream({ protocol, base, cfg, messages, systemPrompt, withReasoning, signal, tools = {}, notify }) {
  const url = endpointFor(base, protocol)
  const build = (config) =>
    protocol === 'responses'
      ? buildResponsesBody(config, messages, systemPrompt, tools)
      : buildChatBody(config, messages, withReasoning, systemPrompt, tools)
  const post = (payload) =>
    fetch(url, {
      method: 'POST',
      headers: headersFor(cfg, cfg.stream !== false ? 'text/event-stream' : 'application/json'),
      body: JSON.stringify(payload),
      signal,
    })

  const vision = visionFor(cfg)
  const body = build(cfg)
  const carriedPictures = JSON.stringify(body).includes('"image_url"') || JSON.stringify(body).includes('"input_image"')

  let res = await post(body)
  if (!res.ok) {
    const text = await res.text().catch(() => '')

    // A model that cannot read pictures fails the whole conversation, not just the turn that
    // carried one. So when a model not confirmed as able to read them rejects a request that
    // carried a picture, the request is made again with the picture described in words, and the
    // model is remembered as text-only rather than being asked again next time.
    if (carriedPictures && vision !== 'no' && [400, 413, 422].includes(res.status)) {
      const blind = await post(build(blindConfig(cfg)))
      if (blind.ok) {
        if (vision === 'unknown') {
          rememberVision(cfg.model, 'no')
          notify?.(
            `${cfg.model} could not take the picture, so it answered without it. This model is now remembered as text-only — attach the picture to a model that reads images, or ask for an edit.`
          )
        }
        return { ok: true, res: blind }
      }
    }
    return { ok: false, err: extractError(res.status, text) }
  }

  // a request that carried a picture and came back fine settles the question the other way
  if (carriedPictures && vision === 'unknown') rememberVision(cfg.model, 'yes')
  return { ok: true, res }
}

function readPlainResponse(protocol, json, out) {
  if (protocol === 'responses') {
    for (const item of json.output || []) {
      if (item.type === 'message') {
        for (const c of item.content || []) if (c.type === 'output_text' && c.text) out.onText(c.text)
      }
      if (item.type === 'reasoning') {
        for (const s of item.summary || []) if (s.text) out.onReasoning(s.text)
      }
      if (item.type === 'web_search_call' || item.type === 'function_call') out.onItem(item)
    }
    out.onUsage(normalizeUsage(json.usage))
    out.onFinish(json.status)
    return
  }
  const msg = json.choices?.[0]?.message
  if (msg?.reasoning_content) out.onReasoning(msg.reasoning_content)
  if (msg?.content) out.onText(msg.content)
  if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length) out.onChatToolDeltas(msg.tool_calls)
  out.onUsage(normalizeUsage(json.usage))
  out.onFinish(json.choices?.[0]?.finish_reason)
}

/* --------------------------------------------------- tool-call accumulator */

/**
 * Tool calls arrive in pieces: chat/completions streams one argument fragment per
 * delta keyed by index, while the Responses API emits function_call items plus
 * argument deltas keyed by item id. Both are funnelled here and reassembled.
 */
function makeToolAccumulator() {
  const map = new Map()
  const order = []
  const ensure = (key) => {
    if (!map.has(key)) {
      const entry = { id: '', name: '', args: '' }
      map.set(key, entry)
      order.push(key)
    }
    return map.get(key)
  }
  return {
    chatDeltas(list) {
      for (const d of list || []) {
        const e = ensure(`idx:${d.index ?? 0}`)
        if (d.id) e.id = d.id
        const f = d.function || {}
        if (f.name) e.name = f.name
        if (f.arguments) e.args += f.arguments
      }
    },
    item(it) {
      if (!it || it.type !== 'function_call') return
      const e = ensure(`id:${it.id || it.call_id || it.name}`)
      if (it.call_id) e.id = it.call_id
      if (it.name) e.name = it.name
      // the completed item carries the whole argument string — prefer it
      if (it.arguments) e.args = it.arguments
    },
    argsDelta(id, frag) {
      if (!frag) return
      ensure(`id:${id}`).args += frag
    },
    calls() {
      return order
        .map((k) => map.get(k))
        .filter((e) => e.name)
        .map((e, i) => ({
          id: e.id || `call_${e.name}_${i}_${Math.random().toString(36).slice(2, 8)}`,
          name: e.name,
          arguments: e.args && e.args.trim() ? e.args : '{}',
        }))
    },
  }
}

/* ----------------------------------------------------------- one API round */

async function runRound({ protocol, base, cfg, messages, systemPrompt, send, ac, tools }) {
  let withReasoning = true
  let lastErr = null

  for (let r = 0; r < 2; r++) {
    if (ac.signal.aborted) break
    const opened = await openStream({ protocol, base, cfg, messages, systemPrompt, withReasoning, signal: ac.signal, tools, notify: (value) => send({ type: 'notice', value }) })

    if (!opened.ok) {
      lastErr = opened.err
      const blob = `${opened.err.kind} ${opened.err.message}`
      if (withReasoning && REASONING_HINTS.test(blob)) {
        withReasoning = false
        continue // retry same protocol without reasoning_effort
      }
      return { ok: false, err: opened.err }
    }

    send({ type: 'meta', value: { protocol, model: cfg.model } })

    const acc = makeToolAccumulator()
    const sources = []
    const searches = []
    let text = ''
    let streamError = null

    const collectSearch = (it) => {
      const q = it.action?.query || ''
      const srcs = (it.action?.sources || []).filter((s) => s && s.url)
      if (q) searches.push(q)
      for (const s of srcs) {
        if (!sources.some((x) => x.url === s.url)) sources.push({ title: s.title || s.url, url: s.url })
      }
    }

    // the relay cites its own server-side search results as url_citation annotations
    const collectAnnotation = (an) => {
      const url = an?.url || an?.url_citation?.url
      if (!url) return
      const title = an.title || an.url_citation?.title || url
      if (!sources.some((x) => x.url === url)) sources.push({ title, url })
    }

    const collectMessage = (item) => {
      for (const part of item.content || []) {
        for (const an of part.annotations || []) collectAnnotation(an)
      }
    }

    const onItem = (it) => {
      if (!it) return
      if (it.type === 'web_search_call') return collectSearch(it)
      if (it.type === 'message') return collectMessage(it)
      acc.item(it)
    }

    const out = {
      onText: (t) => {
        text += t
        send({ type: 'text', value: t })
      },
      onReasoning: (t) => send({ type: 'reasoning', value: t }),
      onUsage: (u) => u && send({ type: 'usage', value: u }),
      onFinish: (r) => send({ type: 'finish', value: r || 'stop' }),
      onError: (m) => {
        streamError = m
      },
      onChatToolDeltas: (list) => acc.chatDeltas(list),
      onArgsDelta: (id, frag) => acc.argsDelta(id, frag),
      onAnnotation: collectAnnotation,
      onItem,
    }

    if (cfg.stream === false) {
      const json = await opened.res.json()
      // Some gateways answer 200 with an error object and no choices at all. Calling that a success
      // produced an empty reply and no explanation anywhere, which is what one user saw on a
      // rate-limited free model.
      const embedded = embeddedError(json)
      if (embedded) {
        const detail = extractError(opened.res.status, JSON.stringify(json))
        send({ type: 'error', value: detail.message })
        return { ok: false, err: detail }
      }
      readPlainResponse(protocol, json, out)
      const plainCalls = acc.calls()
      if (streamError && !text.trim() && !plainCalls.length) {
        return { ok: false, err: { message: streamError, kind: 'stream_error', status: 0 } }
      }
      if (streamError) send({ type: 'error', value: streamError })
      return { ok: true, text, toolCalls: plainCalls, sources, searches }
    }

    const reader = opened.res.body.getReader()
    const decoder = new TextDecoder()
    let sawAny = false
    const parser = makeSSEParser((ev) => {
      if (ev.kind === 'done') return
      let json
      try {
        json = JSON.parse(ev.data)
      } catch {
        return
      }
      sawAny = true
      consumeChunk(protocol, json, out)
    })

    // idle watchdog: a dead stream must not hang the UI forever
    let idle = setTimeout(() => ac.abort(), 180000)
    const bump = () => {
      clearTimeout(idle)
      idle = setTimeout(() => ac.abort(), 180000)
    }
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bump()
        parser(decoder.decode(value, { stream: true }))
      }
    } finally {
      clearTimeout(idle)
    }

    if (!sawAny) send({ type: 'error', value: 'The endpoint accepted the request but sent no stream data.' })

    const calls = acc.calls()
    // a stream that errored before producing anything is not a success — let the
    // caller try the other protocol instead of showing an empty reply
    if (streamError && !text.trim() && !calls.length) {
      return { ok: false, err: { message: streamError, kind: 'stream_error', status: 0 } }
    }
    if (streamError) send({ type: 'error', value: streamError })
    return { ok: true, text, toolCalls: calls, sources, searches }
  }

  return { ok: false, err: lastErr || { message: 'The request failed.', kind: '', status: 0 } }
}

/* --------------------------------------------------------------- IPC: chat */

// The title bar overlay is painted by the OS above our own top bar, so it cannot inherit a CSS
// variable. It has to be told, or the paper theme wears a black band across its top edge.
ipcMain.handle('theme:apply', (_e, name) => {
  const paper = name === 'paper'
  try {
    win.setTitleBarOverlay({
      color: paper ? '#f4f4f0' : '#121212',
      symbolColor: paper ? '#111111' : '#a8a8a8',
      height: 44,
    })
  } catch {
    // an older Electron or a window that is gone: the overlay simply keeps the default
  }
  return true
})

ipcMain.handle('chat:start', async (event, req) => {
  const { requestId, cfg, messages } = req
  // Attached documents are read here, before anything builds a request: the message builder is
  // synchronous and reading a 200-page PDF is not. Whatever it could not read comes back as a
  // reason the user will see, never as a silent gap.
  await documents.hydrate(messages)
  // only claim the model can draw when there is actually a key to draw with. The
  // tool stays advertised either way, so asking for a picture with no key comes
  // back as "add one in Settings → Images" rather than a description.
  const drawReady =
    cfg.toolsEnabled !== false &&
    (cfg.toolToggles || {}).generate_image !== false &&
    !!cfg.imageGen?.falKey
  // documents are named to the model whatever else is going on — that has nothing to do with
  // whether a picture can be drawn, so the note is added either way
  const docNote = documents.note(messages)
  const canTools = cfg.toolsEnabled !== false
  const toggles = cfg.toolToggles || {}
  const abilities = []
  if (canTools && toggles.create_document !== false) abilities.push(CREATE_TOOL_NOTE)
  if (canTools && cfg.apps?.enabled) abilities.push(APPS_TOOL_NOTE)
  const systemPrompt = (drawReady
    ? [String(req.systemPrompt || '').trim(), IMAGE_TOOL_NOTE, pictureNote(messages)]
        .filter(Boolean)
        .join('\n\n')
    : String(req.systemPrompt || '')
  )
    .concat(abilities.length ? `\n\n${abilities.join('\n\n')}` : '')
    .concat(docNote ? `\n\n${docNote}` : '')
    .trim()
  const send = (payload) => {
    if (!event.sender.isDestroyed()) event.sender.send('chat:event', { requestId, ...payload })
  }

  const ac = new AbortController()
  inflight.set(requestId, ac)

  let base
  try {
    base = normalizeBaseUrl(cfg.baseUrl)
  } catch (err) {
    inflight.delete(requestId)
    send({ type: 'error', value: err.message })
    send({ type: 'done' })
    return { ok: false }
  }

  const order =
    cfg.protocol === 'auto' ? ['chat', 'responses'] : [cfg.protocol, cfg.protocol === 'chat' ? 'responses' : 'chat']

  // tools: our own functions, plus the relay's own search where a model has it
  const toolsWanted = cfg.toolsEnabled !== false
  const serverSearchWanted = toolsWanted && cfg.serverSearch !== false
  const maxRounds = Math.min(Math.max(Number(cfg.maxToolRounds ?? 4), 0), 8)
  const convo = messages.map((m) => ({ ...m }))
  const allSources = []
  const note = (value) => send({ type: 'notice', value })

  // MCP servers are started here rather than at launch: only a turn that actually wants tools pays
  // for a child process, and a server that will not start is reported instead of quietly missing.
  // The turn goes ahead on the app's own tools either way.
  let mcpDefs = []
  if (toolsWanted && cfg.mcp && cfg.mcp.enabled) {
    const reports = await mcp.ensure(cfg.mcp.servers, { log: (line) => note(`[mcp] ${line}`) })
    for (const r of reports) {
      if (!r.ok) note(`MCP server "${r.name}" did not start: ${r.error}`)
    }
    mcpDefs = mcp.defs()
    if (mcpDefs.length) {
      note(`${mcpDefs.length} extra tool${mcpDefs.length === 1 ? '' : 's'} from MCP servers`)
    }
  }

  try {
    let toolsClient = toolsWanted
    let droppedTools = false

    for (let round = 0; ; round++) {
      let result = null
      let lastErr = null

      for (let i = 0; i < order.length; i++) {
        const protocol = order[i]
        const rr = await runRound({
          protocol,
          base,
          cfg,
          messages: convo,
          systemPrompt,
          send,
          ac,
          tools: { client: toolsClient, server: serverSearchWanted && protocol === 'responses', mcp: mcpDefs },
        })
        if (ac.signal.aborted) break

        if (rr.ok) {
          result = rr
          break
        }

        lastErr = rr.err
        const blob = `${rr.err.kind} ${rr.err.message}`

        // a model that refuses tool definitions still deserves an answer
        if (!droppedTools && toolsClient && TOOL_HINTS.test(blob)) {
          droppedTools = true
          toolsClient = false
          note('This model would not accept tools — retried without them.')
          i -= 1
          continue
        }
        if (PROTOCOL_HINTS.test(blob) && order[i + 1]) {
          send({
            type: 'meta',
            value: {
              protocol: order[i + 1],
              model: cfg.model,
              note: `Used the ${order[i + 1] === 'chat' ? 'Chat Completions' : 'Responses'} protocol instead`,
            },
          })
          continue
        }
        send({ type: 'error', value: rr.err.message, status: rr.err.status })
        send({ type: 'done' })
        return { ok: false }
      }

      if (ac.signal.aborted) {
        send({ type: 'done' })
        return { ok: true }
      }
      if (!result) {
        if (lastErr) send({ type: 'error', value: lastErr.message, status: lastErr.status })
        send({ type: 'done' })
        return { ok: false }
      }

      // the relay may have run its own server-side search — show those sources
      for (const s of result.sources || []) {
        if (!allSources.some((x) => x.url === s.url)) allSources.push(s)
      }
      for (const q of result.searches || []) {
        send({
          type: 'tool',
          value: {
            phase: 'done',
            id: `server-${q}`,
            name: 'web_search',
            server: true,
            query: q,
            sources: result.sources || [],
          },
        })
      }

      const calls = result.toolCalls || []
      if (!calls.length) {
        if (allSources.length) send({ type: 'sources', value: allSources })
        send({ type: 'done' })
        return { ok: true }
      }
      if (round >= maxRounds) {
        note(`Stopped after ${maxRounds} tool round${maxRounds === 1 ? '' : 's'}.`)
        if (allSources.length) send({ type: 'sources', value: allSources })
        send({ type: 'done' })
        return { ok: true }
      }

      // record what the model asked for, then actually run it
      convo.push({ role: 'assistant', content: result.text || '', tool_calls: calls })

      for (const tc of calls) {
        if (ac.signal.aborted) break
        const meta = REGISTRY[tc.name] || {}
        let args = {}
        try {
          args = tc.arguments && tc.arguments.trim() ? JSON.parse(tc.arguments) : {}
        } catch {
          args = { _raw: tc.arguments }
        }
        send({
          type: 'tool',
          value: { phase: 'start', id: tc.id, name: tc.name, label: meta.label || tc.name, args },
        })

        const r = await executeTool(tc.name, tc.arguments, {
          searchUrl: cfg.searchUrl,
          signal: ac.signal,
          // A tool discovered on an MCP server runs over the protocol, through here: the page never
          // touches a child process, and a dead server returns a failed tool result rather than
          // hanging the turn.
          mcp: { call: (n, a) => mcp.callTool(n, a) },
          // a picture is drawn here, in main: the key stays out of the renderer
          images: {
            key: cfg.imageGen?.falKey || '',
            model: cfg.imageGen?.model || '',
            // an edit runs on the edit endpoint: the models that follow an instruction and keep
            // the picture, instead of re-drawing from the words alone
            editModel: cfg.imageGen?.editModel || '',
            // the shape the user picked, so a picture the model draws comes out the same as one the
            // Image switch would have made
            size: cfg.imageGen?.size || '',
            // the pictures that are actually in this conversation, so the model can name one it
            // cannot see ("last") and still get exactly that picture changed
            references: referencesFor(messages),
            imagesDir: imagesDir(),
            // The Image switch's own runner, so a picture the model asks for behaves identically:
            // the reference is validated and shrunk, the window stays awake for the run, and the
            // phases arrive the same way. Without this the tool drew through a second, weaker path.
            generate: (a) =>
              runImageJob({
                key: cfg.imageGen?.falKey || '',
                model: a.model,
                prompt: a.prompt,
                count: a.count,
                size: a.size,
                imageUrl: a.imageUrl,
                imagesDir: imagesDir(),
                // same progress, same place: the renderer shows the animated row for both doors.
                // `editing` tells it which wording — a change to a picture that exists, or a fresh draw.
                onProgress: (p) =>
                  send({ type: 'image', value: { id: tc.id, editing: !!a.imageUrl, ...p } }),
              }),
            onProgress: (p) => send({ type: 'image', value: { id: tc.id, ...p } }),
          },
          // Connected apps, off unless the user turned them on. The client is built here so the
          // Composio key never leaves main and the tools cannot see it.
          apps: {
            enabled: !!(cfg.apps && cfg.apps.enabled),
            client:
              cfg.apps && cfg.apps.enabled && cfg.apps.apiKey
                ? composio.makeClient({ apiKey: cfg.apps.apiKey, userId: cfg.apps.userId })
                : null,
          },
          // Making documents. The folder is decided here — the model only ever supplies a name, so
          // it cannot write anywhere but the app's own folder.
          docs: {
            create: (a) => createDoc.create(a, { dir: documentsDir() }),
          },
        })
        for (const s of r.sources || []) {
          if (!allSources.some((x) => x.url === s.url)) allSources.push(s)
        }
        send({
          type: 'tool',
          value: {
            phase: 'done',
            id: tc.id,
            name: tc.name,
            label: meta.label || tc.name,
            ok: r.ok,
            error: r.error || null,
            sources: r.sources || [],
            // attachments the renderer hangs on the reply
            images: r.images || [],
            // and files it made — a spreadsheet or a document the user asked for
            files: r.files || [],
            preview: String(r.ok ? r.text : r.error || '')
              .replace(/\s+/g, ' ')
              .slice(0, 300),
          },
        })
        convo.push({
          role: 'tool',
          id: tc.id,
          name: tc.name,
          content: r.ok ? r.text : `The tool failed: ${r.error}`,
        })
      }
      if (allSources.length) send({ type: 'sources', value: allSources })
    }
  } catch (err) {
    const aborted = ac.signal.aborted
    if (!aborted) {
      const m = /fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(String(err.message))
        ? `Could not reach ${base}. Check the base URL and that the machine is online.`
        : err.message
      send({ type: 'error', value: m })
    }
    send({ type: 'done' })
    return { ok: aborted }
  } finally {
    inflight.delete(requestId)
  }
})

ipcMain.handle('chat:abort', (_e, { requestId }) => {
  // Stop must stop an agent turn too: same button, same request id, different process.
  const agentTurn = activeAgentTurns.get(requestId)
  if (agentTurn) {
    agentTurn.kill()
    activeAgentTurns.delete(requestId)
    return true
  }
  const ac = inflight.get(requestId)
  if (ac) {
    ac.abort()
    inflight.delete(requestId)
    return true
  }
  return false
})

/* -------------------------------------------------------------- IPC: models */

/* ---- agent mode: Pi in the backend, installed on demand ---- */

ipcMain.handle('pi:status', () => {
  const st = pi.status(PI_ROOT())
  const cfg = readStore().config || {}
  return { ...st, pinned: pi.PI_VERSION, workspace: (cfg.agent || {}).workspace || '' }
})

ipcMain.handle('pi:install', async () => {
  if (agentInstalling) return { busy: true }
  agentInstalling = true
  try {
    const st = await pi.install(PI_ROOT(), { onProgress: p => sendToRenderer('pi:progress', p) })
    return st
  } catch (err) {
    sendToRenderer('pi:progress', { phase: 'error', message: err.message })
    return { installed: false, error: err.message }
  } finally {
    agentInstalling = false
  }
})

ipcMain.handle('pi:uninstall', () => {
  for (const h of activeAgentTurns.values()) h.kill()
  fs.rmSync(PI_ROOT(), { recursive: true, force: true })
  return pi.status(PI_ROOT())
})

ipcMain.handle('pi:pickWorkspace', async () => {
  const r = await piDialog.showOpenDialog(win, {
    title: 'Choose the folder the agent may work in',
    buttonLabel: 'Use this folder',
    properties: ['openDirectory', 'createDirectory']
  })
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
})

ipcMain.handle('pi:openWorkspace', async () => {
  const ws = (readStore().config.agent || {}).workspace
  if (!ws) return { ok: false, error: 'no workspace folder chosen yet' }
  const err = await shell.openPath(ws)
  return { ok: !err, error: err || null }
})

ipcMain.handle('pi:turn', (_e, req) => runAgentTurn(req))
// which agent sessions are running right now, so several at once are visible and stoppable
ipcMain.handle('agent:sessions', () => sessionList())

ipcMain.handle('pi:stop', (_e, { requestId }) => {
  const h = activeAgentTurns.get(requestId)
  if (!h) return { stopped: false }
  h.kill()
  return { stopped: true }
})

ipcMain.handle('models:list', async (_e, { cfg, label }) => {
  console.log(
    `[models:list] from=${label || 'unknown'} base=${cfg?.baseUrl} key=${cfg?.apiKey ? `yes(${String(cfg.apiKey).length})` : 'MISSING'}`,
  )
  let base
  try {
    base = normalizeBaseUrl(cfg.baseUrl)
  } catch (err) {
    console.log(`[models:list] bad base url: ${err.message}`)
    return { ok: false, error: err.message }
  }
  try {
    const res = await fetch(`${base}/models`, { headers: headersFor(cfg) })
    const text = await res.text()
    if (!res.ok) {
      const e = extractError(res.status, text)
      console.log(`[models:list] HTTP ${res.status} ${e.message}`)
      return { ok: false, error: e.message }
    }
    const json = JSON.parse(text)
    const list = (json.data || json.models || [])
      .map((m) => ({
        id: m.id || m.name || String(m),
        created: m.created || 0,
        ownedBy: m.owned_by || m.ownedBy || '',
        contextLength: m.context_length || m.context_window || null,
      }))
      .filter((m) => m.id)
      .sort((a, b) => a.id.localeCompare(b.id))
    console.log(`[models:list] ok, ${list.length} models`)
    return { ok: true, models: list, base }
  } catch (err) {
    return { ok: false, error: `Could not list models: ${err.message}` }
  }
})

// Cheap liveness + capability probe for one model.
ipcMain.handle('models:probe', async (_e, { cfg, model, testImage }) => {
  let base
  try {
    base = normalizeBaseUrl(cfg.baseUrl)
  } catch (err) {
    return { ok: false, error: err.message }
  }
  const probeCfg = { ...cfg, model, stream: false, maxTokens: 512 }
  const messages = [
    {
      role: 'user',
      content: testImage
        ? [{ type: 'text', text: 'Reply with exactly: OK' }, { type: 'image_url', image_url: { url: testImage } }]
        : 'Reply with exactly: OK',
    },
  ]

  const order = cfg.protocol === 'auto' ? ['chat', 'responses'] : [cfg.protocol]
  for (const protocol of order) {
    for (const withReasoning of [true, false]) {
      try {
        const opened = await openStream({ protocol, base, cfg: probeCfg, messages, systemPrompt: '', withReasoning })
        if (!opened.ok) {
          const blob = `${opened.err.kind} ${opened.err.message}`
          if (withReasoning && REASONING_HINTS.test(blob)) continue
          if (PROTOCOL_HINTS.test(blob)) break
          return { ok: false, error: opened.err.message, protocol, vision: false }
        }
        const json = await opened.res.json()
        let text = ''
        let think = false
        if (protocol === 'responses') {
          for (const item of json.output || []) {
            if (item.type === 'message') for (const c of item.content || []) if (c.text) text += c.text
            if (item.type === 'reasoning') think = true
          }
        } else {
          const m = json.choices?.[0]?.message || {}
          text = m.content || ''
          think = Boolean(m.reasoning_content)
        }
        return { ok: true, protocol, text: text.slice(0, 120), thinking: think, vision: 'unknown' }
      } catch (err) {
        return { ok: false, error: err.message, protocol }
      }
    }
  }
  return { ok: false, error: 'This model does not work with either protocol on this endpoint.', vision: false }
})

/* ------------------------------------------------------------- IPC: store */

ipcMain.handle('store:get', () => readStore())
ipcMain.handle('store:save', (_e, data) => {
  // what was learned about a model's picture support must survive a renderer save that was
  // built from a stale copy of the settings
  const config = { ...((data && data.config) || {}) }
  if (learnedVision.size) {
    const prefs = { ...(config.modelPrefs || {}) }
    for (const [model, vision] of learnedVision) prefs[model] = { ...(prefs[model] || {}), vision }
    config.modelPrefs = prefs
  }
  scheduleSave({ ...data, config })

  // a change to the window behaviour takes effect at once, without a restart
  applyAlwaysOnTop(config)
  if (autoMinimizeSecs(config) !== lastAutoMinSec) {
    lastAutoMinSec = autoMinimizeSecs(config)
    if (lastAutoMinSec > 0 && win && !win.isDestroyed() && !win.isFocused()) armAutoMinimize(config)
    else cancelAutoMinimize()
  }
  return true
})
ipcMain.handle('store:flush', (_e, data) => writeStore(data))

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  storePath: storePath(),
  platform: globalThis.process.platform,
  hotkey: hotkeyStatus.active || activeHotkey,
  hotkeyStatus,
}))

/* ------------------------------------------------------- IPC: launch & win */

ipcMain.handle('app:setHotkey', (_e, { accelerator }) => {
  const result = registerHotkey(accelerator)
  hotkeyStatus = {
    requested: accelerator || '',
    active: result.registered ? accelerator : null,
    fallback: false,
    error: result.ok ? null : result.error,
  }
  // an unregisterable-but-valid value is still remembered so the field round-trips;
  // a genuinely invalid one is rejected outright
  if (result.ok) refreshTrayMenu()
  notifyHotkeyStatus()
  return result
})

ipcMain.handle('app:getHotkey', () => ({ ...hotkeyStatus, accelerator: hotkeyStatus.active || '' }))

ipcMain.handle('app:getLoginItem', () => getLoginState())

/* -------------------------------------------------------------- IPC: tools */

/* ------------------------------------------------------------------ MCP servers */

/**
 * The Test button: connect, list the tools, disconnect. It leaves no process behind, and it proves
 * the command exists — which is the failure a user can actually fix.
 */
ipcMain.handle('mcp:test', async (_e, { server } = {}) => {
  if (!server || !String(server.name || '').trim()) return { ok: false, error: 'A server needs a name.' }
  if (!String(server.command || '').trim()) return { ok: false, error: 'A server needs a command to run.' }
  return mcp.test(server)
})

/** What is running right now, and the tools each server offers. */
ipcMain.handle('mcp:status', () => mcp.status())

/** Stop one server, or all of them, without touching the saved configuration. */
ipcMain.handle('mcp:stop', async (_e, { name } = {}) =>
  name ? { ok: await mcp.stop(String(name)) } : { ok: true, stopped: await mcp.closeAll() },
)

ipcMain.handle('tools:list', () =>
  ALL_TOOLS.map((name) => ({
    name,
    label: REGISTRY[name].label,
    describe: REGISTRY[name].describe,
  })),
)

// lets Settings prove the search backend works before a model ever needs it
ipcMain.handle('tools:probe', async (_e, { searchUrl }) => {
  const r = await executeTool('web_search', { query: 'test', limit: 2 }, { searchUrl })
  return {
    ok: r.ok,
    error: r.error || null,
    preview: String(r.text || r.error || '')
      .replace(/\s+/g, ' ')
      .slice(0, 240),
    sources: r.sources || [],
  }
})

ipcMain.handle('app:setLoginItem', (_e, { enabled }) => setStartWithWindows(enabled))

ipcMain.handle('window:hide', () => {
  hideWindow()
  return true
})

ipcMain.handle('window:resetBounds', () => {
  if (win && !win.isDestroyed()) {
    const b = defaultWindowBounds()
    win.setBounds(b)
    scheduleWindowState()
    return b
  }
  return null
})

ipcMain.handle('app:openStore', () => shell.showItemInFolder(storePath()))

/* ------------------------------------------------------------ IPC: images */
// Hosted generation via fal.ai. The key never leaves the main process. Text-to-image
// is driven by the model's own tool call; an edit is driven by the user attaching a
// reference image, with their words sent to fal as the prompt.

ipcMain.handle('images:options', () => ({ sizes: falImages.SIZE_PRESETS }))

/**
 * What the selected model charges for the selected size.
 *
 * fal's own rate for the endpoint is the answer when it has one, which covers models the public
 * catalogue says nothing about; the catalogue's sentence is the fallback, and failing both the UI
 * is told plainly that no per-image price is published rather than being handed a guess.
 */
ipcMain.handle('images:cost', async (_e, { pricing, model, width, height, count }) => {
  const n = Math.max(1, Number(count) || 1)
  const rate = await falImages.priceFor(String(model || ''), (readStore().config.imageGen || {}).falKey || '')
  const fromRate = rate ? falImages.costFromRate(rate, { width, height }) : null

  if (fromRate) {
    return {
      ok: true,
      source: 'fal pricing api',
      rate: fromRate.basis,
      perImage: fromRate.perImage,
      megapixels: fromRate.megapixels,
      text: fromRate.perImage == null ? fromRate.basis : `${falImages.formatCost(fromRate.perImage)} per image`,
      forCount: fromRate.perImage == null ? '' : falImages.formatCost(fromRate.perImage * n),
    }
  }

  const est = falImages.estimateCost(pricing, (Number(width) || 0) * (Number(height) || 0) / 1e6)
  if (!est) return { ok: false }
  return {
    ok: true,
    source: 'catalogue',
    rate: est.basis,
    perImage: est.perImage,
    megapixels: est.megapixels,
    text: `${falImages.formatCost(est.perImage)} per image`,
    forCount: falImages.formatCost(est.perImage * n),
  }
})

ipcMain.handle('images:models', async (_e, { key, categories }) =>
  falImages.listModels(String(key || ''), { categories: String(categories || '') }),
)

/**
 * What each of these endpoints charges per image, for the pickers.
 *
 * One call for a whole list: the price has to sit beside the model's own name, and asking per
 * model from the renderer would fire a request each. Rates are cached for a week, sizes matter
 * because most endpoints bill by the megapixel, and anything fal does not publish is simply left
 * out of the reply — the UI says "no published price" rather than inventing one.
 */
ipcMain.handle('images:prices', async (_e, { key, models, width, height }) => {
  const list = (Array.isArray(models) ? models : []).slice(0, 150)
  const useKey = String(key || '') || (readStore().config.imageGen || {}).falKey || ''
  const prices = {}
  await Promise.all(
    list.map(async (raw) => {
      const id = String(raw || '')
      if (!id) return
      try {
        const rate = await falImages.priceFor(id, useKey)
        if (!rate) return
        const per = falImages.costFromRate(rate, { width, height })
        if (!per) return
        prices[id] =
          per.perImage == null
            ? { text: per.basis, perImage: null }
            : { text: `${falImages.formatCost(per.perImage)} each`, perImage: per.perImage }
      } catch {
        // a model without a published price is not an error, it just has no number
      }
    }),
  )
  return { ok: true, prices }
})

/**
 * A pasted screenshot can be many megabytes, and the reference travels inline as a
 * data URI, so shrink the long edge and re-encode before it goes on the wire.
 */
function prepareReference(raw) {
  const src = String(raw || '')
  if (!src) return ''
  let img
  try {
    img = src.startsWith('data:')
      ? nativeImage.createFromDataURL(src)
      : nativeImage.createFromPath(src.replace(/^file:\/+/, ''))
  } catch {
    return ''
  }
  if (!img || img.isEmpty()) return ''
  const size = img.getSize()
  const long = Math.max(size.width, size.height)
  let out = img
  if (long > 1536) {
    const scale = 1536 / long
    out = img.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'good',
    })
  }
  let buf = out.toJPEG(92)
  if (buf.length > 4 * 1024 * 1024) {
    const s = out.getSize()
    const scale = 1024 / Math.max(s.width, s.height)
    out = out.resize({
      width: Math.max(1, Math.round(s.width * scale)),
      height: Math.max(1, Math.round(s.height * scale)),
      quality: 'good',
    })
    buf = out.toJPEG(88)
  }
  return `data:image/jpeg;base64,${buf.toString('base64')}`
}

/**
 * A picture on disk as a data URL, so the renderer can hand it straight back to fal as the
 * reference for the next edit. The store keeps paths; fal wants bytes.
 */
function fileToDataUrl (file) {
  const abs = path.resolve(String(file || ''))
  const bytes = fs.readFileSync(abs)
  const ext = path.extname(abs).toLowerCase()
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
  return `data:${mime};base64,${bytes.toString('base64')}`
}

ipcMain.handle('images:dataUrl', (_e, { path: file }) => {
  try {
    return { ok: true, url: fileToDataUrl(file) }
  } catch (err) {
    return { ok: false, error: err?.message || 'That image could not be read.' }
  }
})

/**
 * One way to make a picture, whichever door it came through.
 *
 * This used to be two implementations. The Image switch validated and shrank the reference, held
 * the window awake for the run, and streamed phases into the animated row; the model's
 * generate_image tool did none of those three — so an edit asked for in words could be sent at full
 * size or with an unreadable reference, the window could tuck itself away mid-draw, and progress
 * only ever appeared inside the tool row. Both doors now come through here.
 */
async function runImageJob({ key, model, prompt, count, size, imageUrl, imagesDir: dir, onProgress }) {
  // A reference that cannot be decoded must fail loudly. Falling back to a plain text-to-image
  // draw here would silently ignore the picture the user asked to change — which is how an edit
  // came back as an unrelated new picture.
  const reference = prepareReference(imageUrl)
  if (imageUrl && !reference) {
    return {
      ok: false,
      error:
        'That reference image could not be read, so there was nothing to edit. Attach it again as a PNG or JPEG.',
    }
  }
  // a picture being drawn counts as work: the window does not tuck itself away mid-run
  imageJobs += 1
  try {
    return await falImages.generate({
      key: String(key || ''),
      model: String(model || ''),
      prompt: String(prompt || ''),
      count: Number(count) || 1,
      size: String(size || ''),
      // absent for text-to-image, present when there was a reference to follow
      imageUrl: reference,
      imagesDir: dir,
      onProgress,
    })
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Image generation failed.' }
  } finally {
    imageJobs -= 1
  }
}

/**
 * Connected apps, from the settings pane.
 *
 * Every call builds the client from what is saved right now, so a key pasted in Settings works
 * immediately rather than after a restart. The key is read in main and never handed to the page.
 */
function appsClient() {
  const cfg = readStore().config || {}
  const a = cfg.apps || {}
  if (!a.apiKey) return null
  return composio.makeClient({ apiKey: a.apiKey, userId: a.userId })
}

const NO_APPS_KEY = {
  ok: false,
  needsKey: true,
  error: 'Add a Composio API key first — a project key starts with ak_.',
}

/**
 * Open a link in the user's real browser.
 *
 * Only http(s), decided here rather than in the page: a URL that arrived from anywhere — a model, an
 * API response, a document — must not be able to launch something local.
 */
ipcMain.handle('open:external', async (_e, { url } = {}) => {
  const u = String(url || '')
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'That is not a web address.' }
  try {
    await shell.openExternal(u)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Could not open that link.' }
  }
})

ipcMain.handle('apps:list', async (_e, { query } = {}) => {
  const c = appsClient()
  if (!c) return NO_APPS_KEY
  return c.listApps(String(query || '').trim())
})

ipcMain.handle('apps:connections', async () => {
  const c = appsClient()
  if (!c) return NO_APPS_KEY
  return c.connections()
})

ipcMain.handle('apps:connect', async (_e, { app } = {}) => {
  const c = appsClient()
  if (!c) return NO_APPS_KEY
  const r = await c.startConnection(String(app || '').trim().toLowerCase())
  // The link is opened here, in main, so the page is never handed a URL to open on its own — and if
  // opening fails the URL is still returned, so the user can copy it.
  if (r.ok && r.url) {
    try {
      shell.openExternal(r.url)
    } catch {
      /* the link goes back to the renderer either way */
    }
  }
  return r
})

ipcMain.handle('apps:status', async (_e, { id } = {}) => {
  const c = appsClient()
  if (!c) return NO_APPS_KEY
  return c.accountStatus(String(id || ''))
})

/**
 * Where documents the app makes are saved.
 *
 * One predictable folder in the user's own Documents, so "where did it go?" always has the same
 * answer, and so everything the model can write is in one place it cannot escape.
 */
function documentsDir() {
  const docs = app.getPath('documents')
  const from = path.join(docs, 'Zen Chat')
  const to = path.join(docs, 'WorkBuro')
  // carried across once, the same way the data folder was
  try {
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to)
  } catch {}
  return fs.existsSync(to) || !fs.existsSync(from) ? to : from
}

/** Only a file this app put in its own folder may be opened or revealed. */
function inDocumentsDir(p) {
  const target = path.resolve(String(p || ''))
  const base = path.resolve(documentsDir())
  return path.dirname(target) === base
}

ipcMain.handle('files:open', async (_e, { path: p } = {}) => {
  if (!inDocumentsDir(p)) return { ok: false, error: 'That file is not in the WorkBuro folder.' }
  try {
    const err = await shell.openPath(path.resolve(p))
    return err ? { ok: false, error: err } : { ok: true }
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Could not open that file.' }
  }
})

ipcMain.handle('files:reveal', async (_e, { path: p } = {}) => {
  if (!inDocumentsDir(p)) return { ok: false, error: 'That file is not in the WorkBuro folder.' }
  try {
    shell.showItemInFolder(path.resolve(p))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Could not show that file.' }
  }
})

/**
 * The ＋ button and drag-and-drop both land here.
 *
 * With `paths` (a dropped file) it reads exactly those; with none it opens the native picker, which
 * is the only way to reach a PDF or a spreadsheet — an HTML file input cannot be given one, which is
 * why only images ever made it in before. Images come back as data URLs with their size; documents
 * come back as their text, already read, plus a preview. The renderer therefore never needs to know
 * the difference, and never holds more than a few hundred characters of a document.
 */
ipcMain.handle('files:add', async (event, req = {}) => {
  let paths = Array.isArray(req.paths) ? req.paths.filter((p) => typeof p === 'string' && p.trim()) : []
  if (!paths.length) {
    const win = BrowserWindow.fromWebContents(event.sender)
    const picked = await dialog.showOpenDialog(win, {
      title: 'Attach files',
      buttonLabel: 'Attach',
      properties: ['openFile', 'multiSelections'],
      filters: files.acceptGroups(),
    })
    if (picked.canceled || !picked.filePaths.length) return { ok: true, added: [], canceled: true }
    paths = picked.filePaths
  }

  const added = []
  for (const abs of paths) {
    const name = path.basename(abs)
    let bytes = 0
    try {
      bytes = fs.statSync(abs).size
    } catch {
      added.push({ name, path: abs, kind: 'document', error: `${name} is no longer where it was.` })
      continue
    }

    if (documents.classify(name) === 'image') {
      let url = ''
      try {
        url = fileToDataUrl(abs)
      } catch {
        added.push({ name, path: abs, kind: 'image', bytes, error: `${name} could not be read as a picture.` })
        continue
      }
      const size = nativeImage.createFromPath(abs).getSize()
      added.push({ name, path: abs, kind: 'image', url, bytes, width: size.width || null, height: size.height || null })
      continue
    }

    // a document: its text is read here and now, so the UI can say how much of it there is
    const read = await documents.readDocument(abs, name)
    added.push({
      name,
      path: abs,
      kind: 'document',
      docKind: read.docKind,
      bytes,
      chars: read.ok ? read.chars : 0,
      truncated: !!read.truncated,
      preview: read.ok ? read.text.slice(0, 400) : '',
      error: read.ok ? '' : read.error,
    })
  }
  return { ok: true, added }
})

ipcMain.handle('images:generate', async (_e, req) => {
  const { key, model, prompt, count, size, requestId, imageUrl } = req || {}
  return runImageJob({
    key,
    model,
    prompt,
    count,
    size,
    imageUrl,
    imagesDir: imagesDir(),
    onProgress: (p) => sendToRenderer('images:progress', { requestId, ...p }),
  })
})

ipcMain.handle('images:saveAs', async (_e, { file }) => {
  try {
    const src = String(file || '')
    if (!src || !fs.existsSync(src)) return { ok: false, error: 'That image file is no longer on disk.' }
    const r = await dialog.showSaveDialog(win, { title: 'Save image', defaultPath: path.basename(src) })
    if (r.canceled || !r.filePath) return { ok: false, canceled: true }
    fs.copyFileSync(src, r.filePath)
    return { ok: true, path: r.filePath }
  } catch (err) {
    return { ok: false, error: err?.message || 'Could not save the image.' }
  }
})

ipcMain.handle('images:openFolder', async () => {
  try {
    fs.mkdirSync(imagesDir(), { recursive: true })
    const err = await shell.openPath(imagesDir())
    return { ok: !err, error: err || null }
  } catch (err) {
    return { ok: false, error: err?.message || 'Could not open the folder.' }
  }
})

ipcMain.handle('app:pickImages', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Attach images',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
  })
  if (r.canceled) return []
  const out = []
  for (const f of r.filePaths) {
    try {
      const buf = fs.readFileSync(f)
      const ext = path.extname(f).slice(1).toLowerCase()
      const mime = ext === 'jpg' ? 'jpeg' : ext
      if (buf.length > 12 * 1024 * 1024) continue
      out.push({ name: path.basename(f), url: `data:image/${mime};base64,${buf.toString('base64')}` })
    } catch {}
  }
  return out
})
