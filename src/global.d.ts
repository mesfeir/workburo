import type { ChatEvent, StoreShape } from './types'

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

export interface ZenApi {
  store: {
    get: () => Promise<StoreShape>
    save: (data: StoreShape) => Promise<boolean>
    flush: (data: StoreShape) => Promise<boolean>
  }
  chat: {
    start: (req: any) => Promise<{ ok: boolean }>
    abort: (requestId: string) => Promise<boolean>
    onEvent: (handler: (ev: ChatEvent) => void) => () => void
  }
  models: {
    list: (cfg: any, label?: string) => Promise<{ ok: boolean; models?: any[]; error?: string; base?: string }>
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
  }
  tools: {
    list: () => Promise<{ name: string; label: string; describe: string }[]>
    probe: (searchUrl: string) => Promise<{
      ok: boolean
      error: string | null
      preview: string
      sources: { title: string; url: string }[]
    }>
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
    openWorkspace: () => Promise<{ ok: boolean; error: string | null }>
    turn: (req: {
      requestId: string
      /** Pi keeps one session per conversation, so follow-up turns remember the last one */
      conversationId?: string
      prompt: string
      model?: string
      workspace?: string
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
