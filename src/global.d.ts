import type { ChatEvent, SearchMode, StoreShape } from './types'

export interface HotkeyStatus {
  requested: string
  active: string | null
  fallback: boolean
  error: string | null
}

export interface FalModel {
  id: string
  name: string
  description: string
  category: string
  status?: string
  license?: string
  thumbnail?: string
  pricing?: string
}

export interface GeneratedImage {
  path: string
  name: string
  url: string
  width: number | null
  height: number | null
  bytes: number
}

export interface ImageGenResult {
  ok: boolean
  error?: string
  status?: number
  images?: GeneratedImage[]
  model?: string
  requestId?: string
  tookMs?: number
  params?: string[]
  seed?: number | null
}

export interface ServerSettings {
  enabled: boolean
  port: number
  /** 'all' is this network; 'localhost' is this computer only. */
  bind: 'localhost' | 'all'
  key: string
}

export interface ServerRequest {
  at: number
  method: string
  path: string
  ip: string
  status: number
  ms: number
  note: string
}

export interface ServerStatus {
  running: boolean
  port: number | null
  addresses: string[]
  lan: string[]
  devices: { ip: string; at: number }[]
  refusals: number
  lastRefusal: { at: number; ip: string } | null
  agentAllowed: boolean
  keySet: boolean
  keyLength: number
  requests: ServerRequest[]
  settings: ServerSettings
  pair: { active: boolean; expiresIn: number; triesLeft: number }
  agentEnabled: boolean
}

export interface ZenApi {
  theme: {
    apply: (name: string) => Promise<boolean>
  },

  store: {
    get: () => Promise<StoreShape>
    save: (data: StoreShape) => Promise<boolean>
    flush: (data: StoreShape) => Promise<boolean>
    /* Another device wrote to the same conversations. The handler re-reads them. */
    onChanged: (handler: () => void) => () => void
  }

