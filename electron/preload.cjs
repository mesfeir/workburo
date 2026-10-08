const { contextBridge, ipcRenderer, webUtils } = require('electron')

// The title bar has to know which side the native window buttons are on before it paints, so this
// is set as early as the document allows: macOS puts them on the left, so anything at the top left
// reserves space there instead of on the right. Set twice because the element may or may not exist
// yet when a preload runs, and a missing attribute means a logo sitting under the traffic lights.
if (process.platform === 'darwin') {
  const mark = () => {
    try {
      document.documentElement?.setAttribute('data-platform', 'darwin')
    } catch {
      /* too early: the DOMContentLoaded pass will catch it */
    }
  }
  mark()
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mark)
}

/*
 * Drop a picture's bytes before the store crosses IPC.
 *
 * The window holds every picture as an inline data URL, and this call happens whenever a
 * conversation changes -- which, while a reply streams, is many times a second. Sending those bytes
 * back each time meant cloning tens of megabytes in and out of the renderer, and the profiler put
 * 14 of the 19 seconds a single reply took inside this one line. Main keeps a path for anything it
 * can find, so the bytes add nothing on the way back. A picture with no file behind it is left
 * alone: those bytes are still the only copy.
 */
function withoutPictureBytes(data) {
  if (!data || !Array.isArray(data.conversations)) return data
  let changed = false
  const conversations = data.conversations.map((c) => {
    if (!c || !Array.isArray(c.messages)) return c
    let touched = false
    const messages = c.messages.map((m) => {
      if (!m || !Array.isArray(m.images)) return m
      let hit = false
      const images = m.images.map((im) => {
        if (im && im.path && typeof im.url === 'string' && im.url.startsWith('data:')) {
          hit = true
          return { ...im, url: '' }
        }
        return im
      })
      if (!hit) return m
      touched = true
      return { ...m, images }
    })
    if (!touched) return c
    changed = true
    return { ...c, messages }
  })
  return changed ? { ...data, conversations } : data
}

