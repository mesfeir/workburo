import { useEffect, useRef, useState, type ReactNode } from 'react'
import AppsPane from './AppsPane'
import McpPane from './McpPane'
import ServerPane from './ServerPane'
import UpdatePane from './UpdatePane'
import { Plus,
  Check,
  Eye,
  EyeOff,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  KeyRound,
  Minimize2,
  RefreshCw,
  HelpCircle,
  Sparkles,
  TriangleAlert,
  X,
  Zap,
} from 'lucide-react'
import type { Config, ModelInfo, StoreShape } from '../types'
import type { FalModel, HotkeyStatus } from '../global'

const INSTRUCTION_PRESETS = [
  'Keep it short.',
  'Answer directly.',
  'Be friendly.',
  'Code over prose.',
  'Ask before assuming.',
]

type Tab = 'general' | 'api' | 'chat' | 'models' | 'images' | 'apps' | 'mcp' | 'tools' | 'agent' | 'server' | 'about'

export type SettingsTab = Tab

const TAB_LABELS: Record<Tab, string> = {
  general: 'General',
  api: 'API & key',
  chat: 'Chat',
  models: 'Models',
  images: 'Images',
  apps: 'Connected apps',
  mcp: 'MCP servers',
  tools: 'Tools',
  agent: 'Agent',
  server: 'Server',
  about: 'About',
}

const MODIFIER_KEYS = ['Control', 'Alt', 'Shift', 'Meta']

const NAMED_KEYS: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Return',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
}

/** Turn a keypress into Electron accelerator syntax, or null if unusable. */
function toAccelerator(e: {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}): string | null {
  if (MODIFIER_KEYS.includes(e.key)) return null
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')

  let key = e.key
  if (e.code === 'Space' || key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toUpperCase()
  else if (/^F([1-9]|1\d|2[0-4])$/.test(key)) {
    /* keep as-is */
  } else key = NAMED_KEYS[key] || ''

  if (!key) return null
  if (mods.length === 0) return null // a bare key would hijack typing system-wide
  return [...mods, key].join('+')
}

const HOTKEY_PRESETS = ['Alt+Space', 'Ctrl+Alt+Space', 'Alt+Shift+Space', 'Ctrl+Alt+K']

function HotkeyRecorder({
  value,
  recording,
  onRecord,
  onCommit,
  onCancel,
}: {
  value: string
  recording: boolean
  onRecord: () => void
  onCommit: (accelerator: string) => void
  onCancel: () => void
}) {
  return (
    <button
      data-hotkey-recorder
      onClick={recording ? onCancel : onRecord}
      onKeyDown={(e) => {
        if (!recording) return
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'Escape') return onCancel()
        const accel = toAccelerator(e)
        if (accel) onCommit(accel)
      }}
      className={`flex min-w-[220px] items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left font-mono text-[13px] transition ${
        recording
          ? 'border-[var(--accent-rule)] bg-[var(--accent-bg)] text-ink'
          : 'border-[var(--rule)] bg-[var(--app)] text-[var(--text-mid)] hover:border-[var(--rule)]'
      }`}
    >
      <span>{recording ? 'Press your combination…' : value || 'Not set'}</span>
      <span className="font-sans text-[11px] text-faint">
        {recording ? 'Esc to cancel' : 'click to change'}
      </span>
    </button>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[12.5px] font-medium text-[var(--text-mid)]">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11.5px] leading-snug text-faint">{hint}</div>}
    </label>
  )
}

const inputCls =
  'w-full rounded-lg border border-[var(--rule)] bg-[var(--app)] px-3 py-2 text-[13.5px] text-ink placeholder:text-faint focus:border-[var(--accent-rule)]'