  /*
   * Server mode: this app serving itself to a phone or another computer. The pane asks for a status,
   * switches it on and off, and shows a pairing code. The key is never handed to the page -- only
   * whether one is set, and how long it is.
   */
  server: {
    status: () => Promise<ServerStatus>
    start: () => Promise<{ ok: boolean; error?: string; status: ServerStatus }>
    stop: () => Promise<{ ok: boolean; status: ServerStatus }>
    settings: (patch: Partial<ServerSettings>) => Promise<{ settings: ServerSettings; restartNeeded: boolean }>
    newKey: () => Promise<{ settings: ServerSettings }>
    pair: () => Promise<{ code: string; expiresAt: number; seconds: number }>
  }
  // MCP servers: status and a test. The page never touches a child process itself.
  mcp?: {
    status: () => Promise<
      {
        name: string
        key: string
        running: boolean
        era: string | null
        info: { name?: string; version?: string }
        tools: { name: string; description: string }[]
        lastOutput: string[]
      }[]
    >
    test: (server: unknown) => Promise<{
      ok: boolean
      name?: string
      era?: string
      info?: { name?: string; version?: string }
      tools?: string[]
      error?: string
    }>
    stop: (name: string) => Promise<{ ok: boolean; stopped?: number }>
  }
  chat: {
    start: (req: any) => Promise<{ ok: boolean }>
    abort: (requestId: string) => Promise<boolean>
    /**
     * One cheap non-streaming call that names a conversation from its first exchange. Never on
     * the send path: if it fails, the opening-words title stays and nothing else changes.
     */
    title: (req: {
      cfg: any
      messages: { role: string; content: string }[]
    }) => Promise<{ ok: boolean; title?: string; model?: string; protocol?: string; error?: string }>
    onEvent: (handler: (ev: ChatEvent) => void) => () => void
  }
  models: {
    list: (cfg: any, label?: string) => Promise<{ ok: boolean; models?: any[]; error?: string; base?: string }>
    all: (cfg: any) => Promise<{ ok: boolean; groups?: any[]; unavailable?: any[]; models?: any[]; count?: number }>
    probe: (cfg: any, model: string, testImage?: string) => Promise<any>
  }
  files: {
    /**
     * The ＋ button and drag-and-drop. With `paths` it reads exactly those files; with none it opens
     * the native picker. Documents come back already read (name, kind, characters, a preview);
     * images come back as data URLs with their true size.
     */
    add: (paths?: string[]) => Promise<{ ok: boolean; added: Attachment[]; canceled?: boolean }>
    /** a dropped file's path on disk — Electron 32 removed File.path */
    pathFor: (file: File) => string
    /** open a file the app made, or show it in the folder; only its own folder is allowed */
    open: (path: string) => Promise<{ ok: boolean; error?: string }>
    reveal: (path: string) => Promise<{ ok: boolean; error?: string }>
  }
  apps: {
    /** the Composio app catalogue; the key stays in main and never comes back to the page */
    list: (query?: string) => Promise<{
      ok: boolean
      apps?: { slug: string; name: string; description: string; logo: string; noAuth: boolean; tools: number }[]
      error?: string
      needsKey?: boolean
    }>
    connections: () => Promise<{
      ok: boolean
      connections?: { id: string; app: string; status: string; reason: string; active: boolean }[]
      error?: string
      needsKey?: boolean
    }>
    /** starts a connection; main opens the returned URL in the real browser */
    connect: (app: string) => Promise<{
      ok: boolean
      url?: string
      accountId?: string
      expiresAt?: string
      error?: string
      needsKey?: boolean
    }>
    status: (id: string) => Promise<{ ok: boolean; id?: string; status?: string; reason?: string; error?: string }>
  }
  /** open a web address in the user's browser; main refuses anything that is not http(s) */
  openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>
  tools: {
    list: () => Promise<{ name: string; label: string; describe: string }[]>
    probe: (asked: string | { searchUrl?: string; searchMode?: SearchMode; searchKey?: string; searchProvider?: string; query?: string }) => Promise<{
      ok: boolean
      error: string | null
      preview: string
      sources: { title: string; url: string }[]
      /** true when the answer came from the reference sources rather than a search service */
      reference: boolean
    }>
  }
  search: {
    /** is Docker here, and is its daemon awake? Two different questions on Windows. */
    docker: () => Promise<{ docker: boolean; daemon: boolean; version: string | null; error: string | null }>
    /** one click: write the settings, start the container, wait until it answers */
    install: (opts?: { port?: number }) => Promise<{
      ok: boolean
      url?: string
      port?: number
      name?: string
      results?: number
      error?: string
    }>
    onInstallProgress: (handler: (p: { phase: string; message: string }) => void) => () => void
  }
  images: {
    models: (key: string, categories?: string) => Promise<{ ok: boolean; models?: FalModel[]; total?: number; error?: string; status?: number }>
    /** what the selected model charges for the selected size, resolved in the main process */
    cost: (req: { pricing?: string; model?: string; width?: number; height?: number; count?: number }) => Promise<{
      ok: boolean
      source?: string
      rate?: string
      perImage?: number | null
      megapixels?: number
      text?: string
      forCount?: string
    }>
    options: () => Promise<{ sizes: { id: string; label: string; width: number; height: number }[] }>
    /** everything this app has generated: the files in the images folder, newest first */
    outputs: () => Promise<{
      ok: boolean
      dir: string
      files: { name: string; path: string; size: number; mtime: number; ext: string }[]
      empty?: boolean
      error?: string
    }>
    generate: (req: {
      requestId: string
      key: string
      model: string
      prompt: string
      count: number
      size: string
      /** a reference image as a data URI, which turns this into an edit */
      imageUrl?: string
    }) => Promise<ImageGenResult>
    saveAs: (file: string) => Promise<{ ok: boolean; path?: string; error?: string; canceled?: boolean }>
    /** a picture on disk as a data URL, for handing straight back to fal as a reference */
    dataUrl: (path: string) => Promise<{ ok: boolean; url?: string; error?: string }>
    /** per-image prices for a list of endpoints, for the pickers; omits the ones fal does not publish */
    prices: (
      key: string,
      models: string[],
      size?: { width?: number; height?: number },
    ) => Promise<{ ok: boolean; prices: Record<string, { text: string; perImage: number | null }> }>
    openFolder: () => Promise<{ ok: boolean; error: string | null }>
    onProgress: (handler: (p: { requestId: string; phase: string; detail?: string }) => void) => () => void
  }
  /**
   * The local model. Nothing here needs an account, and nothing downloads until it is asked for:
   * the size is known before it starts, and the runtime and the model are each checked against a
   * pinned digest before anything is run.
   */
  local: {
    status: () => Promise<{
      installed: boolean
      version: string | null
      pinned: string
      model: string
      modelPath: string | null
      modelReady: boolean
      ready: boolean
      root: string
      defaultModel: string
      catalogue: { id: string; label: string; file: string; bytes: number; size: string; note: string }[]
      running: { baseUrl: string; port: number } | null
    }>
    install: (model?: string) => Promise<{ ok?: boolean; busy?: boolean; error?: string }>
    start: (model?: string) => Promise<{
      ok: boolean
      baseUrl?: string
      port?: number
      tookMs?: number
      already?: boolean
      error?: string
    }>
    stop: () => Promise<{ ok: boolean }>
    /** LM Studio and Ollama, if either is already running on this machine */
    detect: () => Promise<{
      found: { id: string; label: string; baseUrl: string; models: string[] }[]
      tried: string[]
    }>
    open: () => Promise<string>
    onProgress: (
      handler: (p: { phase: string; got?: number; total?: number; note?: string; message?: string }) => void,
    ) => () => void
  }
  pi: {
    status: () => Promise<{
      installed: boolean
      version: string | null
      /** the release this build installs */
      pinned: string
      exe: string | null
      agentDir: string
      workspace: string
      configured?: boolean
    }>
    install: () => Promise<{ installed?: boolean; version?: string | null; busy?: boolean; error?: string }>
    uninstall: () => Promise<{ installed: boolean }>
    pickWorkspace: () => Promise<string | null>
    /** the agent sessions running right now, so several at once are visible */
    sessions: () => Promise<
      { requestId: string; conversationId: string; title: string; workspace: string; model: string; startedAt: number; seconds: number }[]
    >
    onSessions: (
      handler: (
        list: { requestId: string; conversationId: string; title: string; workspace: string; model: string; startedAt: number; seconds: number }[],
      ) => void,
    ) => () => void
    openWorkspace: () => Promise<{ ok: boolean; error: string | null }>
    turn: (req: {
      requestId: string
      /** Pi keeps one session per conversation, so follow-up turns remember the last one */
      conversationId?: string
      prompt: string
      model?: string
      workspace?: string
      /**
       * Files attached to the message. Pi runs in a folder of its own and reads files with its own
       * tools, so a document travels as the path to it; main copies one that lives outside the
       * workspace into the workspace so the agent can always open it.
       */
      documents?: { name?: string; path?: string }[]
      /**
       * Pictures attached to the message. A picked or pasted picture is a data URL and has no path
       * yet, so main writes it into the workspace and hands the agent the path it wrote.
       */
      images?: { name?: string; path?: string; url?: string }[]
    }) => Promise<{ ok: boolean; stopped?: boolean; text?: string; tools?: number; error?: string }>
    stop: (requestId: string) => Promise<{ stopped: boolean }>
    onProgress: (
      handler: (p: {
        phase: string
        pct?: number | null
        received?: number
        total?: number
        message?: string
      }) => void,
    ) => () => void
  }
  app: {
    info: () => Promise<{
      version: string
      storePath: string
      platform: string
      hotkey: string | null
      hotkeyStatus?: HotkeyStatus
    }>
    openStore: () => Promise<void>
    pickImages: () => Promise<{ name: string; url: string }[]>
    getHotkey: () => Promise<HotkeyStatus & { accelerator: string }>
    setHotkey: (accelerator: string) => Promise<{
      ok: boolean
      registered: boolean
      accelerator: string
      error?: string
    }>
    getLoginItem: () => Promise<{ openAtLogin: boolean; executableWillLaunchAtLogin: boolean }>
    setLoginItem: (enabled: boolean) => Promise<{ openAtLogin: boolean; executableWillLaunchAtLogin: boolean }>
    resetBounds: () => Promise<{ x: number; y: number; width: number; height: number } | null>
    hideWindow: () => Promise<boolean>
    onMenuAction: (handler: (action: string) => void) => () => void
    onHotkeyStatus: (handler: (status: HotkeyStatus) => void) => () => void
  }
}

declare global {
  interface Window {
    zen: ZenApi
  }
}