// One narrow, explicit surface for the renderer. No node, no fs, no keys in the page.
contextBridge.exposeInMainWorld('zen', {
  theme: {
    apply: (name) => ipcRenderer.invoke('theme:apply', name),
  },

  store: {
    get: () => ipcRenderer.invoke('store:get'),
    save: (data) => ipcRenderer.invoke('store:save', withoutPictureBytes(data)),
    flush: (data) => ipcRenderer.invoke('store:flush', withoutPictureBytes(data)),
    /* Fired when another device -- a phone -- has written to the same conversations. */
    onChanged: (handler) => {
      const listener = () => handler()
      ipcRenderer.on('store:changed', listener)
      return () => ipcRenderer.removeListener('store:changed', listener)
    },
  },

  /*
   * Server mode: this app serving itself to a phone or to another computer. The pane asks for a
   * status, switches it on and off, and shows a pairing code. The key is never handed to the page --
   * the pane is told that a key exists and how long it is, and nothing more.
   */
  server: {
    status: () => ipcRenderer.invoke('server:status'),
    start: () => ipcRenderer.invoke('server:start'),
    stop: () => ipcRenderer.invoke('server:stop'),
    settings: (patch) => ipcRenderer.invoke('server:settings', patch),
    newKey: () => ipcRenderer.invoke('server:newkey'),
    pair: () => ipcRenderer.invoke('server:pair'),
  },
  // MCP servers: the page asks for a status and a test, and never touches a child process itself
  mcp: {
    status: () => ipcRenderer.invoke('mcp:status'),
    test: (server) => ipcRenderer.invoke('mcp:test', { server }),
    stop: (name) => ipcRenderer.invoke('mcp:stop', { name }),
  },
  chat: {
    start: (req) => ipcRenderer.invoke('chat:start', req),
    abort: (requestId) => ipcRenderer.invoke('chat:abort', { requestId }),
    title: (req) => ipcRenderer.invoke('chat:title', req),
    onEvent: (handler) => {
      const listener = (_e, payload) => handler(payload)
      ipcRenderer.on('chat:event', listener)
      return () => ipcRenderer.removeListener('chat:event', listener)
    },
  },
  models: {
    list: (cfg, label) => ipcRenderer.invoke('models:list', { cfg, label }),
    all: (cfg) => ipcRenderer.invoke('models:all', { cfg }),
    probe: (cfg, model, testImage) => ipcRenderer.invoke('models:probe', { cfg, model, testImage }),
  },
  files: {
    // the ＋ button and drag-and-drop both land here. Without paths it opens the native picker —
    // the only way to reach a PDF or a spreadsheet, which an HTML file input cannot be given.
    add: (paths) => ipcRenderer.invoke('files:add', { paths }),
    // a dropped file's path on disk. Electron 32 removed File.path, so this is the way to ask;
    // without it a dropped document has no path and nothing can read it.
    pathFor: (file) => {
      try {
        return webUtils.getPathForFile(file) || ''
      } catch {
        return ''
      }
    },
    // a file the app made: open it, or show it in the folder. Main only allows its own folder.
    open: (p) => ipcRenderer.invoke('files:open', { path: p }),
    reveal: (p) => ipcRenderer.invoke('files:reveal', { path: p }),
  },
  apps: {
    /** the Composio app catalogue; the key lives in main and never comes back here */
    list: (query) => ipcRenderer.invoke('apps:list', { query }),
    connections: () => ipcRenderer.invoke('apps:connections'),
    /** starts a connection and opens the URL Composio returned, in the real browser */
    connect: (app) => ipcRenderer.invoke('apps:connect', { app }),
    status: (id) => ipcRenderer.invoke('apps:status', { id }),
  },
  /** open a web address in the user's browser; main refuses anything that is not http(s) */
  openExternal: (url) => ipcRenderer.invoke('open:external', { url }),
  tools: {
    list: () => ipcRenderer.invoke('tools:list'),
    // takes the whole search setting so what gets tested is what is chosen; a bare url still works
    probe: (asked) =>
      ipcRenderer.invoke('tools:probe', typeof asked === 'string' ? { searchUrl: asked } : asked || {}),
  },
  search: {
    docker: () => ipcRenderer.invoke('search:docker'),
    install: (opts) => ipcRenderer.invoke('search:install', opts || {}),
    onInstallProgress: (handler) => {
      const listener = (_e, payload) => handler(payload)
      ipcRenderer.on('search:install-progress', listener)
      return () => ipcRenderer.removeListener('search:install-progress', listener)
    },
  },
  images: {
    models: (key, categories) => ipcRenderer.invoke('images:models', { key, categories }),
    prices: (key, models, size) => ipcRenderer.invoke('images:prices', { key, models, ...(size || {}) }),
    cost: (req) => ipcRenderer.invoke('images:cost', req),
    options: () => ipcRenderer.invoke('images:options'),
    generate: (req) => ipcRenderer.invoke('images:generate', req),
    dataUrl: (path) => ipcRenderer.invoke('images:dataUrl', { path }),
    saveAs: (file) => ipcRenderer.invoke('images:saveAs', { file }),
    openFolder: () => ipcRenderer.invoke('images:openFolder'),
    onProgress: (handler) => {
      const listener = (_e, payload) => handler(payload)
      ipcRenderer.on('images:progress', listener)
      return () => ipcRenderer.removeListener('images:progress', listener)
    },
  },
  /* ComfyUI on this machine: the user's own exported workflows, run by them, for them */
  comfy: {
    status: () => ipcRenderer.invoke('comfy:status'),
    workflows: () => ipcRenderer.invoke('comfy:workflows'),
    pick: () => ipcRenderer.invoke('comfy:pick'),
    check: (path) => ipcRenderer.invoke('comfy:check', { path }),
  },
  /* everything this app has made or been handed, read off disk rather than remembered */
  library: {
    files: () => ipcRenderer.invoke('library:files'),
    /* opens one of the Library's own folders; the main process refuses anything else */
    openFolder: (dir) => ipcRenderer.invoke('library:openFolder', { dir }),
  },
  /* how this app updates itself: check the releases, download, verify, then hand over or install */
  update: {
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    cancel: () => ipcRenderer.invoke('update:cancel'),
    install: () => ipcRenderer.invoke('update:install'),
    openRelease: () => ipcRenderer.invoke('update:openRelease'),
    onChanged: (handler) => {
      const listener = (_e, payload) => handler(payload)
      ipcRenderer.on('update:changed', listener)
      return () => ipcRenderer.removeListener('update:changed', listener)
    },
  },
  /* the local model: fetch it, start it, stop it. No key anywhere in this path. */
  local: {
    status: () => ipcRenderer.invoke('local:status'),
    install: (model) => ipcRenderer.invoke('local:install', { model }),
    start: (model) => ipcRenderer.invoke('local:start', { model }),
    stop: () => ipcRenderer.invoke('local:stop'),
    detect: () => ipcRenderer.invoke('local:detect'),
    open: () => ipcRenderer.invoke('local:open'),
    onProgress: (listener) => {
      ipcRenderer.on('local:progress', listener)
      return () => ipcRenderer.removeListener('local:progress', listener)
    },
  },
  pi: {
    status: () => ipcRenderer.invoke('pi:status'),
    install: () => ipcRenderer.invoke('pi:install'),
    uninstall: () => ipcRenderer.invoke('pi:uninstall'),
    pickWorkspace: () => ipcRenderer.invoke('pi:pickWorkspace'),
    openWorkspace: () => ipcRenderer.invoke('pi:openWorkspace'),
    turn: (req) => ipcRenderer.invoke('pi:turn', req),
    stop: (requestId) => ipcRenderer.invoke('pi:stop', { requestId }),
    sessions: () => ipcRenderer.invoke('agent:sessions'),
    onSessions: (listener) => {
      const wrapped = (_e, list) => listener(list)
      ipcRenderer.on('agent:sessions', wrapped)
      return () => ipcRenderer.removeListener('agent:sessions', wrapped)
    },
    onProgress: (handler) => {
      const listener = (_e, payload) => handler(payload)
      ipcRenderer.on('pi:progress', listener)
      return () => ipcRenderer.removeListener('pi:progress', listener)
    },
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    /** asked synchronously by the title bar: macOS draws its window buttons on the left, Windows on
     *  the right, and the bar has to keep clear of the correct side before the first paint. */
    platform: process.platform,
    openStore: () => ipcRenderer.invoke('app:openStore'),
    pickImages: () => ipcRenderer.invoke('app:pickImages'),
    getHotkey: () => ipcRenderer.invoke('app:getHotkey'),
    setHotkey: (accelerator) => ipcRenderer.invoke('app:setHotkey', { accelerator }),
    getLoginItem: () => ipcRenderer.invoke('app:getLoginItem'),
    setLoginItem: (enabled) => ipcRenderer.invoke('app:setLoginItem', { enabled }),
    resetBounds: () => ipcRenderer.invoke('window:resetBounds'),
    hideWindow: () => ipcRenderer.invoke('window:hide'),
    onMenuAction: (handler) => {
      const listener = (_e, action) => handler(action)
      ipcRenderer.on('ui:action', listener)
      return () => ipcRenderer.removeListener('ui:action', listener)
    },
    onHotkeyStatus: (handler) => {
      const listener = (_e, status) => handler(status)
      ipcRenderer.on('hotkey:status', listener)
      return () => ipcRenderer.removeListener('hotkey:status', listener)
    },
  },
})
