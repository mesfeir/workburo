import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PanelLeft, Settings2, TriangleAlert, X } from 'lucide-react'
import Sidebar from './components/Sidebar'
import ChatView from './components/ChatView'
import Composer from './components/Composer'
import ModelPicker from './components/ModelPicker'
import SettingsModal, { type SettingsTab } from './components/SettingsModal'
import { probeImage, readFilesAsImages, shrinkImage } from './lib/image'
import type {
  Attachment,
  ChatEvent,
  ChatMessage,
  Config,
  Conversation,
  ModelInfo,
  Source,
  StoreShape,
  ToolActivity,
} from './types'
import type { HotkeyStatus } from './global'

/**
 * How fal's progress reads in the row.
 *
 * The main process sends a label with every phase. Anything arriving without one is phrased here
 * rather than shown raw, because fal's queue reports a position — and "0" on its own, which is
 * what "next in line" looks like, told the user nothing about what was happening.
 */
function falProgressText(p: { label?: string; phase?: string; detail?: unknown }): string {
  if (p?.label) return String(p.label)
  const phase = String(p?.phase || '')
  if (phase === 'submitting') return 'Sending to fal…'
  if (phase === 'queued') return 'Waiting in the queue…'
  if (phase === 'running') return 'Generating image…'
  if (phase === 'downloading') return 'Saving the image…'
  const detail = typeof p?.detail === 'string' ? p.detail.trim() : ''
  if (detail && !/^-?[0-9]+$/.test(detail)) return detail
  return phase ? `${phase[0].toUpperCase()}${phase.slice(1)}…` : 'Generating image…'
}

const DEFAULTS: Config = {
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
  affinityId: 'zen-chat-local',
  hotkey: 'Alt+Space',
  startWithWindows: false,
  toolsEnabled: true,
  toolToggles: {},
  serverSearch: true,
  maxToolRounds: 4,
  searchUrl: 'http://localhost:8888',
  profiles: [],
  modelPrefs: {},
  // above other windows, and out of the way a delay after focus is lost
  alwaysOnTop: true,
  autoMinimizeSec: 30,
  agent: {
    workspace: '',
    enabled: false,
  },
  imageGen: {
    enabled: false,
    provider: 'fal',
    falKey: '',
    model: 'fal-ai/flux/schnell',
    count: 1,
    size: 'square_hd',
  },
}

// below this width the sidebar becomes an overlay drawer — the default window is
// small enough that a fixed 264px rail would eat most of it
const COMPACT_WIDTH = 720

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

interface StreamState {
  convId: string
  msgId: string
  text: string
  reasoning: string
  raf: number
  usage: any
  protocol?: string
  note?: string
  finish?: string
  error?: string
  startedAt: number
  tools: ToolActivity[]
  sources: Source[]
  /** pictures the model drew with the generate_image tool, mid-answer */
  genImages: Attachment[]
}

function titleFrom(text: string, images: number) {
  const t = text.trim().replace(/\s+/g, ' ')
  if (!t) return images ? 'Image chat' : 'New chat'
  return t.length > 42 ? t.slice(0, 42).trimEnd() + '…' : t
}