export default function SettingsModal({
  config,
  models,
  onConfig,
  onModels,
  onClose,
  onProbe,
  probing,
  initialTab,
}: {
  config: Config
  models: ModelInfo[]
  onConfig: (patch: Partial<Config>) => void
  onModels: (m: ModelInfo[]) => void
  onClose: () => void
  onProbe: (id: string) => void
  probing: string | null
  /** open straight onto a tab, e.g. from the sidebar's Images entry */
  initialTab?: Tab
}) {
  const [tab, setTab] = useState<Tab>(initialTab || 'api')
  // Per-provider test results and key reveals, keyed by endpoint so they survive a re-render. The
  // single API key field at the bottom is gone: every provider keeps its own key, and each row can
  // check its own.
  const [reveal, setReveal] = useState<Record<string, boolean>>({})
  const [providerTest, setProviderTest] = useState<
    Record<string, { ok: boolean; note: string; busy: boolean }>
  >({})

  // Ask one provider for its model list, and say plainly whether it answered.
  const testProvider = async (p: Config['profiles'][number]) => {
    const key = p.apiKey || config.apiKey
    setProviderTest((t) => ({ ...t, [p.baseUrl]: { ok: false, note: '', busy: true } }))
    const res = await window.zen.models.list({ ...config, baseUrl: p.baseUrl, apiKey: key, sendAffinity: p.affinity })
    const n = res.models?.length || 0
    setProviderTest((t) => ({
      ...t,
      [p.baseUrl]: res.ok
        ? { ok: true, note: `${n} model${n === 1 ? '' : 's'}`, busy: false }
        : { ok: false, note: res.error || 'no answer', busy: false },
    }))
  }
  const [status, setStatus] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'err'; msg: string }>({
    kind: 'idle',
    msg: '',
  })
  const [info, setInfo] = useState<{ version: string; storePath: string } | null>(null)
  const [filter, setFilter] = useState('')
  const [recording, setRecording] = useState(false)
  const [hotkeyMsg, setHotkeyMsg] = useState<{ ok: boolean; msg: string } | null>(null)
  const [loginItem, setLoginItem] = useState<{ openAtLogin: boolean } | null>(null)
  const [liveHotkey, setLiveHotkey] = useState<(HotkeyStatus & { accelerator: string }) | null>(null)
  const [toolList, setToolList] = useState<{ name: string; label: string; describe: string }[]>([])
  const [searchTest, setSearchTest] = useState<{ ok: boolean; msg: string } | null>(null)
  const [testing, setTesting] = useState(false)
  // Search: three ways to answer it, and Docker's state for setting one of them up.
  const [docker, setDocker] = useState<{ docker: boolean; daemon: boolean; version: string | null; error: string | null } | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installNote, setInstallNote] = useState<{ kind: 'busy' | 'ok' | 'err'; msg: string }>({ kind: 'busy', msg: '' })
  /** What is shown as chosen: a stored mode, or the one search behaves as until told otherwise. */
  const searchMode = config.searchMode || 'searxng'
  /** The three ways to search, in the terms someone choosing between them needs. */
  const SEARCH_CHOICES = [
    {
      id: 'searxng',
      title: 'Your own search service',
      body: 'A SearXNG instance you run. The whole web, no key, no query limit.',
    },
    {
      id: 'key',
      title: 'A search API key',
      body: 'Brave or Tavily. The whole web, without running anything yourself.',
    },
    {
      id: 'provider',
      title: "The model provider's own search",
      body: 'Nothing to set up. Used where your provider has search.',
    },
    {
      id: 'reference',
      title: 'Reference sources only',
      body: 'Wikipedia, Stack Overflow, Hacker News, Open Library.',
    },
  ] as const

  /* ------------------------------------------------------ fal.ai images */

  const imageGen =
    config.imageGen ||
    ({
      enabled: false,
      provider: 'fal' as const,
      falKey: '',
      model: '',
      editModel: 'fal-ai/nano-banana/edit',
      count: 1,
      size: 'square_hd',
    })
  const setImageGen = (patch: Partial<typeof imageGen>) =>
    onConfig({ imageGen: { ...imageGen, ...patch } })

  /* --- ComfyUI: the user's own machine ---------------------------------------------------------
     Whether it is up and what it can run are asked of main every time this tab is opened, so a
     ComfyUI started after the app is noticed without a restart. The port is found rather than
     assumed: 8188 is ComfyUI's own default and the Desktop build listens on 8000. */
  const comfy = imageGen.comfy || { host: '127.0.0.1', port: 0, workflows: [] }
  const [comfyStatus, setComfyStatus] = useState<{
    ok: boolean
    port?: number
    stats?: { version: string; device: string; vramTotal: number; vramFree: number; queueRemaining: number }
    error?: string
  } | null>(null)
  const [comfyList, setComfyList] = useState<
    { id: string; name: string; path: string; kind: string; ok: boolean; error: string; nodes: number }[]
  >([])
  const [comfyBusy, setComfyBusy] = useState(false)
  const [comfyNote, setComfyNote] = useState('')
  const [comfyChecks, setComfyChecks] = useState<Record<string, string>>({})

  const setComfy = (patch: Partial<typeof comfy>) => setImageGen({ comfy: { ...comfy, ...patch } })

  const loadComfy = async () => {
    setComfyBusy(true)
    try {
      const [s, w] = await Promise.all([window.zen.comfy.status(), window.zen.comfy.workflows()])
      setComfyStatus(s)
      setComfyList(w?.workflows || [])
    } catch {
      setComfyStatus({ ok: false, error: 'The app could not ask about ComfyUI.' })
    } finally {
      setComfyBusy(false)
    }
  }

  useEffect(() => {
    if (tab === 'images') void loadComfy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const addComfyWorkflow = async () => {
    const picked = await window.zen.comfy.pick()
    if (picked.canceled) return
    if (!picked.ok || !picked.workflow) {
      setComfyNote(picked.error || 'That file could not be read.')
      return
    }
    const wf = picked.workflow
    setComfy({ workflows: [...comfy.workflows.filter((w) => w.path !== wf.path), wf] })
    setComfyNote(
      `Added ${wf.name} — ${wf.kind === 'edit' ? 'it changes a picture you give it, so it appears in Edit' : 'it draws from your words, so it appears in Picture'}.`,
    )
    void loadComfy()
  }

  const removeComfyWorkflow = (id: string) => {
    setComfy({ workflows: comfy.workflows.filter((w) => w.id !== id) })
    // The rows are drawn from main's own reading of the files, not from the config, so removing has
    // to update both: editing the config alone left the row on screen until the tab was reopened.
    setComfyList((list) => list.filter((w) => w.id !== id))
    setComfyNote('')
  }

  /* Ask the server itself whether it can run this workflow: the node classes, then the model files
     the loaders name. A missing custom node is the usual reason a shared workflow fails, and it is
     worth knowing before a run rather than as a traceback. */
  const checkComfyWorkflow = async (file: string) => {
    setComfyChecks((c) => ({ ...c, [file]: 'checking…' }))
    const res = await window.zen.comfy.check(file)
    const msg = !res.ok
      ? res.error || 'could not check it'
      : res.missingNodes?.length || res.missingModels?.length
        ? [
            res.missingNodes?.length ? `missing nodes: ${res.missingNodes.join(', ')}` : '',
            res.missingModels?.length ? `missing models: ${res.missingModels.map((mm) => mm.wanted).join(', ')}` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : `ready — all ${res.nodeCount} nodes and their model files are on this server`
    setComfyChecks((c) => ({ ...c, [file]: msg }))
  }

  /* --------------------------------------------------- agent mode (Pi) */

  const agent = config.agent || ({ workspace: '', enabled: false })
  const setAgent = (patch: Partial<typeof agent>) => onConfig({ agent: { ...agent, ...patch } })

  const [piStatus, setPiStatus] = useState<{
    installed: boolean
    version: string | null
    pinned: string
  } | null>(null)
  const [piBusy, setPiBusy] = useState(false)
  const [piProgress, setPiProgress] = useState<{ phase: string; pct?: number | null } | null>(null)
  const [piNote, setPiNote] = useState<{ kind: 'idle' | 'ok' | 'err'; msg: string }>({ kind: 'idle', msg: '' })

  const agentPhaseLabel =
    piProgress?.phase === 'download'
      ? `Downloading${piProgress.pct != null ? ` · ${piProgress.pct}%` : ''}`
      : piProgress?.phase === 'verify'
        ? 'Checking the download against the published checksum'
        : piProgress?.phase === 'extract'
          ? 'Unpacking'
          : piProgress?.phase === 'checksums'
            ? 'Reading the release checksums'
            : 'Installing'

  const refreshPi = async () => {
    const st = await window.zen.pi.status()
    setPiStatus(st)
    return st
  }

  useEffect(() => {
    if (tab === 'agent') void refreshPi()
  }, [tab])

  useEffect(() => window.zen.pi.onProgress(setPiProgress), [])
  // Whatever the install is doing, said as it happens, so a slow first pull is not a frozen button.
  useEffect(() => window.zen.search.onInstallProgress((p) => setInstallNote({ kind: 'busy', msg: p.message || p.phase })), [])
  // Whether Docker is here at all decides what the search setting can offer, so ask when it is opened.
  useEffect(() => {
    if (tab !== 'tools') return
    let live = true
    window.zen.search.docker().then((d) => {
      if (live) setDocker(d)
    })
    return () => {
      live = false
    }
  }, [tab])

  /* ---- the local model: no key, no account, about a second to an answer ---- */

  const [localStatus, setLocalStatus] = useState<Awaited<
    ReturnType<typeof window.zen.local.status>
  > | null>(null)
  const [localBusy, setLocalBusy] = useState(false)
  const [localProgress, setLocalProgress] = useState<{
    phase: string
    got?: number
    total?: number
    note?: string
    message?: string
  } | null>(null)
  const [localStarted, setLocalStarted] = useState('')
  const [localNote, setLocalNote] = useState<{ kind: 'idle' | 'ok' | 'err'; msg: string }>({
    kind: 'idle',
    msg: '',
  })
  const [localDetected, setLocalDetected] = useState<
    { id: string; label: string; baseUrl: string; models: string[] }[]
  >([])

  const refreshLocal = async () => {
    const st = await window.zen.local.status()
    setLocalStatus(st)
    setLocalStarted(st?.running?.baseUrl || '')
    return st
  }

  useEffect(() => {
    if (tab === 'api') void refreshLocal()
  }, [tab])

  useEffect(() => window.zen.local.onProgress(setLocalProgress), [])

  /** Real numbers only: the byte count is carried by the progress event itself. */
  const localPct = () => {
    const p = localProgress
    if (!p || !p.total) return 6
    return Math.max(2, Math.min(99, Math.round(((p.got || 0) / p.total) * 100)))
  }

  const localPhaseLabel = () => {
    switch (localProgress?.phase) {
      case 'runtime':
        return `Downloading llama.cpp ${localStatus?.pinned || ''} · ${localPct()}%`
      case 'unpacking':
        return 'Unpacking it and checking it runs'
      case 'model':
        return `Downloading the model · ${localPct()}%`
      case 'model-done':
        return 'Checked. Starting it'
      default:
        return localProgress?.message || 'Getting it'
    }
  }

  const installLocal = async () => {
    setLocalBusy(true)
    setLocalNote({ kind: 'idle', msg: '' })
    try {
      const res = await window.zen.local.install()
      const st = await refreshLocal()
      if (res?.error) setLocalNote({ kind: 'err', msg: res.error })
      else if (st?.ready) setLocalNote({ kind: 'ok', msg: 'It is on this machine now. Start it when you want it.' })
    } catch (err: any) {
      setLocalNote({ kind: 'err', msg: String(err?.message || err) })
    } finally {
      setLocalBusy(false)
      setLocalProgress(null)
    }
  }

  const startLocal = async () => {
    setLocalBusy(true)
    setLocalNote({ kind: 'idle', msg: '' })
    try {
      const res = await window.zen.local.start()
      if (res?.ok) {
        setLocalStarted(res.baseUrl || '')
        setLocalNote({
          kind: 'ok',
          msg: `Ready at ${res.baseUrl}${res.tookMs ? `, up in ${(res.tookMs / 1000).toFixed(1)} s` : ''}.`,
        })
      } else {
        setLocalNote({ kind: 'err', msg: String(res?.error || 'the model did not start') })
      }
      await refreshLocal()
    } catch (err: any) {
      setLocalNote({ kind: 'err', msg: String(err?.message || err) })
    } finally {
      setLocalBusy(false)
    }
  }

  const stopLocal = async () => {
    await window.zen.local.stop()
    setLocalStarted('')
    await refreshLocal()
  }

  /**
   * Point the chat at a server on this machine. A local server names its own model, so ask it
   * rather than leaving the previous name selected: the control at the top has to say which model
   * is actually answering.
   *
   * The key is deliberately left alone. A local server ignores the Authorization header, and
   * clearing the field used to throw away a working relay key the moment someone tried the local
   * option — switching should never cost you the setup you already had.
   */
  const useLocal = async (baseUrl: string, model?: string) => {
    onConfig({ baseUrl, ...(model ? { model } : {}) })
    if (model) {
      setLocalNote({ kind: 'ok', msg: `${baseUrl} is the endpoint, using ${model}.` })
      return
    }
    const r = await window.zen.models.list({ baseUrl, apiKey: '' })
    const first = r?.models?.[0]?.id
    if (first) {
      onConfig({ baseUrl, apiKey: '', model: first })
      setLocalNote({ kind: 'ok', msg: `${first} is the model selected at the top, answering from this machine.` })
    } else {
      setLocalNote({
        kind: 'err',
        msg: `It is running at ${baseUrl}, but it did not report a model name. Press the refresh button beside the model picker.`,
      })
    }
  }

  const detectLocal = async () => {
    const r = await window.zen.local.detect()
    const found = Array.isArray(r?.found) ? r.found : []
    setLocalDetected(found)
    if (!found.length) {
      setLocalNote({ kind: 'idle', msg: 'Nothing answered on 127.0.0.1:1234 or 127.0.0.1:11434.' })
    }
  }

  const installPi = async () => {
    setPiBusy(true)
    setPiNote({ kind: 'idle', msg: '' })
    setPiProgress({ phase: 'checksums' })
    try {
      const res = await window.zen.pi.install()
      const st = await refreshPi()
      if (res?.error) setPiNote({ kind: 'err', msg: res.error })
      else if (st?.installed) setPiNote({ kind: 'ok', msg: `Pi ${st.version} is installed. Switch agent mode on in the chat.` })
    } catch (err: any) {
      setPiNote({ kind: 'err', msg: String(err?.message || err) })
    } finally {
      setPiBusy(false)
      setPiProgress(null)
    }
  }

  const uninstallPi = async () => {
    setAgent({ enabled: false })
    await window.zen.pi.uninstall()
    await refreshPi()
    setPiNote({ kind: 'idle', msg: 'Pi removed, and agent mode is off. Nothing of it is left behind.' })
  }

  const chooseWorkspace = async () => {
    const folder = await window.zen.pi.pickWorkspace()
    if (folder) setAgent({ workspace: folder })
  }

  const [falModels, setFalModels] = useState<FalModel[]>([])
  /** what each listed endpoint charges per picture at the selected size, straight from fal */
  const [falPrices, setFalPrices] = useState<Record<string, { text: string; perImage: number | null }>>({})
  const [falPricesBusy, setFalPricesBusy] = useState(false)
  /** the order the list is shown in — price is the useful comparison between endpoints */
  const [falSort, setFalSort] = useState<'name' | 'cheap' | 'dear'>('name')
  const [falFilter, setFalFilter] = useState('')
  const [showFalKey, setShowFalKey] = useState(false)
  const [falBusy, setFalBusy] = useState(false)
  const [falStatus, setFalStatus] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'err'; msg: string }>({
    kind: 'idle',
    msg: '',
  })
  const [sizes, setSizes] = useState<{ id: string; label: string; width?: number; height?: number }[]>([])
  const [falCost, setFalCost] = useState<{
    text?: string
    forCount?: string
    megapixels?: number
    rate?: string
    source?: string
    perImage?: number | null
  } | null>(null)

  // what the chosen model charges for the chosen size, so the price is visible before drawing
  useEffect(() => {
    const model = falModels.find((m) => m.id === imageGen.model) || (imageGen.model ? { id: imageGen.model } : null)
    const size = sizes.find((s) => s.id === imageGen.size)
    if (!model?.id || !size?.width || !size?.height) {
      setFalCost(null)
      return
    }
    let cancelled = false
    window.zen.images
      .cost({ model: model.id, width: size.width, height: size.height, count: imageGen.count })
      .then((r) => {
        if (!cancelled) setFalCost(r?.ok ? r : null)
      })
      .catch(() => {
        if (!cancelled) setFalCost(null)
      })
    return () => {
      cancelled = true
    }
  }, [falModels, sizes, imageGen.model, imageGen.size, imageGen.count])
  const [genTest, setGenTest] = useState<{ ok: boolean; url?: string; msg: string } | null>(null)
  const falLoadedFor = useRef('')

  const loadFalModels = async () => {
    const key = (imageGen.falKey || '').trim()
    if (!key) {
      setFalStatus({ kind: 'err', msg: 'Add your fal.ai key first.' })
      return
    }
    setFalBusy(true)
    setFalStatus({ kind: 'busy', msg: 'Checking the key and loading the catalogue…' })
    const r = await window.zen.images.models(key)
    if (!r.ok) {
      setFalBusy(false)
      setFalModels([])
      setFalStatus({ kind: 'err', msg: r.error || 'Could not load models from fal.ai.' })
      return
    }
    // Ask for the editors as well: the plain catalogue carries the drawing models, while the
    // endpoints that change a picture you already have are reached through fal's image-to-image
    // category.
    const editors = await window.zen.images.models(key, 'image-to-image')
    setFalBusy(false)
    const list = r.models || []
    if (editors.ok && Array.isArray(editors.models)) {
      const seen = new Set(list.map((m) => m.id))
      for (const m of editors.models) if (!seen.has(m.id)) list.push(m)
    }
    setFalModels(list)
    // The price of every listed endpoint, so each one can show it beside its own name instead of
    // being explained in a panel elsewhere. One call for the whole list (main caches fal's rates
    // for a week); the size matters because most endpoints bill by the megapixel.
    const rateSize = (() => {
      const s = sizes.find((x) => x.id === (imageGen.size || 'square_hd'))
      return s ? { width: s.width, height: s.height } : {}
    })()
    setFalPricesBusy(true)
    window.zen.images
      .prices(
        key,
        list.slice(0, 150).map((m) => m.id),
        rateSize,
      )
      .then((pr) => {
        if (pr?.ok) setFalPrices((p) => ({ ...p, ...pr.prices }))
      })
      .catch(() => {})
      .finally(() => setFalPricesBusy(false))
    if (!imageGen.model && list.length) setImageGen({ model: list[0].id })
    setFalStatus({
      kind: 'ok',
      msg: `Key accepted · ${list.length} image model${list.length === 1 ? '' : 's'} listed from ${r.total ?? list.length} endpoints.`,
    })
  }

  const runTestGeneration = async () => {
    const key = (imageGen.falKey || '').trim()
    const model = (imageGen.model || '').trim()
    if (!key || !model) {
      setGenTest({ ok: false, msg: 'Set a key and choose a model first.' })
      return
    }
    setGenTest({ ok: false, msg: `Drawing one 512px test image with ${model}…` })
    setFalBusy(true)
    const r = await window.zen.images.generate({
      requestId: 'settings-test',
      key,
      model,
      prompt: 'a single red dot centred on a plain white background',
      count: 1,
      size: 'square',
    })
    setFalBusy(false)
    if (!r.ok) {
      setGenTest({ ok: false, msg: r.error || 'Generation failed.' })
      return
    }
    const img = (r.images || [])[0]
    setGenTest({
      ok: true,
      url: img?.url,
      msg: `Generated in ${((r.tookMs || 0) / 1000).toFixed(1)}s${r.params?.length ? ` · sent ${r.params.join(', ')}` : ''}`,
    })
  }

  useEffect(() => {
    window.zen.tools.list().then(setToolList)
  }, [])

  // size presets come from the same module that validates a model's schema
  useEffect(() => {
    window.zen.images
      .options()
      .then((r) => setSizes(r?.sizes || []))
      .catch(() => {})
  }, [])

  // opening the tab with a key already saved loads the catalogue once
  useEffect(() => {
    if (tab !== 'images') return
    const key = (config.imageGen?.falKey || '').trim()
    if (!key || falLoadedFor.current === key) return
    falLoadedFor.current = key
    loadFalModels()
  }, [tab, config.imageGen?.falKey])

  // an outside caller — the sidebar's Images entry — can ask for a tab, including
  // when this modal is already open
  useEffect(() => {
    if (initialTab) setTab(initialTab)
  }, [initialTab])

  // refs so the unmount cleanup can't clobber a shortcut the user just committed
  const recordingRef = useRef(false)
  const hotkeyRef = useRef(config.hotkey)
  hotkeyRef.current = config.hotkey

  useEffect(() => {
    window.zen.app.info().then(setInfo)
  }, [])

  useEffect(() => {
    window.zen.app.getLoginItem().then(setLoginItem)
  }, [])

  // what Windows actually granted, which may differ from what was asked for
  useEffect(() => {
    window.zen.app.getHotkey().then(setLiveHotkey)
  }, [recording, config.hotkey])

  // dismissed mid-recording: hand the stored shortcut back so the app stays reachable
  useEffect(() => {
    return () => {
      if (recordingRef.current) window.zen.app.setHotkey(hotkeyRef.current || '')
    }
  }, [])

  const beginRecord = async () => {
    setHotkeyMsg(null)
    recordingRef.current = true
    setRecording(true)
    // release the live global shortcut, or it swallows the keys we're recording
    await window.zen.app.setHotkey('')
  }

  const commitHotkey = async (accelerator: string) => {
    recordingRef.current = false
    setRecording(false)
    const r = await window.zen.app.setHotkey(accelerator)
    if (r.ok) {
      onConfig({ hotkey: accelerator })
      setHotkeyMsg({
        ok: r.registered,
        msg: r.registered
          ? `Active — ${accelerator} works anywhere in Windows`
          : 'Saved, but Windows did not confirm the registration.',
      })
    } else {
      // put the previous shortcut back so the app isn't left unreachable
      await window.zen.app.setHotkey(hotkeyRef.current || '')
      setHotkeyMsg({ ok: false, msg: r.error || 'That combination is unavailable.' })
    }
  }

  const cancelRecord = async () => {
    recordingRef.current = false
    setRecording(false)
    await window.zen.app.setHotkey(hotkeyRef.current || '')
  }

  const clearHotkey = async () => {
    recordingRef.current = false
    setRecording(false)
    await window.zen.app.setHotkey('')
    onConfig({ hotkey: '' })
    setHotkeyMsg({ ok: true, msg: 'Shortcut cleared — open WorkBuro from the tray instead.' })
  }

  const toggleStartup = async (enabled: boolean) => {
    const state = await window.zen.app.setLoginItem(enabled)
    setLoginItem(state)
    onConfig({ startWithWindows: state.openAtLogin })
    setHotkeyMsg({
      ok: state.openAtLogin === enabled,
      msg:
        state.openAtLogin === enabled
          ? enabled
            ? 'WorkBuro will start with Windows, quietly in the tray.'
            : 'WorkBuro will no longer start with Windows.'
          : 'Windows did not accept that change.',
    })
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const test = async () => {
    setStatus({ kind: 'busy', msg: 'Contacting the endpoint…' })
    const res = await window.zen.models.list(config)
    if (res.ok) {
      onModels(res.models || [])
      setStatus({
        kind: 'ok',
        msg: `Connected — ${res.models?.length || 0} models at ${res.base}`,
      })
      setTab('models')
    } else {
      setStatus({ kind: 'err', msg: res.error || 'Failed' })
    }
  }

  const filtered = filter.trim()
    ? models.filter((m) => m.id.toLowerCase().includes(filter.trim().toLowerCase()))
    : models

  const cycleVision = (id: string) => {
    const cur = config.modelPrefs?.[id]?.vision || 'unknown'
    const next = cur === 'unknown' ? 'yes' : cur === 'yes' ? 'no' : 'unknown'
    onConfig({ modelPrefs: { ...config.modelPrefs, [id]: { ...(config.modelPrefs?.[id] || {}), vision: next } } })
  }

  const falFiltered = falModels
    .filter((m) => {
      const q = falFilter.trim().toLowerCase()
      if (!q) return true
      return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    })
    .sort((a, b) => {
      if (falSort === 'name') return 0
      const pa = falPrices[a.id]?.perImage
      const pb = falPrices[b.id]?.perImage
      // an endpoint fal publishes no rate for has nothing to compare, so it sorts to the end
      if (pa == null && pb == null) return a.id.localeCompare(b.id)
      if (pa == null) return 1
      if (pb == null) return -1
      return falSort === 'cheap' ? pa - pb : pb - pa
    })
  const selectedFal = falModels.find((m) => m.id === imageGen.model) || null

  // Endpoints that take a reference image. The chosen one is always offered, even
  // before the catalogue is loaded, so a saved choice is never silently dropped.
  // Endpoints that can change a picture you already have. fal's catalogue metadata tags only a few
  // of them, so the instruction-editor families are matched by name too — those are the ones that
  // follow your instruction and keep the picture, instead of re-drawing from your words.
  const editChoices = (() => {
    const EDITOR = /\/edit$|image-to-image|kontext|nano-banana|gpt-image|qwen-image-edit/i
    const ids = new Set(
      falModels
        .filter((m) => m.category === 'image-to-image' || EDITOR.test(m.id))
        .filter((m) => !/\/text-to-image$/i.test(m.id))
        .map((m) => m.id),
    )
    const cur = imageGen.editModel || 'fal-ai/nano-banana/edit'
    if (cur) ids.add(cur)
    return [...ids]
      .map(
        (id) =>
          falModels.find((m) => m.id === id) || {
            id,
            name: id,
            description: '',
            category: 'image-to-image',
          },
      )
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
  })()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)] p-6" onMouseDown={onClose}>
      <div
        className="flex h-[660px] max-h-[86vh] w-[740px] flex-col overflow-hidden rounded-2xl border border-[var(--rule)] bg-[var(--app)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--rule)] px-5 py-3.5">
          <h2 className="text-[16px] font-semibold">Settings</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-[var(--raised-2)] hover:text-ink">
            <X size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="w-[150px] shrink-0 border-r border-[var(--rule)] p-2">
            {(['general', 'api', 'chat', 'models', 'images', 'apps', 'mcp', 'tools', 'agent', 'server', 'about'] as Tab[]).map((t) => (
              <button
                key={t}
                data-settings-tab={t}
                onClick={() => setTab(t)}
                className={`mb-0.5 w-full rounded-lg px-3 py-2 text-left text-[13.5px] transition ${
                  tab === t ? 'bg-[var(--raised-2)] text-ink' : 'text-muted hover:bg-[var(--raised)]'
                }`}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {tab === 'general' && (
              <div className="space-y-5">
                <Field
                  label="Theme"
                  hint="Dark keeps the window as it was, on a very dark grey canvas rather than pure black. Paper is the same interface printed on unbleached stock: drafted mono labels, a faint grid, one hazard red. Everything works identically either way."
                >
                  <div className="flex flex-wrap gap-2">
                    {(['dark', 'paper'] as const).map((t) => {
                      const on = (config.theme || 'dark') === t
                      return (
                        <button
                          key={t}
                          data-theme-option={t}
                          onClick={() => onConfig({ theme: t })}
                          className={`rounded-lg border px-3.5 py-2 text-[13px] transition ${
                            on
                              ? 'border-[var(--accent-rule)] bg-[var(--accent-bg)] text-[var(--text)]'
                              : 'border-[var(--rule)] bg-[var(--raised)] text-[var(--text-mid)] hover:text-[var(--text)]'
                          }`}
                        >
                          {t === 'dark' ? 'Dark' : 'Paper'}
                        </button>
                      )
                    })}
                  </div>
                </Field>
                <Field
                  label="Window behaviour"
                  hint="WorkBuro sits above other windows so the summon shortcut always finds it, and tucks itself away once you have gone elsewhere. Nothing is minimised while an answer or a picture is still on its way."
                >
                  <label className="flex items-center gap-2.5">
                    <input
                      type="checkbox"
                      data-always-on-top
                      checked={config.alwaysOnTop !== false}
                      onChange={(e) => onConfig({ alwaysOnTop: e.target.checked })}
                      className="h-4 w-4 accent-[var(--accent)]"
                    />
                    <span className="text-[13px] text-[var(--text-mid)]">Always keep it on top</span>
                  </label>
                  <div className="mt-3 flex flex-wrap items-center gap-2.5">
                    <span className="text-[13px] text-[var(--text-mid)]">Minimise after</span>
                    <select
                      data-auto-minimize
                      className={inputCls + ' max-w-[170px]'}
                      value={String(config.autoMinimizeSec ?? 30)}
                      onChange={(e) => onConfig({ autoMinimizeSec: Number(e.target.value) })}
                    >
                      {[
                        ['0', 'Never'],
                        ['15', '15 seconds'],
                        ['30', '30 seconds'],
                        ['60', '1 minute'],
                        ['300', '5 minutes'],
                      ].map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <span className="text-[12px] text-faint">of the window being out of focus</span>
                  </div>
                </Field>

                <Field
                  label="Summon shortcut"
                  hint="Click the box, then press your combination. It works from anywhere in Windows and toggles WorkBuro open or closed."
                >
                  <div className="space-y-2.5">
                    <HotkeyRecorder
                      value={config.hotkey}
                      recording={recording}
                      onRecord={beginRecord}
                      onCommit={commitHotkey}
                      onCancel={cancelRecord}
                    />
                    <div className="flex flex-wrap items-center gap-1.5">
                      {HOTKEY_PRESETS.map((p) => (
                        <button
                          key={p}
                          onClick={() => commitHotkey(p)}
                          className={`rounded-md border px-2 py-1 font-mono text-[11.5px] transition ${
                            config.hotkey === p
                              ? 'border-[var(--accent-rule)] bg-[var(--raised)] text-ink'
                              : 'border-[var(--rule)] text-muted hover:bg-[var(--raised)] hover:text-ink'
                          }`}
                        >
                          {p}
                        </button>
                      ))}
                      <button
                        onClick={clearHotkey}
                        className="rounded-md border border-[var(--rule)] px-2 py-1 text-[11.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink"
                      >
                        Clear
                      </button>
                    </div>
                    {hotkeyMsg && (
                      <div
                        className={`flex items-start gap-1.5 text-[12px] ${
                          hotkeyMsg.ok ? 'text-[var(--ok)]' : 'text-[var(--err)]'
                        }`}
                      >
                        {hotkeyMsg.ok ? (
                          <Check size={13} className="mt-[1px] shrink-0" />
                        ) : (
                          <TriangleAlert size={13} className="mt-[1px] shrink-0" />
                        )}
                        <span>{hotkeyMsg.msg}</span>
                      </div>
                    )}
                    {liveHotkey && (
                      <div className="text-[11.5px] leading-snug text-faint">
                        {liveHotkey.fallback ? (
                          <>
                            Windows granted{' '}
                            <b className="font-mono text-[var(--warn)]">{liveHotkey.active}</b> instead —{' '}
                            <span className="font-mono">{liveHotkey.requested}</span> is held by another app.
                          </>
                        ) : liveHotkey.active ? (
                          <>
                            Live now: press <b className="font-mono text-ink">{liveHotkey.active}</b> anywhere to
                            summon WorkBuro.
                          </>
                        ) : liveHotkey.requested ? (
                          <>
                            Nothing registered — <span className="font-mono">{liveHotkey.requested}</span> is
                            unavailable.
                          </>
                        ) : (
                          <>No shortcut set.</>
                        )}
                      </div>
                    )}
                  </div>
                </Field>

                <div className="rounded-xl border border-[var(--rule)] bg-[var(--app)] p-3">
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={Boolean(loginItem?.openAtLogin)}
                      onChange={(e) => toggleStartup(e.target.checked)}
                      className="mt-0.5 accent-[var(--accent)]"
                    />
                    <span>
                      <span className="block text-[13px] text-[var(--text-mid)]">Start WorkBuro when Windows starts</span>
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-faint">
                        Starts quietly in the notification area — nothing steals focus at login. Press your summon
                        shortcut, or click the tray icon, to bring it up.
                      </span>
                    </span>
                  </label>
                </div>

                <Field
                  label="Window"
                  hint="WorkBuro opens small so it can sit over other work. Size and position are remembered between launches."
                >
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={async () => {
                        const b = await window.zen.app.resetBounds()
                        if (b) setHotkeyMsg({ ok: true, msg: `Window reset to ${b.width}×${b.height}.` })
                      }}
                      className="flex items-center gap-1.5 rounded-lg border border-[var(--rule)] px-3 py-2 text-[12.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink"
                    >
                      <Minimize2 size={13} /> Reset to the default small size
                    </button>
                    <button
                      onClick={() => window.zen.app.hideWindow()}
                      className="flex items-center gap-1.5 rounded-lg border border-[var(--rule)] px-3 py-2 text-[12.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink"
                    >
                      <EyeOff size={13} /> Hide to tray
                    </button>
                  </div>
                </Field>
              </div>
            )}

            {tab === 'api' && (
              <div className="space-y-4">
                {/* Offered before the key, because a first run should not need an account. */}
                <div className="rounded-xl border border-[var(--rule)] bg-[var(--app)] p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink">
                        {localStatus?.ready
                          ? `${localStatus.catalogue?.[0]?.label || 'A model'} is on this machine`
                          : 'No key? Run a small model here'}
                      </div>
                      <div className="mt-0.5 text-[11.5px] leading-snug text-faint">
                        {localBusy
                          ? localPhaseLabel()
                          : localStatus?.ready
                            ? localStarted
                              ? 'Running here. Point the chat at it and type.'
                              : `Starts in about a second, then answers with no account and no key.${
                                  localStatus.catalogue?.[0] ? ` ${localStatus.catalogue[0].label} is ${localStatus.catalogue[0].size}.` : ''
                                }`
                            : localStatus?.catalogue?.[0]
                              ? `${localStatus.catalogue[0].note} It is ${localStatus.catalogue[0].size}, downloaded once, and checked against a pinned checksum before it runs.`
                              : 'Checking what is on this machine…'}
                      </div>
                    </div>
                    {localStatus?.ready ? (
                      localStarted ? (
                        <button
                          onClick={stopLocal}
                          disabled={localBusy}
                          className="flex h-[34px] shrink-0 items-center rounded-lg border border-[var(--rule)] px-3 text-[12.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink disabled:opacity-50"
                        >
                          Stop
                        </button>
                      ) : (
                        <button
                          onClick={startLocal}
                          disabled={localBusy}
                          className="flex h-[34px] shrink-0 items-center rounded-lg border border-[var(--accent-rule)] bg-[var(--accent-bg)] px-3 text-[12.5px] text-[var(--accent-soft)] transition disabled:opacity-50"
                        >
                          {localBusy ? 'Starting…' : 'Start'}
                        </button>
                      )
                    ) : (
                      <button
                        onClick={installLocal}
                        disabled={localBusy || !localStatus}
                        className="flex h-[34px] shrink-0 items-center gap-1.5 rounded-lg border border-[var(--accent-rule)] bg-[var(--accent-bg)] px-3 text-[12.5px] text-[var(--accent-soft)] transition disabled:opacity-50"
                      >
                        <RefreshCw size={13} className={localBusy ? 'animate-spin' : ''} />
                        {localBusy ? 'Getting it…' : 'Get it'}
                      </button>
                    )}
                  </div>

                  {localBusy && (
                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--raised)]">
                      <div
                        className="h-full rounded-full bg-[var(--accent-bg)] transition-all"
                        style={{ width: `${localPct()}%` }}
                      />
                    </div>
                  )}

                  {localStarted && !localBusy && (
                    <button
                      onClick={() => useLocal(localStarted)}
                      className="mt-3 flex h-[32px] items-center rounded-lg border border-[var(--accent-rule)] bg-[var(--accent-bg)] px-3 text-[12.5px] text-[var(--accent-soft)] transition"
                    >
                      Use this as the endpoint
                    </button>
                  )}

                  {localNote.msg && (
                    <div
                      className={`mt-2 break-words text-[11.5px] leading-snug ${
                        localNote.kind === 'err' ? 'text-[var(--err)]' : 'text-[var(--ok)]'
                      }`}
                    >
                      {localNote.msg}
                    </div>
                  )}

                  {!localStatus?.ready && !localBusy && (
                    <button
                      onClick={detectLocal}
                      className="mt-2 text-[11.5px] text-faint underline decoration-dotted underline-offset-2 transition hover:text-muted"
                    >
                      Already running a local server? Look for it
                    </button>
                  )}

                  {localDetected.length > 0 && (
                    <div className="mt-2.5 space-y-1 border-t border-[var(--rule)] pt-2.5">
                      {localDetected.map((d) => (
                        <div key={d.id} className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-[11.5px] text-faint">
                            {d.label} is running here
                            {d.models.length ? `, with ${d.models.length} model${d.models.length === 1 ? '' : 's'}` : ''}
                          </span>
                          <button
                            onClick={() => useLocal(d.baseUrl, d.models[0])}
                            className="flex h-[28px] shrink-0 items-center rounded-lg border border-[var(--rule)] px-2.5 text-[11.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink"
                          >
                            Use it
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <div className="mb-1.5 text-[12.5px] font-medium text-[var(--text-mid)]">Providers</div>
                  <div className="space-y-1.5">
                    {config.profiles.map((p, i) => {
                      const at = providerTest[p.baseUrl]
                      const active = config.baseUrl === p.baseUrl
                      const shown = reveal[p.baseUrl]
                      return (
                        <div key={`${p.name}-${i}`} className="flex items-center gap-2">
                          <button
                            onClick={() =>
                              // Choosing a provider chooses its key as well, because two paid providers
                              // cannot both work off the one key.
                              onConfig({
                                baseUrl: p.baseUrl,
                                sendAffinity: p.affinity,
                                ...(p.apiKey ? { apiKey: p.apiKey } : {}),
                              })
                            }
                            className={`flex w-[168px] shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] transition ${
                              active
                                ? 'border-[var(--accent-rule)] bg-[var(--raised)] text-ink'
                                : 'border-[var(--rule)] text-muted hover:bg-[var(--raised)] hover:text-ink'
                            }`}
                          >
                            <Globe size={12} className="shrink-0" />
                            <span className="truncate">{p.name}</span>
                          </button>

                          <div className="relative min-w-0 flex-1">
                            <KeyRound
                              size={13}
                              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
                            />
                            <input
                              className={inputCls + ' pl-8 pr-9'}
                              type={shown ? 'text' : 'password'}
                              value={p.apiKey || ''}
                              spellCheck={false}
                              placeholder="key for this provider (optional)"
                              onChange={(e) => {
                                const v = e.target.value
                                const next = config.profiles.map((x, j) => (j === i ? { ...x, apiKey: v } : x))
                                // Keep the app's working key in step when this is the provider in use,
                                // or chatting would carry on with whatever was there before.
                                onConfig(active ? { profiles: next, apiKey: v } : { profiles: next })
                                setProviderTest((t) => {
                                  const c = { ...t }
                                  delete c[p.baseUrl]
                                  return c
                                })
                              }}
                            />
                            <button
                              onClick={() => setReveal((r) => ({ ...r, [p.baseUrl]: !r[p.baseUrl] }))}
                              title={shown ? 'Hide this key' : 'Show this key'}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-ink"
                            >
                              {shown ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                          </div>

                          <button
                            onClick={() => void testProvider(p)}
                            disabled={at?.busy}
                            title="Ask this provider for its model list"
                            className="flex h-[34px] shrink-0 items-center rounded-lg border border-[var(--rule)] px-3 text-[12px] text-muted transition hover:bg-[var(--raised)] hover:text-ink disabled:opacity-50"
                          >
                            {at?.busy ? 'Testing…' : 'Test'}
                          </button>

                          {/* A tick when it answered, a cross and the reason when it did not. */}
                          {at && !at.busy ? (
                            <span
                              title={at.note}
                              className={`grid h-6 w-6 shrink-0 place-items-center ${
                                at.ok ? 'text-[var(--ok)]' : 'text-[var(--err)]'
                              }`}
                            >
                              {at.ok ? <Check size={15} /> : <X size={15} />}
                            </span>
                          ) : (
                            <span className="h-6 w-6 shrink-0" />
                          )}
                        </div>
                      )
                    })}
                  </div>
                  <div className="mt-1.5 text-[11.5px] leading-snug text-faint">
                    Each provider is asked with its own key when it has one, so two accounts can both list their
                    models. Test asks it for its model list now; the tick is for this session.
                  </div>
                </div>

                <Field
                  label="API base URL"
                  hint="Any OpenAI-compatible root. /v1 is added automatically if missing; pasting a full …/chat/completions path also works."
                >
                  <input
                    className={inputCls}
                    value={config.baseUrl}
                    spellCheck={false}
                    onChange={(e) => onConfig({ baseUrl: e.target.value })}
                  />
                </Field>

                <div className="rounded-xl border border-[var(--rule)] bg-[var(--app)] p-3">
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={config.sendAffinity}
                      onChange={(e) => onConfig({ sendAffinity: e.target.checked })}
                      className="mt-0.5 accent-[var(--accent)]"
                    />
                    <span>
                      <span className="block text-[13px] text-[var(--text-mid)]">Send session affinity header</span>
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-faint">
                        opencode's relay requires <code>x-opencode-session</code> or every request 400s. Keeps one
                        backend pinned and the prompt cache warm. Sent automatically when the host is
                        opencode.ai; toggle for other relays.
                      </span>
                    </span>
                  </label>
                  {config.sendAffinity && (
                    <input
                      className={inputCls + ' mt-2.5'}
                      value={config.affinityId}
                      spellCheck={false}
                      onChange={(e) => onConfig({ affinityId: e.target.value })}
                    />
                  )}
                </div>

                <div className="flex items-center gap-2.5">
                  <button
                    onClick={test}
                    disabled={status.kind === 'busy'}
                    className="flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-[var(--text-solid)] transition hover:bg-[var(--accent-bg)] disabled:opacity-60"
                  >
                    <Zap size={14} /> Test connection
                  </button>
                  {status.kind !== 'idle' && (
                    <div
                      className={`flex items-center gap-1.5 text-[12.5px] ${
                        status.kind === 'ok' ? 'text-[var(--ok)]' : status.kind === 'err' ? 'text-[var(--err)]' : 'text-muted'
                      }`}
                    >
                      {status.kind === 'ok' ? (
                        <Check size={13} />
                      ) : status.kind === 'err' ? (
                        <HelpCircle size={13} />
                      ) : (
                        <RefreshCw size={13} className="animate-spin" />
                      )}
                      <span className="max-w-[380px] break-words">{status.msg}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === 'chat' && (
              <div className="space-y-4">
                <div className="rounded-xl border border-[var(--rule)] bg-[var(--app)] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] text-[var(--text-mid)]">Instructions</span>
                    {Boolean(config.systemPrompt?.trim()) && (
                      <button
                        onClick={() => onConfig({ systemPrompt: '' })}
                        className="shrink-0 text-[11.5px] text-faint transition hover:text-[var(--err)]"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <p className="mt-1 mb-2.5 text-[11.5px] leading-snug text-faint">
                    Standing instructions the assistant follows in every conversation — how to talk, what to skip,
                    what to always do. Sent with every message as a system prompt (as <code>instructions</code> on
                    the Responses protocol), so keep them short.
                  </p>
                  <textarea
                    rows={4}
                    data-instructions
                    className={inputCls + ' resize-y leading-relaxed'}
                    value={config.systemPrompt}
                    placeholder={`e.g. Keep it short. Answer directly. Be friendly.`}
                    onChange={(e) => onConfig({ systemPrompt: e.target.value })}
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {INSTRUCTION_PRESETS.map((p) => (
                      <button
                        key={p}
                        onClick={() => {
                          const cur = config.systemPrompt || ''
                          if (cur.toLowerCase().includes(p.toLowerCase())) return
                          onConfig({ systemPrompt: cur.trim() ? `${cur.replace(/\s+$/, '')}\n${p}` : p })
                        }}
                        className="rounded-full border border-[var(--rule)] px-2 py-1 text-[11.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink"
                      >
                        + {p}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-faint">
                    Applies from your next message — no need to start a new chat.
                  </p>
                </div>

                <Field label="Default model">
                  <input
                    className={inputCls}
                    value={config.model}
                    spellCheck={false}
                    list="model-options"
                    onChange={(e) => onConfig({ model: e.target.value })}
                  />
                  <datalist id="model-options">
                    {models.map((m) => (
                      <option key={m.id} value={m.id} />
                    ))}
                  </datalist>
                </Field>

                <div className="grid grid-cols-2 gap-4">
                  <Field
                    label="Protocol"
                    hint="Auto tries Chat Completions, then falls back to Responses (needed by grok / gpt-*-luna on this relay)."
                  >
                    <select
                      className={inputCls}
                      value={config.protocol}
                      onChange={(e) => onConfig({ protocol: e.target.value as Config['protocol'] })}
                    >
                      <option value="auto">Auto</option>
                      <option value="chat">Chat Completions</option>
                      <option value="responses">Responses</option>
                    </select>
                  </Field>
                  <Field label="Max output tokens" hint="Thinking models spend part of this on hidden reasoning.">
                    <input
                      type="number"
                      className={inputCls}
                      value={config.maxTokens}
                      onChange={(e) => onConfig({ maxTokens: Number(e.target.value) })}
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <Field label="Temperature">
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                      className={inputCls}
                      value={config.temperature}
                      onChange={(e) => onConfig({ temperature: Number(e.target.value) })}
                    />
                  </Field>
                  <div className="space-y-2.5 pt-5">
                    <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        checked={config.stream}
                        onChange={(e) => onConfig({ stream: e.target.checked })}
                        className="accent-[var(--accent)]"
                      />
                      Stream responses
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        checked={config.thinking}
                        onChange={(e) => onConfig({ thinking: e.target.checked })}
                        className="accent-[var(--accent)]"
                      />
                      Thinking on by default
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        checked={config.showUsage}
                        onChange={(e) => onConfig({ showUsage: e.target.checked })}
                        className="accent-[var(--accent)]"
                      />
                      Show token usage
                    </label>
                  </div>
                </div>
              </div>
            )}

            {tab === 'agent' && (
              <div className="space-y-3">
                <Field
                  label="Agent mode"
                  hint="Hands for the model you already selected. Add Pi once here, then switch agent mode on in the chat: it can read and write files and run commands in one folder you pick."
                >
                  <div className="rounded-xl border border-[var(--rule)] bg-[var(--app)] p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[13px] text-ink">
                          {piStatus?.installed ? `Pi ${piStatus.version} is installed` : 'Pi is not installed'}
                        </div>
                        <div className="mt-0.5 text-[11.5px] leading-snug text-faint">
                          {piBusy
                            ? agentPhaseLabel
                            : piStatus?.installed
                              ? 'Off by default. Agent mode is switched on in the chat, and switched off again when you are done.'
                              : `Downloads Pi ${piStatus?.pinned || ''} from its own release, checks the published SHA-256 before unpacking it, and keeps it beside your data. About 42 MB — no npm, no Node to install.`}
                        </div>
                      </div>
                      {piStatus?.installed ? (
                        <button
                          onClick={uninstallPi}
                          disabled={piBusy}
                          className="flex h-[34px] shrink-0 items-center rounded-lg border border-[var(--rule)] px-3 text-[12.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink disabled:opacity-50"
                        >
                          Remove
                        </button>
                      ) : (
                        <button
                          onClick={installPi}
                          disabled={piBusy || !piStatus}
                          className="flex h-[34px] shrink-0 items-center gap-1.5 rounded-lg border border-[var(--accent-rule)] bg-[var(--accent-bg)] px-3 text-[12.5px] text-[var(--accent-soft)] transition hover:bg-[var(--accent-bg)] disabled:opacity-50"
                        >
                          <RefreshCw size={13} className={piBusy ? 'animate-spin' : ''} />
                          {piBusy ? 'Installing…' : 'Install Pi'}
                        </button>
                      )}
                    </div>
                    {piBusy && (
                      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--raised)]">
                        <div
                          className="h-full rounded-full bg-[var(--accent-bg)] transition-all"
                          style={{ width: `${piProgress?.pct ?? 6}%` }}
                        />
                      </div>
                    )}
                  </div>
                </Field>

                <div className="rounded-xl border border-[var(--warn)] bg-[var(--app)] p-3 text-[11.5px] leading-snug text-[var(--warn)]">
                  <strong className="font-medium">While agent mode is on, Pi runs with the rights of your Windows account</strong>{' '}
                  in the folder below — it has no permission prompts of its own. Keep the folder narrow and switch the toggle
                  off when you are done. Nothing is downloaded, installed or scheduled until you press Install, and the API key
                  is handed to it in memory, never written to its config.
                </div>

                <Field
                  label="Workspace folder"
                  hint="The folder the agent may work in. It can create and change files here, and runs commands with this as the working directory."
                >
                  <div className="flex gap-2">
                    <input className={inputCls} value={agent.workspace || ''} readOnly placeholder="No folder chosen yet" />
                    <button
                      onClick={chooseWorkspace}
                      className="flex h-[38px] shrink-0 items-center rounded-lg border border-[var(--rule)] px-3 text-[12.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink"
                    >
                      Choose…
                    </button>
                    <button
                      onClick={() => void window.zen.pi.openWorkspace()}
                      disabled={!agent.workspace}
                      className="flex h-[38px] shrink-0 items-center rounded-lg border border-[var(--rule)] px-3 text-[12.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink disabled:opacity-50"
                    >
                      Open
                    </button>
                  </div>
                </Field>

                <Field
                  label="What an agent turn costs"
                  hint="Agent turns use the model selected in the chat, over the same key and endpoint as your ordinary messages."
                >
                  <p className="text-[11.5px] leading-snug text-faint">
                    One agent turn makes several model calls where a chat message makes one, so it spends more tokens. Nothing
                    else is billed and no second key is needed. Switch the toggle off and the next message costs exactly what it
                    always did.
                  </p>
                </Field>

                {piNote.msg && (
                  <div
                    className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] ${
                      piNote.kind === 'err'
                        ? 'border-[var(--err-rule)] bg-[var(--err-bg)] text-[var(--err)]'
                        : piNote.kind === 'ok'
                          ? 'border-[var(--ok)] bg-[var(--app)] text-[var(--ok)]'
                          : 'border-[var(--rule)] bg-[var(--app)] text-muted'
                    }`}
                  >
                    {piNote.kind === 'err' ? (
                      <TriangleAlert size={13} className="mt-[1px] shrink-0" />
                    ) : (
                      <Check size={13} className="mt-[1px] shrink-0" />
                    )}
                    <span className="min-w-0 flex-1">{piNote.msg}</span>
                  </div>
                )}
              </div>
            )}

            {tab === 'apps' && <AppsPane config={config} onConfig={onConfig} />}
            {tab === 'mcp' && <McpPane config={config} onConfig={onConfig} />}
            {tab === 'server' && <ServerPane />}

            {tab === 'tools' && (
              <div className="space-y-5">
                <div className="rounded-xl border border-[var(--rule)] bg-[var(--app)] p-3">
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={config.toolsEnabled !== false}
                      onChange={(e) => onConfig({ toolsEnabled: e.target.checked })}
                      className="mt-0.5 accent-[var(--accent)]"
                    />
                    <span>
                      <span className="block text-[13px] text-[var(--text-mid)]">Let the model use tools</span>
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-faint">
                        Without this, a model can only answer from its training data — no live web, no real-time
                        anything. With it, the model can ask WorkBuro for information and then answer using it.
                      </span>
                    </span>
                  </label>
                </div>

                <Field
                  label="Available tools"
                  hint="The model chooses when to use these. Tool calls and their sources appear above each reply."
                >
                  <div className="space-y-2">
                    {toolList.map((t) => {
                      const on = config.toolToggles?.[t.name] !== false
                      return (
                        <label key={t.name} className="flex cursor-pointer items-start gap-2.5">
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={config.toolsEnabled === false}
                            onChange={(e) =>
                              onConfig({ toolToggles: { ...(config.toolToggles || {}), [t.name]: e.target.checked } })
                            }
                            className="mt-0.5 accent-[var(--accent)] disabled:opacity-40"
                          />
                          <span className={config.toolsEnabled === false ? 'opacity-50' : ''}>
                            <span className="block text-[13px] text-[var(--text-mid)]">{t.label}</span>
                            <span className="mt-0.5 block text-[11.5px] leading-snug text-faint">{t.describe}</span>
                          </span>
                        </label>
                      )
                    })}
                    {!toolList.length && <span className="text-[12px] text-faint">Loading tools…</span>}
                  </div>
                </Field>

                <Field
                  label="Search"
                  hint="Three ways to search. Each falls back to the reference sources when it is not available, and the answer always says which source it came from."
                >
                  <div className="space-y-3">
                    <div className="space-y-2.5">
                      {SEARCH_CHOICES.map((o) => (
                        <label key={o.id} className="flex cursor-pointer items-start gap-2.5">
                          <input
                            type="radio"
                            name="search-mode"
                            checked={searchMode === o.id}
                            onChange={() => {
                              onConfig({ searchMode: o.id })
                              setSearchTest(null)
                            }}
                            className="mt-1 accent-[var(--accent)]"
                          />
                          <span>
                            <span className="block text-[13px] text-[var(--text-mid)]">{o.title}</span>
                            <span className="mt-0.5 block text-[11.5px] leading-snug text-faint">{o.body}</span>
                          </span>
                        </label>
                      ))}
                    </div>

                    {searchMode === 'searxng' && (
                      <div className="space-y-2 rounded-lg border border-[var(--rule)] p-3">
                        <input
                          value={config.searchUrl || ''}
                          onChange={(e) => onConfig({ searchUrl: e.target.value })}
                          spellCheck={false}
                          placeholder="http://localhost:8888"
                          className="w-full rounded-lg border border-[var(--rule)] bg-[var(--app)] px-3 py-2 font-mono text-[12.5px] text-[var(--text-mid)] outline-none focus:border-[var(--accent-rule)]"
                        />
                        {docker && (
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                            <button
                              disabled={installing || !docker.daemon}
                              onClick={async () => {
                                setInstalling(true)
                                setInstallNote({ kind: 'busy', msg: 'Setting it up…' })
                                const r = await window.zen.search.install({})
                                setInstalling(false)
                                setInstallNote(
                                  r.ok
                                    ? { kind: 'ok', msg: `Ready. Search answers at ${r.url} with ${r.results} results.` }
                                    : { kind: 'err', msg: r.error || 'That did not work.' },
                                )
                                if (r.ok && r.url) onConfig({ searchUrl: r.url, searchMode: 'searxng' })
                              }}
                              className="flex items-center gap-1.5 rounded-lg border border-[var(--rule)] px-3 py-2 text-[12.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink disabled:opacity-50"
                            >
                              {installing ? <RefreshCw size={13} className="animate-spin" /> : <Sparkles size={13} />}
                              Set up SearXNG for me
                            </button>
                            <span className="text-[11.5px] leading-snug text-faint">
                              {docker.daemon
                                ? `Docker ${docker.version || ''} is here: one click starts a container on :8888 and waits until it actually answers.`
                                : docker.docker
                                  ? 'Docker is installed but its daemon is not running. Start Docker Desktop and try again.'
                                  : 'Docker is not installed. Search still works: the reference sources need nothing.'}
                            </span>
                          </div>
                        )}
                        {installNote.msg && (
                          <div
                            className={`flex items-start gap-1.5 text-[12px] ${
                              installNote.kind === 'ok'
                                ? 'text-[var(--ok)]'
                                : installNote.kind === 'err'
                                  ? 'text-[var(--err)]'
                                  : 'text-faint'
                            }`}
                          >
                            {installNote.kind === 'ok' && <Check size={13} className="mt-[1px] shrink-0" />}
                            {installNote.kind === 'err' && <TriangleAlert size={13} className="mt-[1px] shrink-0" />}
                            <span className="break-words">{installNote.msg}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {searchMode === 'key' && (
                      <div className="space-y-2 rounded-lg border border-[var(--rule)] p-3">
                        <div className="flex gap-4">
                          {(['brave', 'tavily'] as const).map((p) => (
                            <label
                              key={p}
                              className="flex cursor-pointer items-center gap-2 text-[12.5px] text-[var(--text-mid)]"
                            >
                              <input
                                type="radio"
                                name="search-provider"
                                checked={(config.searchProvider || 'brave') === p}
                                onChange={() => onConfig({ searchProvider: p })}
                                className="accent-[var(--accent)]"
                              />
                              {p === 'brave' ? 'Brave' : 'Tavily'}
                            </label>
                          ))}
                        </div>
                        <input
                          type="password"
                          value={config.searchKey || ''}
                          onChange={(e) => onConfig({ searchKey: e.target.value })}
                          spellCheck={false}
                          placeholder="paste the key here"
                          className="w-full rounded-lg border border-[var(--rule)] bg-[var(--app)] px-3 py-2 font-mono text-[12.5px] text-[var(--text-mid)] outline-none focus:border-[var(--accent-rule)]"
                        />
                        <span className="block text-[11.5px] leading-snug text-faint">
                          Kept the same way the model keys are, in this app's own file. If the key stops working,
                          search falls back to the reference sources rather than failing.
                        </span>
                      </div>
                    )}

                    <button
                      disabled={testing}
                      onClick={async () => {
                        setTesting(true)
                        setSearchTest(null)
                        const r = await window.zen.tools.probe({
                          searchUrl: config.searchUrl,
                          searchMode: config.searchMode,
                          searchKey: config.searchKey,
                          searchProvider: config.searchProvider,
                        })
                        setTesting(false)
                        setSearchTest({
                          ok: r.ok,
                          msg: r.ok
                            ? `${r.reference ? 'Reference sources answered' : 'Search works'} — ${r.preview.slice(0, 150)}`
                            : r.error || 'Search failed.',
                        })
                      }}
                      className="flex items-center gap-1.5 rounded-lg border border-[var(--rule)] px-3 py-2 text-[12.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink disabled:opacity-50"
                    >
                      {testing ? <RefreshCw size={13} className="animate-spin" /> : <Globe size={13} />} Test search
                    </button>
                    {searchTest && (
                      <div
                        className={`flex items-start gap-1.5 text-[12px] ${
                          searchTest.ok ? 'text-[var(--ok)]' : 'text-[var(--err)]'
                        }`}
                      >
                        {searchTest.ok ? (
                          <Check size={13} className="mt-[1px] shrink-0" />
                        ) : (
                          <TriangleAlert size={13} className="mt-[1px] shrink-0" />
                        )}
                        <span className="break-words">{searchTest.msg}</span>
                      </div>
                    )}
                  </div>
                </Field>

                <Field
                  label="Tool rounds"
                  hint="How many times the model may call tools before it has to answer with what it has. Each round is another API call."
                >
                  <input
                    type="number"
                    min={0}
                    max={8}
                    value={config.maxToolRounds ?? 4}
                    onChange={(e) => onConfig({ maxToolRounds: Math.min(Math.max(Number(e.target.value) || 0, 0), 8) })}
                    className="w-[80px] rounded-lg border border-[var(--rule)] bg-[var(--app)] px-3 py-2 text-[13px] text-[var(--text-mid)] outline-none focus:border-[var(--accent-rule)]"
                  />
                </Field>

                <Field
                  label="Server-side search"
                  hint="grok and the gpt-luna models run their own live web search on the relay. Leave this on to use it; turn it off to force everything through your local SearXNG."
                >
                  <label className="flex cursor-pointer items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={config.serverSearch !== false}
                      onChange={(e) => onConfig({ serverSearch: e.target.checked })}
                      className="accent-[var(--accent)]"
                    />
                    <span className="text-[13px] text-[var(--text-mid)]">Use the relay's built-in search where available</span>
                  </label>
                </Field>
              </div>
            )}

            {tab === 'models' && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <input
                    className={inputCls}
                    placeholder="Filter models"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                  <button
                    onClick={test}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--rule)] px-3 py-2 text-[12.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink"
                  >
                    <RefreshCw size={13} /> Reload
                  </button>
                </div>
                <div className="text-[11.5px] leading-snug text-faint">
                  <strong className="font-medium text-muted">Zap</strong> = live test (runs a real call and an image
                  call to detect vision support). Click the eye to override what the app believes about a model.
                </div>
                <div className="divide-y divide-[var(--rule)] overflow-hidden rounded-xl border border-[var(--rule)]">
                  {filtered.length === 0 && (
                    <div className="px-3 py-4 text-[13px] text-faint">
                      No models loaded. Use <strong>API &amp; key → Test connection</strong>.
                    </div>
                  )}
                  {filtered.map((m) => {
                    const p = config.modelPrefs?.[m.id] || {}
                    return (
                      <div key={m.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--raised)]">
                        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-[var(--text-mid)]">{m.id}</span>
                        {p.protocol && (
                          <span className="rounded bg-[var(--raised-2)] px-1.5 text-[9.5px] uppercase tracking-wide text-[var(--text-mid)]">
                            {p.protocol}
                          </span>
                        )}
                        <button
                          onClick={() => cycleVision(m.id)}
                          title={`Vision: ${p.vision || 'unknown'} (click to change)`}
                          className="grid h-6 w-6 place-items-center rounded text-muted hover:bg-[var(--raised-2)] hover:text-ink"
                        >
                          {p.vision === 'yes' ? (
                            <Eye size={13} className="text-[var(--ok)]" />
                          ) : p.vision === 'no' ? (
                            <EyeOff size={13} className="text-[var(--err)]" />
                          ) : (
                            <Eye size={13} className="opacity-30" />
                          )}
                        </button>
                        <button
                          onClick={() => onProbe(m.id)}
                          disabled={probing === m.id}
                          className="grid h-6 w-6 place-items-center rounded text-muted hover:bg-[var(--raised-2)] hover:text-ink disabled:opacity-50"
                        >
                          <Zap size={13} className={probing === m.id ? 'animate-pulse text-[var(--warn)]' : ''} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {tab === 'images' && (
              <div className="space-y-3">
                <Field
                  label="Image generation"
                  hint="Hosted drawing through fal.ai. The key lives in your local store file and is sent only to fal.ai — never to your chat endpoint."
                >
                  <label className="flex items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={Boolean(imageGen.enabled)}
                      onChange={(e) => setImageGen({ enabled: e.target.checked })}
                      className="h-4 w-4 accent-[var(--accent)]"
                    />
                    <span className="text-[13px] text-[var(--text-mid)]">
                      Show the manual <strong className="font-medium">Image</strong> button in the composer
                    </span>
                  </label>
                  <p className="mt-2 text-[11.5px] leading-snug text-faint">
                    You don't need this on to get pictures. As soon as a key is saved below, the model calls image
                    generation by itself whenever you ask to see something — "create an image of…", "show me how it
                    would look" — and the picture lands in the conversation. That tool is switched off in{' '}
                    <strong className="font-medium text-muted">Tools</strong>, not here; this box only adds the manual
                    button that sends your next message straight to fal.
                  </p>
                </Field>

                <Field
                  label="ComfyUI"
                  hint="Your own ComfyUI, as a second way to draw. Add a workflow you exported with Workflow → Export (API) and it appears in the Picture and Edit lists in the top bar, beside the hosted models. A workflow that takes a picture belongs in Edit; one that only draws from words belongs in Picture — which is which is read from the graph itself. Nothing here needs a fal key, and the picture is made on your machine."
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      className={`${inputCls} min-w-[150px] flex-1`}
                      value={comfy.host || ''}
                      spellCheck={false}
                      placeholder="127.0.0.1"
                      onChange={(e) => setComfy({ host: e.target.value })}
                    />
                    <input
                      className={`${inputCls} w-24`}
                      type="number"
                      min={0}
                      max={65535}
                      value={Number.isFinite(comfy.port) ? comfy.port : 0}
                      title="0 finds it: ComfyUI's own default (8188) and the Desktop app's port (8000) are both tried"
                      onChange={(e) => setComfy({ port: Number(e.target.value) || 0 })}
                    />
                    <button
                      onClick={() => void loadComfy()}
                      disabled={comfyBusy}
                      className="flex h-[38px] shrink-0 items-center gap-1.5 rounded-lg border border-[var(--rule)] px-3 text-[12.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink disabled:opacity-50"
                    >
                      <RefreshCw size={13} className={comfyBusy ? 'animate-spin' : ''} />
                      Test
                    </button>
                  </div>

                  <p data-comfy-status className="mt-2 text-[11.5px] leading-snug">
                    {comfyStatus == null ? (
                      <span className="text-faint">Not checked yet.</span>
                    ) : comfyStatus.ok ? (
                      <span className="text-[var(--ok)]">
                        ComfyUI {comfyStatus.stats?.version || ''} is up on port {comfyStatus.port}
                        {comfyStatus.stats?.device ? ` — ${comfyStatus.stats.device}` : ''}
                        {comfyStatus.stats?.vramTotal
                          ? `, ${(comfyStatus.stats.vramFree / 2 ** 30).toFixed(1)} GB of ${(comfyStatus.stats.vramTotal / 2 ** 30).toFixed(1)} GB free`
                          : ''}
                        .
                      </span>
                    ) : (
                      <span className="text-[var(--warn)]">
                        {comfyStatus.error} Start ComfyUI and press Test — the port is found by itself, so only set one
                        above if it is somewhere unusual.
                      </span>
                    )}
                  </p>

                  <div className="mt-3 space-y-2">
                    {comfyList.length === 0 ? (
                      <p className="text-[11.5px] leading-snug text-faint">
                        No workflows added yet. In ComfyUI, open the workflow you want and use{' '}
                        <strong className="font-medium text-muted">Workflow → Export (API)</strong>, then add that file
                        here. The file is read on every run, so editing it in ComfyUI and sending again uses the new
                        version — there is no copy inside the app to go stale.
                      </p>
                    ) : (
                      comfyList.map((w) => (
                        <div
                          key={w.id}
                          data-comfy-row={w.id}
                          className="rounded-xl border border-[var(--rule)] bg-[var(--app)] p-2.5"
                        >
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] text-ink">{w.name}</span>
                              <span className="block truncate text-[11px] text-faint" title={w.path}>
                                {w.kind === 'edit' ? 'changes a picture you give it' : 'draws from your words'}
                                {w.ok ? ` · ${w.nodes} nodes` : ''} · {w.path}
                              </span>
                            </span>
                            <button
                              onClick={() => void checkComfyWorkflow(w.path)}
                              className="shrink-0 rounded-lg border border-[var(--rule)] px-2 py-1 text-[11.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink"
                            >
                              Check
                            </button>
                            <button
                              onClick={() => removeComfyWorkflow(w.id)}
                              title="Remove from the list — the file itself is left alone"
                              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-[var(--raised)] hover:text-ink"
                            >
                              <X size={13} />
                            </button>
                          </div>
                          {!w.ok && w.error ? <p className="mt-1.5 text-[11.5px] text-[var(--err)]">{w.error}</p> : null}
                          {comfyChecks[w.path] ? (
                            <p data-comfy-check className="mt-1.5 text-[11.5px] text-faint">
                              {comfyChecks[w.path]}
                            </p>
                          ) : null}
                        </div>
                      ))
                    )}
                    <button
                      onClick={() => void addComfyWorkflow()}
                      className="flex items-center gap-1.5 rounded-lg border border-[var(--rule)] px-3 py-1.5 text-[12.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink"
                    >
                      <Plus size={13} />
                      Add a workflow…
                    </button>
                    {comfyNote ? <p className="text-[11.5px] leading-snug text-faint">{comfyNote}</p> : null}
                  </div>
                </Field>

                <Field
                  label="fal.ai API key"
                  hint="Create one at fal.ai/dashboard/keys. Stored locally in zen-chat-store.json — never committed, never logged."
                >
                  <div className="flex gap-2">
                    <input
                      className={inputCls}
                      type={showFalKey ? 'text' : 'password'}
                      placeholder="key-id:secret"
                      value={imageGen.falKey || ''}
                      spellCheck={false}
                      onChange={(e) => setImageGen({ falKey: e.target.value })}
                    />
                    <button
                      onClick={() => setShowFalKey((s) => !s)}
                      title={showFalKey ? 'Hide key' : 'Show key'}
                      className="grid h-[38px] w-10 shrink-0 place-items-center rounded-lg border border-[var(--rule)] text-muted transition hover:bg-[var(--raised)] hover:text-ink"
                    >
                      {showFalKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                    <button
                      onClick={loadFalModels}
                      disabled={falBusy || !imageGen.falKey}
                      className="flex h-[38px] shrink-0 items-center gap-1.5 rounded-lg border border-[var(--rule)] px-3 text-[12.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink disabled:opacity-50"
                    >
                      <RefreshCw size={13} className={falBusy ? 'animate-spin' : ''} />
                      Test key &amp; load models
                    </button>
                  </div>
                </Field>

                {falStatus.msg && (
                  <div
                    data-fal-status={falStatus.kind}
                    className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] ${
                      falStatus.kind === 'err'
                        ? 'border-[var(--err-rule)] bg-[var(--err-bg)] text-[var(--err)]'
                        : falStatus.kind === 'ok'
                          ? 'border-[var(--ok)] bg-[var(--app)] text-[var(--ok)]'
                          : 'border-[var(--rule)] bg-[var(--app)] text-muted'
                    }`}
                  >
                    {falStatus.kind === 'err' ? (
                      <TriangleAlert size={13} className="mt-[1px] shrink-0" />
                    ) : (
                      <Check size={13} className="mt-[1px] shrink-0" />
                    )}
                    <span className="min-w-0 flex-1">{falStatus.msg}</span>
                  </div>
                )}

                <Field
                  label="Model"
                  hint={
                    selectedFal
                      ? `${selectedFal.name} · ${selectedFal.category}${
                          selectedFal.pricing ? ` · ${selectedFal.pricing}` : ''
                        }`
                      : 'Load models to choose one — fal lists both text-to-image and image-to-image endpoints.'
                  }
                >
                  <input
                    className={inputCls}
                    placeholder="Filter fal models"
                    value={falFilter}
                    onChange={(e) => setFalFilter(e.target.value)}
                  />
                  {falModels.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="text-[11.5px] text-faint">Sort</span>
                      <div
                        data-fal-sort
                        className="flex overflow-hidden rounded-lg border border-[var(--rule)]"
                      >
                        {(
                          [
                            ['name', 'Name'],
                            ['cheap', 'Price ↑'],
                            ['dear', 'Price ↓'],
                          ] as const
                        ).map(([k, label]) => (
                          <button
                            key={k}
                            onClick={() => setFalSort(k)}
                            data-fal-sort-key={k}
                            title={
                              k === 'name'
                                ? 'The order fal lists them in'
                                : k === 'cheap'
                                  ? 'Cheapest per picture at the selected size first'
                                  : 'Most expensive first'
                            }
                            className={`px-2 py-1 text-[11.5px] transition ${
                              falSort === k
                                ? 'bg-[var(--accent-bg)] text-[var(--accent-soft)]'
                                : 'text-muted hover:bg-[var(--raised)]'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      {falPricesBusy ? (
                        <span className="text-[11.5px] text-faint">prices…</span>
                      ) : null}
                    </div>
                  )}

                  {falModels.length > 0 && (
                    <div
                      data-fal-models
                      className="mt-2 max-h-[210px] divide-y divide-[var(--rule)] overflow-y-auto rounded-xl border border-[var(--rule)]"
                    >
                      {falFiltered.length === 0 && (
                        <div className="px-3 py-3 text-[12.5px] text-faint">No model matches that filter.</div>
                      )}
                      {falFiltered.map((m) => {
                        const on = m.id === imageGen.model
                        return (
                          <button
                            key={m.id}
                            data-fal-model={m.id}
                            data-selected={on ? 'yes' : undefined}
                            onClick={() => setImageGen({ model: m.id })}
                            className={`flex w-full items-center gap-2 px-3 py-2 text-left transition ${
                              on ? 'bg-[var(--accent-bg)]' : 'hover:bg-[var(--raised)]'
                            }`}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="flex items-baseline gap-2">
                                <span className="truncate text-[13px] text-[var(--text-mid)]">{m.name}</span>
                                {/* what it costs, right beside the name — the decision is made here,
                                    not in a panel further down the form */}
                                <span
                                  data-row-price={falPrices[m.id]?.text ? 'yes' : 'no'}
                                  className="shrink-0 text-[11px] text-faint tabular-nums"
                                >
                                  {falPrices[m.id]?.text ||
                                    (falPricesBusy || falPrices[m.id] === undefined ? '' : 'no published price')}
                                </span>
                              </span>
                              <span className="block truncate font-mono text-[10.5px] text-faint">{m.id}</span>
                              {m.pricing && !falPrices[m.id]?.text && (
                                <span className="mt-0.5 block truncate text-[10.5px] text-[var(--text-dim)]">{m.pricing}</span>
                              )}
                            </span>
                            <span className="shrink-0 rounded bg-[var(--raised-2)] px-1.5 py-0.5 text-[9.5px] tracking-wide text-[var(--text-mid)] uppercase">
                              {m.category === 'text-to-image' ? 't2i' : 'i2i'}
                            </span>
                            {on && <Check size={13} className="shrink-0 text-[var(--accent-bright)]" />}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </Field>

                {/* Not a panel of its own any more: the per-endpoint price sits beside each name in
                    the list above. This line carries only what a row cannot say — what the chosen
                    size and count come to. */}
                <div
                  data-fal-cost={falCost?.text ? 'yes' : 'no'}
                  className="text-[11.5px] leading-snug text-faint"
                >
                  {falCost?.text ? (
                    falCost.perImage == null ? (
                      <>
                        Billed by {falCost.text.replace(/^\$[0-9.]+ per /, '')}, so what one image costs
                        depends on the run.
                      </>
                    ) : (
                      <>
                        <span className="text-[var(--text-mid)]">{falCost.text}</span> at the size selected
                        {falCost.megapixels ? ` (${falCost.megapixels} MP — fal rounds part megapixels up)` : ''}
                        {imageGen.count > 1 ? ` · about ${falCost.forCount} for ${imageGen.count} images` : ''}.
                      </>
                    )
                  ) : selectedFal?.pricing ? (
                    <>{selectedFal.pricing}</>
                  ) : (
                    <>fal publishes no rate for this model, so its own page is the only place to check.</>
                  )}
                </div>

                <Field
                  label="Reference edit model"
                  hint="Attach an image with an instruction and your words go straight to this endpoint as the prompt — no chat model in between, nothing re-described."
                >
                  <select
                    data-fal-editmodel
                    className={inputCls}
                    value={imageGen.editModel || 'fal-ai/nano-banana/edit'}
                    onChange={(e) => setImageGen({ editModel: e.target.value })}
                  >
                    {editChoices.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} — {m.id}
                      </option>
                    ))}
                  </select>
                  <div className="mt-1.5 text-[11.5px] text-faint">
                    {falModels.length === 0
                      ? 'Load models above to choose from fal’s image-to-image endpoints.'
                      : `${editChoices.length} endpoint${editChoices.length === 1 ? '' : 's'} here accept a reference image.`}
                  </div>
                  {/* the family decides whether you get your picture back, changed, or a new
                      picture inspired by it. The reliable marker is the reference parameter's
                      style: image-to-image endpoints carry a strength and re-draw; editors
                      (image_urls, no strength) follow the instruction and keep the picture. */}
                  <div data-editmodel-kind className="mt-1.5 text-[11.5px] text-faint">
                    {/image-to-image/i.test(imageGen.editModel || '')
                      ? 'A re-drawing endpoint: it makes a new picture guided by yours, so details drift. The app keeps its strength low (0.85) so your picture survives — for “the same picture, with my change”, a Nano Banana, Kontext or GPT Image edit endpoint follows the instruction exactly.'
                      : 'An instruction editor: it follows what you asked for and keeps the picture you sent. If a result ever comes back looking re-drawn rather than changed, try a Nano Banana or Kontext edit endpoint.'}
                  </div>
                  {imageGen.editModelMovedFrom ? (
                    <div
                      data-editmodel-moved
                      className="mt-2 flex items-start gap-2 rounded-lg border border-[var(--warn)] bg-[var(--warn-bg)] px-2.5 py-2 text-[11.5px] text-[var(--warn)]"
                    >
                      <span className="flex-1">
                        Moved you off {imageGen.editModelMovedFrom}, which re-drew the picture from your
                        words instead of changing it. Switch back in the list above whenever you like.
                      </span>
                      <button
                        onClick={() => setImageGen({ editModelMovedFrom: '' })}
                        title="Understood"
                        className="text-[var(--warn)] transition hover:text-ink"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ) : null}
                </Field>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Images per prompt">
                    <select
                      className={inputCls}
                      value={imageGen.count}
                      onChange={(e) => setImageGen({ count: Number(e.target.value) })}
                    >
                      {[1, 2, 3, 4].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Size" hint="Only applied when the model declares image_size.">
                    <select
                      className={inputCls}
                      value={imageGen.size}
                      onChange={(e) => setImageGen({ size: e.target.value })}
                    >
                      {sizes.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                <div className="rounded-xl border border-[var(--rule)] bg-[var(--app)] p-3">
                  <div className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-muted">
                    <ImageIcon size={13} className="text-faint" /> Test generation
                  </div>
                  <div className="mb-2 text-[11.5px] leading-snug text-faint">
                    Testing the key is free. This button actually draws: 1 image at 512px on the model above, billed by
                    fal.ai at that model's own rate.
                  </div>
                  <button
                    onClick={runTestGeneration}
                    disabled={falBusy || !imageGen.falKey || !imageGen.model}
                    className="flex items-center gap-1.5 rounded-lg border border-[var(--rule)] px-3 py-1.5 text-[12.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink disabled:opacity-50"
                  >
                    <Sparkles size={13} /> Generate one test image
                  </button>
                  {genTest && (
                    <div
                      data-gen-test={genTest.ok ? 'ok' : 'err'}
                      className={`mt-2 flex items-start gap-2.5 rounded-lg border px-3 py-2 text-[12.5px] ${
                        genTest.ok
                          ? 'border-[var(--ok)] bg-[var(--app)] text-[var(--ok)]'
                          : 'border-[var(--err-rule)] bg-[var(--err-bg)] text-[var(--err)]'
                      }`}
                    >
                      {genTest.url ? (
                        <img
                          src={genTest.url}
                          alt="fal.ai test generation"
                          className="h-16 w-16 shrink-0 rounded-lg border border-[var(--rule-soft)] object-cover"
                        />
                      ) : (
                        <TriangleAlert size={13} className="mt-[1px] shrink-0" />
                      )}
                      <span className="min-w-0 flex-1 break-words">{genTest.msg}</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--rule)] bg-[var(--app)] p-3">
                  <div className="min-w-0 text-[11.5px] leading-snug text-faint">
                    Generated images are written as real files beside your store; the chat file keeps only their paths.
                  </div>
                  <button
                    onClick={() => window.zen.images.openFolder()}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--rule)] px-2.5 py-1.5 text-[12.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink"
                  >
                    <FolderOpen size={13} /> Open folder
                  </button>
                </div>
              </div>
            )}

            {tab === 'about' && (
              <div className="space-y-3 text-[13px] text-[var(--text-mid)]">
                <div>
                  <strong className="font-medium">WorkBuro</strong> {info?.version} — a ChatGPT-style Windows client
                  that talks to any OpenAI-compatible endpoint you point it at.
                </div>
                {/* updating from inside the app: check, download, verify, then install or hand over */}
                <UpdatePane config={config} onConfig={onConfig} />
                <div className="rounded-xl border border-[var(--rule)] bg-[var(--app)] p-3">
                  <div className="mb-2 font-medium text-muted">Shortcuts</div>
                  <div className="grid grid-cols-2 gap-y-1.5">
                    {[
                      ['Ctrl + N', 'New chat'],
                      ['Ctrl + B', 'Toggle sidebar'],
                      ['Ctrl + K', 'Search chats'],
                      ['Ctrl + ,', 'Settings'],
                      ['Enter', 'Send'],
                      ['Shift + Enter', 'New line'],
                      ['Esc', 'Stop generating'],
                    ].map(([k, d]) => (
                      <div key={k} className="flex items-center gap-2">
                        <kbd className="rounded border border-[var(--rule)] bg-[var(--raised)] px-1.5 py-0.5 font-mono text-[11px]">
                          {k}
                        </kbd>
                        <span className="text-[12.5px] text-muted">{d}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl border border-[var(--rule)] bg-[var(--app)] p-3">
                  <div className="mb-1 font-medium text-muted">Where your data lives</div>
                  <div className="break-all font-mono text-[11.5px] text-faint">{info?.storePath}</div>
                  <button
                    onClick={() => window.zen.app.openStore()}
                    className="mt-2 flex items-center gap-1.5 rounded-lg border border-[var(--rule)] px-2.5 py-1.5 text-[12.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink"
                  >
                    <FolderOpen size={13} /> Open folder
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
