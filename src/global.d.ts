import type { ChatEvent, StoreShape } from './types'

export interface HotkeyStatus {
  requested: string
  active: string | null
  fallback: boolean
  error: string | null
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
  tools: {
    list: () => Promise<{ name: string; label: string; describe: string }[]>
    probe: (searchUrl: string) => Promise<{
      ok: boolean
      error: string | null
      preview: string
      sources: { title: string; url: string }[]
    }>
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