export default function App() {
  const [config, setConfig] = useState<Config>(DEFAULTS)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [ready, setReady] = useState(false)

  const [input, setInput] = useState('')
  const [images, setImages] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [compact, setCompact] = useState(() => window.innerWidth < COMPACT_WIDTH)
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= COMPACT_WIDTH)
  const [hotkeyNotice, setHotkeyNotice] = useState<HotkeyStatus | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [probing, setProbing] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  /** composer is aimed at the image generator instead of the chat model */
  const [imageMode, setImageMode] = useState(false)
  /** a reference image is edited at fal by default, or read by the model on request */
  const [refEdit, setRefEdit] = useState(true)
  /** which settings tab to open on, when something other than us asks for it */
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined)
  /** live image requests -> the message they will fill in */
  const genRef = useRef(new Map<string, { convId: string; msgId: string }>())

  const streams = useRef(new Map<string, StreamState>())
  const activeRequest = useRef<string | null>(null)
  const configRef = useRef(config)
  configRef.current = config

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) || null,
    [conversations, activeId],
  )

  /* ------------------------------------------------------- agent mode (Pi) */

  // Agent mode is offered only once Pi is really installed — the toggle stays greyed out
  // otherwise, rather than pretending to do something it cannot do.
  const [agentReady, setAgentReady] = useState(false)
  const agentReadyRef = useRef(false)
  const refreshAgent = useCallback(() => {
    window.zen.pi
      .status()
      .then((st) => {
        const on = Boolean(st && st.installed)
        agentReadyRef.current = on
        setAgentReady(on)
      })
      .catch(() => {
        agentReadyRef.current = false
        setAgentReady(false)
      })
  }, [])

  useEffect(() => {
    refreshAgent()
  }, [refreshAgent])

  // coming back from Settings is when a fresh install becomes available
  useEffect(() => {
    if (settingsOpen) return
    refreshAgent()
  }, [settingsOpen, refreshAgent])

  const agentMode = Boolean(config.agent?.enabled) && agentReady

  /* ---------------------------------------------------------------- load */

  useEffect(() => {
    window.zen.store.get().then((s: StoreShape) => {
      setConfig({ ...DEFAULTS, ...s.config })
      setConversations(s.conversations)
      setActiveId(s.activeId)
      setModels(s.models || [])
      setReady(true)
    })
  }, [])

  /* ---------------------------------------------------------------- save */

  useEffect(() => {
    if (!ready) return
    window.zen.store.save({ config, conversations, activeId, models })
  }, [ready, config, conversations, activeId, models])

  /* ------------------------------------------------------------- stream */

  /* ------------------------------------------------------------- models */

  // first run on a fresh profile: pull the model list so the picker isn't empty
  useEffect(() => {
    if (!ready || models.length > 0 || !config.apiKey) return
    let cancelled = false
    ;(async () => {
      const res = await window.zen.models.list(configRef.current, 'auto-load')
      console.log('[auto-load] result', JSON.stringify({ ok: res.ok, n: res.models?.length, err: res.error }))
      if (!cancelled && res.ok && res.models?.length) setModels(res.models)
    })()
    return () => {
      cancelled = true
    }
  }, [ready, models.length, config.apiKey])

  const flush = useCallback((s: StreamState) => {
    if (s.raf) return
    s.raf = requestAnimationFrame(() => {
      s.raf = 0
      setConversations((prev) =>
        prev.map((c) =>
          c.id !== s.convId
            ? c
            : {
                ...c,
                messages: c.messages.map((m) =>
                  m.id !== s.msgId
                    ? m
                    : {
                        ...m,
                        content: s.text,
                        reasoning: s.reasoning,
                        error: s.error ?? m.error,
                        tools: [...s.tools],
                        sources: [...s.sources],
                        images: s.genImages.length ? [...s.genImages] : m.images,
                      },
                ),
              },
        ),
      )
    })
  }, [])

  useEffect(() => {
    const off = window.zen.chat.onEvent((ev: ChatEvent) => {
      const s = streams.current.get(ev.requestId)
      if (!s) return

      switch (ev.type) {
        case 'text':
          s.text += ev.value
          flush(s)
          break
        case 'reasoning':
          s.reasoning += ev.value
          flush(s)
          break
        case 'usage':
          s.usage = ev.value
          break
        case 'meta':
          s.protocol = ev.value?.protocol
          s.note = ev.value?.note || s.note
          break
        case 'finish':
          s.finish = ev.value
          break
        case 'error':
          s.error = ev.value
          break
        case 'tool': {
          const v = ev.value || {}
          const at = s.tools.findIndex((t) => t.id === v.id)
          const existing = at >= 0 ? s.tools[at] : ({ id: v.id, name: v.name } as ToolActivity)
          const entry: ToolActivity = {
            ...existing,
            name: v.name || existing.name,
            label: v.label || existing.label,
            server: v.server ?? existing.server,
            status: v.ok === false ? 'error' : v.phase === 'start' ? 'running' : 'done',
            ok: v.ok,
            error: v.error ?? null,
            preview: v.preview ?? existing.preview,
            sources: v.sources ?? existing.sources,
            args: v.args ?? existing.args,
            query: v.query ?? existing.query,
          }
          if (at >= 0) s.tools[at] = entry
          else s.tools.push(entry)
          // a tool that drew something hands back finished attachments
          for (const img of v.images || []) {
            if (img?.path && !s.genImages.some((x) => x.path === img.path)) s.genImages.push(img)
          }
          flush(s)
          break
        }
        case 'image': {
          // fal reports progress while the picture is being drawn
          const v = ev.value || {}
          const at = s.tools.findIndex((t) => t.id === v.id)
          if (at >= 0) {
            s.tools[at] = { ...s.tools[at], preview: `fal · ${falProgressText(v)}` }
            flush(s)
          }
          break
        }
        case 'sources': {
          for (const src of ev.value || []) {
            if (src?.url && !s.sources.some((x) => x.url === src.url)) s.sources.push(src)
          }
          flush(s)
          break
        }
        case 'notice':
          s.note = ev.value
          break
        case 'done': {
          if (s.raf) cancelAnimationFrame(s.raf)
          streams.current.delete(ev.requestId)
          if (activeRequest.current === ev.requestId) {
            activeRequest.current = null
            setBusy(false)
          }
          const finished: Partial<ChatMessage> = {
            content: s.text,
            reasoning: s.reasoning,
            streaming: false,
            finished: true,
            error: s.error || null,
            usage: s.usage || null,
            protocol: s.protocol,
            note: s.finish === 'length' ? 'hit the token limit' : s.note,
            elapsedMs: Date.now() - s.startedAt,
            tools: [...s.tools],
            sources: [...s.sources],
            ...(s.genImages.length ? { images: [...s.genImages] } : {}),
          }
          setConversations((prev) =>
            prev.map((c) =>
              c.id !== s.convId
                ? c
                : {
                    ...c,
                    updatedAt: Date.now(),
                    messages: c.messages.map((m) => (m.id === s.msgId ? { ...m, ...finished } : m)),
                  },
            ),
          )
          break
        }
      }
    })
    return off
  }, [flush])

  /* ---------------------------------------------------------------- chat */

  const runRequest = useCallback(
    (convId: string, history: ChatMessage[]) => {
      const cfg = configRef.current
      const requestId = uid()
      const asstId = uid()

      const placeholder: ChatMessage = {
        id: asstId,
        role: 'assistant',
        content: '',
        model: cfg.model,
        streaming: true,
        createdAt: Date.now(),
      }
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId ? { ...c, messages: [...c.messages, placeholder], updatedAt: Date.now() } : c,
        ),
      )

      const state: StreamState = {
        convId,
        msgId: asstId,
        text: '',
        reasoning: '',
        raf: 0,
        usage: null,
        startedAt: Date.now(),
        tools: [],
        sources: [],
        genImages: [],
      }
      streams.current.set(requestId, state)
      activeRequest.current = requestId
      setBusy(true)

      // With agent mode on the turn goes to Pi instead, carrying the same requestId, so its
      // events land in the very same stream the chat already draws. With it off, this is
      // exactly the chat it always was: no process, nothing extra.
      const pending =
        cfg.agent?.enabled && agentReadyRef.current
          ? window.zen.pi.turn({
              requestId,
              conversationId: convId,
              prompt: history[history.length - 1]?.content || '',
              model: cfg.model,
              workspace: cfg.agent?.workspace,
            })
          : window.zen.chat.start({
              requestId,
              cfg: { ...cfg },
              systemPrompt: cfg.systemPrompt,
              messages: history.map((m) => ({
                role: m.role,
                content: m.content,
                images: (m.images || []).map((i) => i.url),
              })),
            })

      pending.catch((err: Error) => {
          const s = streams.current.get(requestId)
          if (s) {
            s.error = err.message
            streams.current.delete(requestId)
          }
          if (activeRequest.current === requestId) {
            activeRequest.current = null
            setBusy(false)
          }
          setConversations((prev) =>
            prev.map((c) =>
              c.id !== convId
                ? c
                : {
                    ...c,
                    messages: c.messages.map((m) =>
                      m.id === asstId ? { ...m, streaming: false, error: err.message } : m,
                    ),
                  },
            ),
          )
        })
    },
    [],
  )

  /**
   * After a picture is made or edited it becomes the reference for whatever is said next, so
   * "make it bigger" or "change the colours" edits that picture at fal: the user's own words go
   * straight to the image endpoint, and the chat model is never asked about a picture it may not
   * even be able to see. The thumbnail in the composer shows it is armed, and it can be removed.
   */
  const referenceLastImage = useCallback(async (made: { name?: string; path?: string }[]) => {
    const first = (made || []).find((m) => m && m.path)
    if (!first?.path) return
    const r = await window.zen.images.dataUrl(first.path)
    if (!r?.ok || !r.url) return
    setImages([{ name: first.name || 'last-image.png', url: r.url }])
    setRefEdit(true)
    setToast('That picture is now the reference — say what to change about it.')
    setTimeout(() => setToast(null), 6000)
  }, [])

  /**
   * Edit a reference image at fal: the attached image is the reference and the user's
   * own words are the prompt. No chat model is involved, so nothing gets re-described
   * and no tool call is needed — the change the user typed is what fal is asked for.
   */
  const runFalEdit = useCallback(async (convId: string, prompt: string, refUrl: string) => {
    const cfg = configRef.current
    const im = cfg.imageGen
    const model = im?.editModel || 'fal-ai/flux/dev/image-to-image'
    const asstId = uid()
    const placeholder: ChatMessage = {
      id: asstId,
      role: 'assistant',
      content: '',
      images: [],
      model,
      note: 'fal · starting',
      createdAt: Date.now(),
      streaming: false,
      finished: false,
    }

    setConversations((prev) =>
      prev.map((c) =>
        c.id !== convId
          ? c
          : { ...c, messages: [...c.messages, placeholder], updatedAt: Date.now() },
      ),
    )
    setBusy(true)

    const requestId = uid()
    genRef.current.set(requestId, { convId, msgId: asstId })

    let res
    try {
      res = await window.zen.images.generate({
        requestId,
        key: im?.falKey || '',
        model,
        prompt,
        count: 1,
        size: im?.size || '',
        imageUrl: refUrl,
      })
    } catch (err) {
      res = { ok: false, error: (err as Error)?.message || 'The edit failed.' }
    }
    genRef.current.delete(requestId)
    setBusy(false)

    // the edited picture is now the thing "it" refers to in the next message
    if (res.ok && res.images?.length) void referenceLastImage(res.images)

    setConversations((prev) =>
      prev.map((c) =>
        c.id !== convId
          ? c
          : {
              ...c,
              updatedAt: Date.now(),
              messages: c.messages.map((m) =>
                m.id !== asstId
                  ? m
                  : {
                      ...m,
                      images: res.ok
                        ? (res.images || []).map((g) => ({
                            name: g.name,
                            url: g.url,
                            path: g.path,
                            width: g.width,
                            height: g.height,
                            bytes: g.bytes,
                          }))
                        : [],
                      error: res.ok ? null : res.error || 'The edit failed.',
                      note: res.ok ? `fal · ${((res.tookMs || 0) / 1000).toFixed(1)}s` : 'fal · reference',
                      finished: true,
                    },
              ),
            },
      ),
    )
  }, [])

  const send = useCallback(
    (overrideText?: string) => {
      const cfg = configRef.current
      const text = (overrideText ?? input).trim()
      const attached = overrideText ? [] : images
      if ((!text && attached.length === 0) || busy) return

      // An attached reference is an edit request: it goes to fal with the user's own
      // words. The "Ask about it" switch keeps the ordinary vision path available.
      const editing = attached.length > 0 && refEdit
      if (editing && !text) {
        setToast('Say what to change about the image — that text becomes the fal prompt.')
        setTimeout(() => setToast(null), 5000)
        return
      }
      if (editing && !cfg.imageGen?.falKey) {
        setToast('No fal.ai key saved — add one in Settings → Images to edit an image.')
        setTimeout(() => setToast(null), 5000)
        return
      }

      const userMsg: ChatMessage = {
        id: uid(),
        role: 'user',
        content: text,
        images: attached,
        createdAt: Date.now(),
      }

      let convId = activeId
      let history: ChatMessage[] = []

      if (!convId || !conversations.some((c) => c.id === convId)) {
        convId = uid()
        const conv: Conversation = {
          id: convId,
          title: titleFrom(text, attached.length),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [userMsg],
        }
        setConversations((prev) => [conv, ...prev])
        setActiveId(convId)
        history = [userMsg]
      } else {
        const cur = conversations.find((c) => c.id === convId)!
        const next = [...cur.messages, userMsg]
        history = next
        setConversations((prev) =>
          prev.map((c) =>
            c.id !== convId
              ? c
              : {
                  ...c,
                  messages: next,
                  updatedAt: Date.now(),
                  title: c.messages.length === 0 ? titleFrom(text, attached.length) : c.title,
                },
          ),
        )
      }

      setInput('')
      setImages([])

      // does the chosen model take images? warn early instead of burning a call.
      // An edit never reaches the chat model, so it is not affected either way.
      const vision = cfg.modelPrefs?.[cfg.model]?.vision
      if (attached.length > 0 && vision === 'no' && !editing) {
        setToast(`${cfg.model} is marked text-only — the image may be rejected.`)
        setTimeout(() => setToast(null), 5000)
      }

      if (editing) {
        void runFalEdit(convId, text, attached[0]?.url || '')
        return
      }

      runRequest(convId, history)
    },
    [input, images, busy, activeId, conversations, runRequest, refEdit, runFalEdit],
  )

  /* ---------------------------------------------------- image generation */

  // fal reports progress from the main process; show it on the pending message
  useEffect(() => {
    return window.zen.images.onProgress((p) => {
      const target = genRef.current.get(p.requestId)
      if (!target) return
      setConversations((prev) =>
        prev.map((c) =>
          c.id !== target.convId
            ? c
            : {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === target.msgId ? { ...m, note: `fal · ${falProgressText(p)}` } : m,
                ),
              },
        ),
      )
    })
  }, [])

  // image mode can only stay armed while a provider is switched on
  useEffect(() => {
    if (!config.imageGen?.enabled && imageMode) setImageMode(false)
  }, [config.imageGen?.enabled, imageMode])

  // the edit/ask switch belongs to the attached reference and starts on "edit"
  useEffect(() => {
    if (images.length === 0 && !refEdit) setRefEdit(true)
  }, [images.length, refEdit])

  const generateImage = useCallback(async () => {
    const cfg = configRef.current
    const im = cfg.imageGen
    const text = input.trim()
    if (!text || busy) return
    if (!im?.enabled) {
      setToast('Image generation is switched off — enable it in Settings → Images.')
      setTimeout(() => setToast(null), 5000)
      return
    }
    if (!im.falKey) {
      setToast('No fal.ai key saved — add one in Settings → Images.')
      setTimeout(() => setToast(null), 5000)
      return
    }

    const userMsg: ChatMessage = { id: uid(), role: 'user', content: text, createdAt: Date.now() }
    const asstId = uid()
    const placeholder: ChatMessage = {
      id: asstId,
      role: 'assistant',
      content: '',
      images: [],
      model: im.model,
      note: 'fal · starting',
      createdAt: Date.now(),
      streaming: false,
      finished: false,
    }

    let convId = activeId
    if (!convId || !conversations.some((c) => c.id === convId)) {
      convId = uid()
      const conv: Conversation = {
        id: convId,
        title: titleFrom(text, 0),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [userMsg, placeholder],
      }
      setConversations((prev) => [conv, ...prev])
      setActiveId(convId)
    } else {
      setConversations((prev) =>
        prev.map((c) =>
          c.id !== convId
            ? c
            : { ...c, messages: [...c.messages, userMsg, placeholder], updatedAt: Date.now() },
        ),
      )
    }
    setInput('')
    setBusy(true)

    const requestId = uid()
    genRef.current.set(requestId, { convId, msgId: asstId })

    const res = await window.zen.images.generate({
      requestId,
      key: im.falKey || '',
      model: im.model || '',
      prompt: text,
      count: Number(im.count) || 1,
      size: im.size || '',
    })
    genRef.current.delete(requestId)
    setBusy(false)

    // a freshly made picture is now the thing "it" refers to in the next message
    if (res.ok && res.images?.length) void referenceLastImage(res.images)

    setConversations((prev) =>
      prev.map((c) =>
        c.id !== convId
          ? c
          : {
              ...c,
              updatedAt: Date.now(),
              messages: c.messages.map((m) =>
                m.id !== asstId
                  ? m
                  : {
                      ...m,
                      images: res.ok
                        ? (res.images || []).map((g) => ({
                            name: g.name,
                            url: g.url,
                            path: g.path,
                            width: g.width,
                            height: g.height,
                            bytes: g.bytes,
                          }))
                        : [],
                      error: res.ok ? null : res.error || 'Image generation failed.',
                      note: res.ok ? `fal · ${((res.tookMs || 0) / 1000).toFixed(1)}s` : 'fal',
                      finished: true,
                    },
              ),
            },
      ),
    )
  }, [input, busy, activeId, conversations, referenceLastImage])

  // the composer's send goes to whichever mode is armed
  const submit = useCallback(() => {
    if (imageMode) void generateImage()
    else send()
  }, [imageMode, generateImage, send])

  const regenerate = useCallback(
    (messageId: string) => {
      if (!active || busy) return
      const idx = active.messages.findIndex((m) => m.id === messageId)
      if (idx < 0) return
      const history = active.messages.slice(0, idx)
      if (history.length === 0) return
      setConversations((prev) =>
        prev.map((c) =>
          c.id !== active.id ? c : { ...c, messages: c.messages.slice(0, idx) },
        ),
      )
      runRequest(active.id, history)
    },
    [active, busy, runRequest],
  )

  const stop = useCallback(() => {
    const id = activeRequest.current
    if (id) window.zen.chat.abort(id)
  }, [])

  /* ------------------------------------------------------- window sizing */

  // the default window is small, so the sidebar collapses to a drawer and
  // springs back when the window is widened
  useEffect(() => {
    const onResize = () => setCompact(window.innerWidth < COMPACT_WIDTH)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const wasCompact = useRef(compact)
  useEffect(() => {
    if (wasCompact.current === compact) return
    wasCompact.current = compact
    setSidebarOpen(!compact)
  }, [compact])

  // a shortcut Windows wouldn't give us must be visible, not silent
  useEffect(() => {
    window.zen.app
      .info()
      .then((i) => {
        if (i.hotkeyStatus?.fallback) setHotkeyNotice(i.hotkeyStatus)
      })
      .catch(() => {})
    return window.zen.app.onHotkeyStatus((s) => setHotkeyNotice(s && s.fallback ? s : null))
  }, [])

  /* ---------------------------------------------------------- conv mgmt */

  const newChat = useCallback(() => {
    if (busy) stop()
    setActiveId(null)
    setInput('')
    setImages([])
    if (window.innerWidth < COMPACT_WIDTH) setSidebarOpen(false)
  }, [busy, stop])

  // tray menu actions (declared after newChat — it is a dependency)
  useEffect(() => {
    const off = window.zen.app.onMenuAction((action) => {
      if (action === 'new-chat') newChat()
      if (action === 'settings') setSettingsOpen(true)
    })
    return off
  }, [newChat])

  const removeConv = useCallback(
    (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id))
      setActiveId((cur) => (cur === id ? null : cur))
    },
    [],
  )

  const renameConv = useCallback((id: string, title: string) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)))
  }, [])

  const pinConv = useCallback((id: string) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)))
  }, [])

  /* ------------------------------------------------------------- models */

  const refreshModels = useCallback(async () => {
    const cfg = configRef.current
    setToast('Loading models…')
    const res = await window.zen.models.list(cfg)
    if (res.ok) {
      setModels(res.models || [])
      setToast(`${res.models?.length || 0} models`)
    } else {
      setToast(res.error || 'Could not load models')
    }
    setTimeout(() => setToast(null), 3500)
  }, [])

  const probeModel = useCallback(async (id: string) => {
    const cfg = configRef.current
    setProbing(id)
    try {
      const textual = await window.zen.models.probe(cfg, id)
      if (!textual.ok) {
        setToast(`${id}: ${textual.error}`)
        return
      }
      const imageProbe = await window.zen.models.probe(cfg, id, probeImage())
      const vision: 'yes' | 'no' | 'unknown' = imageProbe.ok
        ? 'yes'
        : /text input|image input|image_url|does not support image|unsupported content/i.test(
              imageProbe.error || '',
            )
          ? 'no'
          : 'unknown'

      setConfig((c) => ({
        ...c,
        modelPrefs: {
          ...c.modelPrefs,
          [id]: {
            ...(c.modelPrefs?.[id] || {}),
            vision,
            protocol: textual.protocol,
            thinking: Boolean(textual.thinking),
          },
        },
      }))
      setToast(
        `${id}: ${textual.protocol}${textual.thinking ? ' · thinking' : ''} · vision ${vision}`,
      )
    } finally {
      setProbing(null)
      setTimeout(() => setToast(null), 4500)
    }
  }, [])

  /* ------------------------------------------------------------ images */

  const pickImages = useCallback(async () => {
    const picked = await window.zen.app.pickImages()
    if (!picked.length) return
    const shrunk = await Promise.all(picked.map((p) => shrinkImage(p.url).then((s) => ({ ...s, name: p.name }))))
    setImages((prev) => [...prev, ...shrunk])
  }, [])

  const addImages = useCallback((a: Attachment[]) => {
    setImages((prev) => [...prev, ...a])
  }, [])

  /* --------------------------------------------------------- shortcuts */

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey
      if (meta && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        newChat()
      } else if (meta && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setSidebarOpen((s) => !s)
      } else if (meta && e.key === ',') {
        e.preventDefault()
        setSettingsOpen(true)
      } else if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSidebarOpen(true)
      } else if (e.key === 'Escape') {
        if (compact && sidebarOpen) setSidebarOpen(false)
        else if (busy) stop()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [newChat, busy, stop, compact, sidebarOpen])

  /* ------------------------------------------------------- drag & drop */

  useEffect(() => {
    const over = (e: DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer?.types?.includes('Files')) setDragging(true)
    }
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false)
    }
    const drop = async (e: DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'))
      if (files.length) addImages(await readFilesAsImages(files))
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [addImages])

  /* ---------------------------------------------------------------- ui */

  const patchConfig = useCallback((patch: Partial<Config>) => {
    setConfig((c) => ({ ...c, ...patch }))
  }, [])

  const modelLabel = config.model || 'no model'

  return (
    <div className="flex h-full w-full overflow-hidden bg-canvas">
      {sidebarOpen && (
        <>
          {compact && (
            <div
              className="fixed inset-0 z-20 bg-black/55"
              onClick={() => setSidebarOpen(false)}
            />
          )}
          <div className={compact ? 'fixed left-0 top-0 z-30 h-full shadow-2xl' : 'relative z-10 shrink-0'}>
            <Sidebar
              conversations={conversations}
              activeId={activeId}
              config={config}
              onSelect={(id) => {
                setActiveId(id)
                setImages([])
                if (compact) setSidebarOpen(false)
              }}
              onNew={newChat}
              onDelete={removeConv}
              onRename={renameConv}
              onPin={pinConv}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenImages={() => {
                setSettingsTab('images')
                setSettingsOpen(true)
              }}
              onCollapse={() => setSidebarOpen(false)}
            />
          </div>
        </>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="drag-region titlebar-space flex h-11 shrink-0 items-center gap-1 pl-2">
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              title="Show sidebar"
              className="no-drag grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-white/10 hover:text-ink"
            >
              <PanelLeft size={16} />
            </button>
          )}
          <ModelPicker
            models={models}
            current={config.model}
            config={config}
            onSelect={(id) => patchConfig({ model: id })}
            onRefresh={refreshModels}
            onProbe={probeModel}
            probingId={probing}
            onConfigure={() => setSettingsOpen(true)}
          />
          <div className="flex-1" />
          <button
            onClick={() => setSettingsOpen(true)}
            title="Settings (Ctrl+,)"
            className="no-drag mr-1 grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-white/10 hover:text-ink"
          >
            <Settings2 size={16} />
          </button>
        </header>

        {hotkeyNotice && (
          <div
            data-hotkey-banner
            className="flex items-start gap-2 border-b border-[#4a3a1a] bg-[#241c0d] px-3 py-2 text-[12px] leading-snug text-[#e8c98a]"
          >
            <TriangleAlert size={14} className="mt-[1px] shrink-0" />
            <span className="flex-1">
              {hotkeyNotice.error}
              {hotkeyNotice.active && (
                <>
                  {' '}
                  Press <b className="font-mono text-ink">{hotkeyNotice.active}</b> to summon Zen Chat.
                </>
              )}
            </span>
            <button
              onClick={() => setSettingsOpen(true)}
              className="shrink-0 rounded-md border border-[#5a4620] px-2 py-[3px] text-[11.5px] transition hover:bg-white/[.07]"
            >
              Change
            </button>
            <button
              onClick={() => setHotkeyNotice(null)}
              title="Dismiss"
              className="shrink-0 rounded-md px-1 py-[3px] transition hover:bg-white/[.07]"
            >
              <X size={13} />
            </button>
          </div>
        )}

        <ChatView
          conversation={active}
          config={config}
          imageMode={imageMode}
          onRetry={regenerate}
          onPickSuggestion={(t) => {
            setInput(t)
          }}
        />

        <Composer
          value={input}
          onChange={setInput}
          onSend={submit}
          onStop={stop}
          images={images}
          onAddImages={addImages}
          onPickImages={pickImages}
          onRemoveImage={(i) => setImages((prev) => prev.filter((_, x) => x !== i))}
          busy={busy}
          thinking={config.thinking}
          onToggleThinking={() => patchConfig({ thinking: !config.thinking })}
          imageMode={imageMode}
          onToggleImageMode={() => setImageMode((v) => !v)}
          imageModeAvailable={Boolean(config.imageGen?.enabled)}
          refEdit={refEdit}
          onSetRefEdit={setRefEdit}
          agentMode={agentMode}
          onToggleAgent={() =>
            patchConfig({
              agent: { workspace: config.agent?.workspace || '', enabled: !config.agent?.enabled },
            })
          }
          agentAvailable={agentReady}
          agentWorkspace={config.agent?.workspace}
          modelLabel={modelLabel}
        />
      </main>

      {settingsOpen && (
        <SettingsModal
          config={config}
          models={models}
          onConfig={patchConfig}
          onModels={setModels}
          onClose={() => {
            setSettingsOpen(false)
            setSettingsTab(undefined)
          }}
          onProbe={probeModel}
          probing={probing}
          initialTab={settingsTab}
        />
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-black/60">
          <div className="rounded-2xl border border-dashed border-[#555] px-8 py-6 text-[14px] text-muted">
            Drop images to attach
          </div>
        </div>
      )}

      {toast && (
        <div className="pointer-events-none fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-[#333] bg-[#1c1c1c] px-4 py-2 text-[12.5px] text-[#dcdcdc] shadow-xl">
          {toast}
        </div>
      )}
    </div>
  )
}
