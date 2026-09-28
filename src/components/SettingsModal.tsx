import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Check,
  Eye,
  EyeOff,
  FolderOpen,
  Globe,
  KeyRound,
  Minimize2,
  RefreshCw,
  HelpCircle,
  TriangleAlert,
  X,
  Zap,
} from 'lucide-react'
import type { Config, ModelInfo, StoreShape } from '../types'
import type { HotkeyStatus } from '../global'

const INSTRUCTION_PRESETS = [
  'Keep it short.',
  'Answer directly.',
  'Be friendly.',
  'Code over prose.',
  'Ask before assuming.',
]

type Tab = 'general' | 'api' | 'chat' | 'models' | 'tools' | 'about'

const TAB_LABELS: Record<Tab, string> = {
  general: 'General',
  api: 'API & key',
  chat: 'Chat',
  models: 'Models',
  tools: 'Tools',
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
          ? 'border-[#4a6fa5] bg-[#1b2634] text-ink'
          : 'border-[#333] bg-[#121212] text-[#e2e2e2] hover:border-[#454545]'
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
      <div className="mb-1.5 text-[12.5px] font-medium text-[#cfcfcf]">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11.5px] leading-snug text-faint">{hint}</div>}
    </label>
  )
}

const inputCls =
  'w-full rounded-lg border border-[#333] bg-[#121212] px-3 py-2 text-[13.5px] text-ink placeholder:text-faint focus:border-[#4a6fa5]'

