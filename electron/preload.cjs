const { contextBridge, ipcRenderer, webUtils } = require('electron')

// One narrow, explicit surface for the renderer. No node, no fs, no keys in the page.
contextBridge.exposeInMainWorld('zen', {
  store: {
    get: () => ipcRenderer.invoke('store:get'),
    save: (data) => ipcRenderer.invoke('store:save', data),
    flush: (data) => ipcRenderer.invoke('store:flush', data),
  },
  chat: {
    start: (req) => ipcRenderer.invoke('chat:start', req),
    abort: (requestId) => ipcRenderer.invoke('chat:abort', { requestId }),
    onEvent: (handler) => {
      const listener = (_e, payload) => handler(payload)
      ipcRenderer.on('chat:event', listener)
      return () => ipcRenderer.removeListener('chat:event', listener)
    },
  },
  models: {
    list: (cfg, label) => ipcRenderer.invoke('models:list', { cfg, label }),
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
    probe: (searchUrl) => ipcRenderer.invoke('tools:probe', { searchUrl }),
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
  pi: {
    status: () => ipcRenderer.invoke('pi:status'),
    install: () => ipcRenderer.invoke('pi:install'),
    uninstall: () => ipcRenderer.invoke('pi:uninstall'),
    pickWorkspace: () => ipcRenderer.invoke('pi:pickWorkspace'),
    openWorkspace: () => ipcRenderer.invoke('pi:openWorkspace'),
    turn: (req) => ipcRenderer.invoke('pi:turn', req),
    stop: (requestId) => ipcRenderer.invoke('pi:stop', { requestId }),
    onProgress: (handler) => {
      const listener = (_e, payload) => handler(payload)
      ipcRenderer.on('pi:progress', listener)
      return () => ipcRenderer.removeListener('pi:progress', listener)
    },
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
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
