export type Role = 'system' | 'user' | 'assistant'

export interface Attachment {
  name?: string
  url: string
  /** generated images are kept on disk; the renderer gets a data URL for display */
  path?: string
  width?: number | null
  height?: number | null
  bytes?: number
  /** a saved generation whose file could not be read back */
  missing?: boolean
  /** 'document' for a PDF, spreadsheet, Word file or text file; images leave this unset */
  kind?: 'image' | 'document'
  /** for a document: the reader's own name for its type (pdf, sheet, docx, text …) */
  docKind?: string
  /** for a document: how many characters its text has */
  chars?: number
  /** for a document: the text did not all fit in one request */
  truncated?: boolean
  /** for a document: the first few hundred characters, so a chip can say something useful */
  preview?: string
  /** when it could not be read, why — shown, never swallowed */
  error?: string
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

/** A file the assistant made — a spreadsheet, a document, a PDF — and where it is. */
export interface CreatedFile {
  path: string
  name: string
  kind: string
  bytes: number
  mime?: string
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
  /** a picture is being drawn right now — set by both doors, the Image switch and the tool */
  drawing?: boolean
  /** and it is a change to a picture that exists, rather than a fresh draw */
  drawingEdit?: boolean
  createdAt: number
  startedAt?: number
  elapsedMs?: number
  finished?: boolean
  streaming?: boolean
  /** tool calls made while producing this message */
  tools?: ToolActivity[]
  /** documents the user attached to this message; read in main, shown as chips here */
  documents?: Attachment[]
  /** files the assistant made — a spreadsheet, a document, a PDF — with where they are */
  files?: CreatedFile[]
  /** everything the answer was grounded in */
  sources?: Source[]
  /** how fast the answer came in, in tokens per second */
  speed?: Speed
}

export interface Speed {
  tps: number
  /** true while it is still an estimate from streamed characters, not the endpoint's own count */
  estimated?: boolean
}

export interface Conversation {
  id: string
  title: string
  /** true while the title is still the opening words, so a real summary may replace it */
  titleAuto?: boolean
  createdAt: number
  updatedAt: number
  pinned?: boolean
  /** the folder this chat's agent session works in, when it differs from the global default */
  agentWorkspace?: string
  messages: ChatMessage[]
}

/** One agent session running right now. Several can run at the same time, one per chat. */
export interface RunningSession {
  requestId: string
  conversationId: string
  title: string
  workspace: string
  model: string
  startedAt: number
  seconds: number
}

export interface ModelInfo {
  id: string
  created?: number
  ownedBy?: string
  contextLength?: number | null
  provider?: string
}

/** Models that came from one provider, shown under their own small heading in the picker. */
export interface ModelGroup {
  provider: string
  baseUrl: string
  models: ModelInfo[]
  error?: string
  /** The key this provider should be asked with, resolved when the list was fetched. */
  key?: string
  /** Whether this provider wants the affinity header, so a chosen model can carry it too. */
  affinity?: boolean
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
  /** A key for this provider alone. Without it the app's one key is tried, which is what makes a
   *  second paid provider refuse to list its models. */
  apiKey?: string
}

export interface ImageGenConfig {
  /** shows the image mode toggle in the composer */
  enabled: boolean
  provider: 'fal' | 'comfy' | 'gemini'
  /** fal.ai key — stored locally, sent only to fal.ai */
  falKey: string
  /** Google Gemini key — one key for both halves: the Gemini chat provider and the picture models.
   *  Stored locally like every other key; never sent anywhere but Google. */
  geminiKey?: string
  /** fal endpoint id, e.g. fal-ai/flux/schnell */
  model: string
  /** fal endpoint used when a message carries a reference image to edit */
  editModel?: string
  /** set when the app moved this setting for you, so Settings can say so instead of doing it silently */
  editModelMovedFrom?: string
  /** images per prompt */
  count: number
  /** size preset id, used only when the model declares image_size */
  size: string
  /** ComfyUI on the user's own machine: workflows they exported, as another way to draw */
  comfy?: ComfyConfig
}

/**
 * One workflow the user added, by file rather than by copy.
 *
 * The path is kept and the file is read on every run, so editing the workflow in ComfyUI and
 * pressing send again uses the new version. A workflow copied into the app would drift from the
 * one the user is actually working on, and the drift would be invisible.
 */
export interface ComfyWorkflow {
  id: string
  name: string
  path: string
  /** decided by the graph itself: a LoadImage means it edits a picture you give it */
  kind: 'txt2img' | 'edit'
}

export interface ComfyConfig {
  host: string
  /** 0 means "find it" — ComfyUI's own default and the Desktop build's port are both tried */
  port: number
  workflows: ComfyWorkflow[]
}

/** Agent mode: the optional hands-on engine. Off unless the user turns it on. */
export interface AgentConfig {
  /** the folder Pi may work in while agent mode is on; '' until one is chosen */
  workspace: string
  /** remembered toggle position — it can only be on once Pi is installed */
  enabled: boolean
}

/**
 * Connected apps (Composio).
 *
 * `userId` is this app's own stable name for the person: Composio ties connections to it, so it has
 * to survive restarts. Generated once, never shown.
 */
export interface AppsConfig {
  /** the master switch for the app tools; off means the model never even sees them */
  enabled: boolean
  /** Composio project key (ak_…); stored locally, sent only to Composio */
  apiKey: string
  userId: string
}

/** An MCP server the user added: a program run on this machine, spoken to over stdio. */
export interface McpServer {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  enabled?: boolean
}

export interface McpConfig {
  enabled: boolean
  servers: McpServer[]
}

/** Which palette the window wears. Dark is the default; paper is the same interface on unbleached
 *  stock. Both live in index.css as variables, so this value is the entire switch. */
export type ThemeName = 'dark' | 'paper'

/**
 * How an update is going.
 *
 * Held in the main process and mirrored into the window, because a check that finishes while nothing
 * is open must not be lost, and the About pane and the marker in the top bar have to agree.
 */
export type UpdatePhase = 'idle' | 'checking' | 'uptodate' | 'available' | 'downloading' | 'ready'

export interface UpdateChecksum {
  hasChecksum: boolean
  ok: boolean
  want: string
  got: string
}

/** What may happen once a file has been downloaded and checked. Decided in the main process. */
export interface UpdatePlan {
  action: 'run-installer' | 'open-dmg' | 'open-folder' | 'open-release' | 'none'
  why: string
}

export interface UpdateState {
  phase: UpdatePhase
  /** the version of the app that is running */
  current: string
  latest: string
  newer: boolean
  notes: string
  notesUrl: string
  asset: { name: string; url: string; size: number } | null
  error: string
  /** whether the last check was asked for, or the quiet one */
  checkedBy: 'user' | 'auto' | ''
  checkedAt: number
  progress: { received: number; total: number; percent: number }
  file: { path: string; bytes: number; sha256: string } | null
  checksum: UpdateChecksum
  plan: UpdatePlan | null
}

/**
 * The ways to search: the model provider's own search, your own SearXNG, a search API key, or the
 * reference sources on their own. Whatever is chosen falls back to the reference sources when it is
 * not available, so search is never a dead end.
 */
export type SearchMode = 'provider' | 'searxng' | 'key' | 'reference'

export interface Config {
  theme?: ThemeName
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
  /** keep the window above other windows (default true) */
  alwaysOnTop?: boolean
  /** seconds out of focus before the window minimises itself; 0 never does (default 30) */
  autoMinimizeSec?: number
  /** quietly ask GitHub for a newer release when the app starts (default true) */
  update?: { autoCheck?: boolean }
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
  /**
   * How search is answered. Every mode falls back to the reference sources when it is not
   * available, and the answer says where it came from, so none of them ends in a dead end.
   */
  searchMode?: SearchMode
  /** the key for the search API, when a key is the chosen way to search */
  searchKey?: string
  searchProvider?: 'brave' | 'tavily'
  /** fal.ai image generation (hosted; local models are not wired in yet) */
  imageGen: ImageGenConfig
  /** connected apps via Composio; off unless switched on */
  apps?: AppsConfig
  mcp?: McpConfig
  /** agent mode: Pi runs in the backend with hands, in a folder the user picks */
  agent: AgentConfig
  /** The single Gemini key, shared by chat and pictures (see ImageGenConfig.geminiKey). */
  geminiKey?: string
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
    | 'image'
  value?: any
  status?: number
}