export default function SettingsModal({
  config,
  models,
  onConfig,
  onModels,
  onClose,
  onProbe,
  probing,
}: {
  config: Config
  models: ModelInfo[]
  onConfig: (patch: Partial<Config>) => void
  onModels: (m: ModelInfo[]) => void
  onClose: () => void
  onProbe: (id: string) => void
  probing: string | null
}) {
  const [tab, setTab] = useState<Tab>('api')
  const [showKey, setShowKey] = useState(false)
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

  useEffect(() => {
    window.zen.tools.list().then(setToolList)
  }, [])

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
    setHotkeyMsg({ ok: true, msg: 'Shortcut cleared — open Zen Chat from the tray instead.' })
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
            ? 'Zen Chat will start with Windows, quietly in the tray.'
            : 'Zen Chat will no longer start with Windows.'
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onMouseDown={onClose}>
      <div
        className="flex max-h-[86vh] w-[740px] flex-col overflow-hidden rounded-2xl border border-[#2c2c2c] bg-[#161616] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#2a2a2a] px-5 py-3.5">
          <h2 className="text-[16px] font-semibold">Settings</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-white/10 hover:text-ink">
            <X size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="w-[150px] shrink-0 border-r border-[#2a2a2a] p-2">
            {(['general', 'api', 'chat', 'models', 'tools', 'about'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`mb-0.5 w-full rounded-lg px-3 py-2 text-left text-[13.5px] transition ${
                  tab === t ? 'bg-white/[.09] text-ink' : 'text-muted hover:bg-white/[.05]'
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
                  label="Summon shortcut"
                  hint="Click the box, then press your combination. It works from anywhere in Windows and toggles Zen Chat open or closed."
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
                              ? 'border-[#4a6fa5] bg-[#1d2836] text-ink'
                              : 'border-[#333] text-muted hover:bg-white/[.06] hover:text-ink'
                          }`}
                        >
                          {p}
                        </button>
                      ))}
                      <button
                        onClick={clearHotkey}
                        className="rounded-md border border-[#333] px-2 py-1 text-[11.5px] text-muted transition hover:bg-white/[.06] hover:text-ink"
                      >
                        Clear
                      </button>
                    </div>
                    {hotkeyMsg && (
                      <div
                        className={`flex items-start gap-1.5 text-[12px] ${
                          hotkeyMsg.ok ? 'text-[#67d68a]' : 'text-[#ff9b9b]'
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
                            <b className="font-mono text-[#e8c98a]">{liveHotkey.active}</b> instead —{' '}
                            <span className="font-mono">{liveHotkey.requested}</span> is held by another app.
                          </>
                        ) : liveHotkey.active ? (
                          <>
                            Live now: press <b className="font-mono text-ink">{liveHotkey.active}</b> anywhere to
                            summon Zen Chat.
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

                <div className="rounded-xl border border-[#2a2a2a] bg-[#121212] p-3">
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={Boolean(loginItem?.openAtLogin)}
                      onChange={(e) => toggleStartup(e.target.checked)}
                      className="mt-0.5 accent-[#2f6feb]"
                    />
                    <span>
                      <span className="block text-[13px] text-[#dcdcdc]">Start Zen Chat when Windows starts</span>
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-faint">
                        Starts quietly in the notification area — nothing steals focus at login. Press your summon
                        shortcut, or click the tray icon, to bring it up.
                      </span>
                    </span>
                  </label>
                </div>

                <Field
                  label="Window"
                  hint="Zen Chat opens small so it can sit over other work. Size and position are remembered between launches."
                >
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={async () => {
                        const b = await window.zen.app.resetBounds()
                        if (b) setHotkeyMsg({ ok: true, msg: `Window reset to ${b.width}×${b.height}.` })
                      }}
                      className="flex items-center gap-1.5 rounded-lg border border-[#333] px-3 py-2 text-[12.5px] text-muted transition hover:bg-white/[.06] hover:text-ink"
                    >
                      <Minimize2 size={13} /> Reset to the default small size
                    </button>
                    <button
                      onClick={() => window.zen.app.hideWindow()}
                      className="flex items-center gap-1.5 rounded-lg border border-[#333] px-3 py-2 text-[12.5px] text-muted transition hover:bg-white/[.06] hover:text-ink"
                    >
                      <EyeOff size={13} /> Hide to tray
                    </button>
                  </div>
                </Field>
              </div>
            )}

            {tab === 'api' && (
              <div className="space-y-4">
                <div>
                  <div className="mb-1.5 text-[12.5px] font-medium text-[#cfcfcf]">Presets</div>
                  <div className="flex flex-wrap gap-2">
                    {config.profiles.map((p) => (
                      <button
                        key={p.name}
                        onClick={() => onConfig({ baseUrl: p.baseUrl, sendAffinity: p.affinity })}
                        className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] transition ${
                          config.baseUrl === p.baseUrl
                            ? 'border-[#4a6fa5] bg-[#1d2836] text-ink'
                            : 'border-[#333] text-muted hover:bg-white/[.06] hover:text-ink'
                        }`}
                      >
                        <Globe size={12} /> {p.name}
                      </button>
                    ))}
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

                <Field label="API key">
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <KeyRound size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
                      <input
                        className={inputCls + ' pl-8 pr-9'}
                        type={showKey ? 'text' : 'password'}
                        value={config.apiKey}
                        spellCheck={false}
                        placeholder="sk-… / oc_sk_…"
                        onChange={(e) => onConfig({ apiKey: e.target.value })}
                      />
                      <button
                        onClick={() => setShowKey((s) => !s)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-ink"
                      >
                        {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>
                </Field>

                <div className="rounded-xl border border-[#2a2a2a] bg-[#121212] p-3">
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={config.sendAffinity}
                      onChange={(e) => onConfig({ sendAffinity: e.target.checked })}
                      className="mt-0.5 accent-[#2f6feb]"
                    />
                    <span>
                      <span className="block text-[13px] text-[#dcdcdc]">Send session affinity header</span>
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
                    className="flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-white transition hover:bg-[#4180f0] disabled:opacity-60"
                  >
                    <Zap size={14} /> Test connection
                  </button>
                  {status.kind !== 'idle' && (
                    <div
                      className={`flex items-center gap-1.5 text-[12.5px] ${
                        status.kind === 'ok' ? 'text-[#67d68a]' : status.kind === 'err' ? 'text-[#ff9b9b]' : 'text-muted'
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
                <div className="rounded-xl border border-[#2a2a2a] bg-[#121212] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] text-[#dcdcdc]">Instructions</span>
                    {Boolean(config.systemPrompt?.trim()) && (
                      <button
                        onClick={() => onConfig({ systemPrompt: '' })}
                        className="shrink-0 text-[11.5px] text-faint transition hover:text-[#ff9b9b]"
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
                        className="rounded-full border border-[#333] px-2 py-1 text-[11.5px] text-muted transition hover:bg-white/[.06] hover:text-ink"
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
                        className="accent-[#2f6feb]"
                      />
                      Stream responses
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        checked={config.thinking}
                        onChange={(e) => onConfig({ thinking: e.target.checked })}
                        className="accent-[#2f6feb]"
                      />
                      Thinking on by default
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        checked={config.showUsage}
                        onChange={(e) => onConfig({ showUsage: e.target.checked })}
                        className="accent-[#2f6feb]"
                      />
                      Show token usage
                    </label>
                  </div>
                </div>
              </div>
            )}

            {tab === 'tools' && (
              <div className="space-y-5">
                <div className="rounded-xl border border-[#2a2a2a] bg-[#121212] p-3">
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={config.toolsEnabled !== false}
                      onChange={(e) => onConfig({ toolsEnabled: e.target.checked })}
                      className="mt-0.5 accent-[#2f6feb]"
                    />
                    <span>
                      <span className="block text-[13px] text-[#dcdcdc]">Let the model use tools</span>
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-faint">
                        Without this, a model can only answer from its training data — no live web, no real-time
                        anything. With it, the model can ask Zen Chat for information and then answer using it.
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
                            className="mt-0.5 accent-[#2f6feb] disabled:opacity-40"
                          />
                          <span className={config.toolsEnabled === false ? 'opacity-50' : ''}>
                            <span className="block text-[13px] text-[#dcdcdc]">{t.label}</span>
                            <span className="mt-0.5 block text-[11.5px] leading-snug text-faint">{t.describe}</span>
                          </span>
                        </label>
                      )
                    })}
                    {!toolList.length && <span className="text-[12px] text-faint">Loading tools…</span>}
                  </div>
                </Field>

                <Field
                  label="Search backend"
                  hint="A SearXNG-compatible JSON endpoint. Your local container on :8888 needs no key and has no query limit — start Docker Desktop if search stops working."
                >
                  <div className="space-y-2">
                    <input
                      value={config.searchUrl || ''}
                      onChange={(e) => onConfig({ searchUrl: e.target.value })}
                      spellCheck={false}
                      placeholder="http://localhost:8888"
                      className="w-full rounded-lg border border-[#333] bg-[#121212] px-3 py-2 font-mono text-[12.5px] text-[#e2e2e2] outline-none focus:border-[#4a6fa5]"
                    />
                    <button
                      disabled={testing}
                      onClick={async () => {
                        setTesting(true)
                        setSearchTest(null)
                        const r = await window.zen.tools.probe(config.searchUrl)
                        setTesting(false)
                        setSearchTest({
                          ok: r.ok,
                          msg: r.ok ? `Search works — ${r.preview.slice(0, 150)}` : r.error || 'Search failed.',
                        })
                      }}
                      className="flex items-center gap-1.5 rounded-lg border border-[#333] px-3 py-2 text-[12.5px] text-muted transition hover:bg-white/[.06] hover:text-ink disabled:opacity-50"
                    >
                      {testing ? <RefreshCw size={13} className="animate-spin" /> : <Globe size={13} />} Test search
                    </button>
                    {searchTest && (
                      <div
                        className={`flex items-start gap-1.5 text-[12px] ${
                          searchTest.ok ? 'text-[#67d68a]' : 'text-[#ff9b9b]'
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
                    className="w-[80px] rounded-lg border border-[#333] bg-[#121212] px-3 py-2 text-[13px] text-[#e2e2e2] outline-none focus:border-[#4a6fa5]"
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
                      className="accent-[#2f6feb]"
                    />
                    <span className="text-[13px] text-[#dcdcdc]">Use the relay's built-in search where available</span>
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
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[#333] px-3 py-2 text-[12.5px] text-muted transition hover:bg-white/[.06] hover:text-ink"
                  >
                    <RefreshCw size={13} /> Reload
                  </button>
                </div>
                <div className="text-[11.5px] leading-snug text-faint">
                  <strong className="font-medium text-muted">Zap</strong> = live test (runs a real call and an image
                  call to detect vision support). Click the eye to override what the app believes about a model.
                </div>
                <div className="divide-y divide-[#232323] overflow-hidden rounded-xl border border-[#2a2a2a]">
                  {filtered.length === 0 && (
                    <div className="px-3 py-4 text-[13px] text-faint">
                      No models loaded. Use <strong>API &amp; key → Test connection</strong>.
                    </div>
                  )}
                  {filtered.map((m) => {
                    const p = config.modelPrefs?.[m.id] || {}
                    return (
                      <div key={m.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-white/[.03]">
                        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-[#dcdcdc]">{m.id}</span>
                        {p.protocol && (
                          <span className="rounded bg-white/10 px-1.5 text-[9.5px] uppercase tracking-wide text-[#bdbdbd]">
                            {p.protocol}
                          </span>
                        )}
                        <button
                          onClick={() => cycleVision(m.id)}
                          title={`Vision: ${p.vision || 'unknown'} (click to change)`}
                          className="grid h-6 w-6 place-items-center rounded text-muted hover:bg-white/10 hover:text-ink"
                        >
                          {p.vision === 'yes' ? (
                            <Eye size={13} className="text-[#67d68a]" />
                          ) : p.vision === 'no' ? (
                            <EyeOff size={13} className="text-[#ff9b9b]" />
                          ) : (
                            <Eye size={13} className="opacity-30" />
                          )}
                        </button>
                        <button
                          onClick={() => onProbe(m.id)}
                          disabled={probing === m.id}
                          className="grid h-6 w-6 place-items-center rounded text-muted hover:bg-white/10 hover:text-ink disabled:opacity-50"
                        >
                          <Zap size={13} className={probing === m.id ? 'animate-pulse text-[#ffd479]' : ''} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {tab === 'about' && (
              <div className="space-y-3 text-[13px] text-[#d2d2d2]">
                <div>
                  <strong className="font-medium">Zen Chat</strong> {info?.version} — a ChatGPT-style Windows client
                  that talks to any OpenAI-compatible endpoint you point it at.
                </div>
                <div className="rounded-xl border border-[#2a2a2a] bg-[#121212] p-3">
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
                        <kbd className="rounded border border-[#3a3a3a] bg-[#1e1e1e] px-1.5 py-0.5 font-mono text-[11px]">
                          {k}
                        </kbd>
                        <span className="text-[12.5px] text-muted">{d}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl border border-[#2a2a2a] bg-[#121212] p-3">
                  <div className="mb-1 font-medium text-muted">Where your data lives</div>
                  <div className="break-all font-mono text-[11.5px] text-faint">{info?.storePath}</div>
                  <button
                    onClick={() => window.zen.app.openStore()}
                    className="mt-2 flex items-center gap-1.5 rounded-lg border border-[#333] px-2.5 py-1.5 text-[12.5px] text-muted transition hover:bg-white/[.06] hover:text-ink"
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
