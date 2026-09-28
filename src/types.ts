export type Role = 'system' | 'user' | 'assistant'

export interface Attachment {
  name?: string
  url: string
}

export interface Usage {
  prompt: number
  completion: number
  total: number
  reasoning: number
}

export interface Source {
  title: string
  url: string
}

/** One tool the model asked for, and what came back. */
export interface ToolActivity {
  id: string
  name: string
  label?: string
  /** true when the relay ran its own server-side search */
  server?: boolean
  args?: Record<string, any>
  query?: string
  status: 'running' | 'done' | 'error'
  ok?: boolean
  error?: string | null
  preview?: string
  sources?: Source[]
}

export interface ChatMessage {
  id: string
  role: Role
  content: string
  images?: Attachment[]
  reasoning?: string
  model?: string
  usage?: Usage | null
  error?: string | null
  protocol?: string
  note?: string
  createdAt: number
  startedAt?: number
  elapsedMs?: number
  finished?: boolean
  streaming?: boolean
  /** tool calls made while producing this message */
  tools?: ToolActivity[]
  /** everything the answer was grounded in */
  sources?: Source[]
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned?: boolean
  messages: ChatMessage[]
}

export interface ModelInfo {
  id: string
  created?: number
  ownedBy?: string
  contextLength?: number | null
}

export interface ModelPref {
  vision?: 'yes' | 'no' | 'unknown'
  protocol?: string
  thinking?: boolean
  note?: string
}

export interface Profile {
  name: string
  baseUrl: string
  affinity: boolean
}

export interface Config {
  baseUrl: string
  apiKey: string
  model: string
  systemPrompt: string
  temperature: number
  maxTokens: number
  thinking: boolean
  stream: boolean
  showUsage: boolean
  protocol: 'auto' | 'chat' | 'responses'
  sendAffinity: boolean
  affinityId: string
  /** global summon shortcut, Electron accelerator syntax ('' = disabled) */
  hotkey: string
  startWithWindows: boolean
  /** let the model call tools (web search, page reading, weather, time) */
  toolsEnabled: boolean
  /** per-tool on/off, keyed by tool name */
  toolToggles: Record<string, boolean>
  /** use the relay's own server-side search where a model supports it */
  serverSearch: boolean
  /** how many tool round-trips before we stop and answer with what we have */
  maxToolRounds: number
  /** SearXNG-compatible JSON search endpoint */
  searchUrl: string
  profiles: Profile[]
  modelPrefs: Record<string, ModelPref>
}

export interface StoreShape {
  config: Config
  conversations: Conversation[]
  activeId: string | null
  models: ModelInfo[]
}

export interface ChatEvent {
  requestId: string
  type:
    | 'text'
    | 'reasoning'
    | 'usage'
    | 'finish'
    | 'error'
    | 'meta'
    | 'done'
    | 'tool'
    | 'sources'
    | 'notice'
  value?: any
  status?: number
}
