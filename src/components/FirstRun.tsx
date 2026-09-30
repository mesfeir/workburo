import { useEffect, useState } from 'react'
import { Cpu, KeyRound, PlugZap, RefreshCw } from 'lucide-react'
import type { Config } from '../types'

/**
 * What a brand new install shows.
 *
 * The whole angle is the quick pull-up, and the fastest way to lose it is the first thirty seconds:
 * an empty model picker and a line telling you to open Settings is not a first run, it is homework.
 * So this asks one question, offers exactly three answers, and each answer is one click. The first
 * of them needs no account, no browser and no decision about models.
 *
 * It is deliberately self-contained: the same three things live in Settings for anyone who arrives
 * there later, and this one exists for the person who has just installed the app and does not know
 * what an endpoint is.
 */
export default function FirstRun({
  onConfig,
  onOpenSettings,
  onReady,
}: {
  onConfig: (patch: Partial<Config>) => void
  onOpenSettings: () => void
  /** once something is answering: reload the model list with the config it was just given */
  onReady: (cfg?: Partial<Config>) => void
}) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof window.zen.local.status>> | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ phase: string; got?: number; total?: number; note?: string } | null>(null)
  const [note, setNote] = useState<{ kind: 'idle' | 'ok' | 'err'; msg: string }>({ kind: 'idle', msg: '' })
  const [found, setFound] = useState<{ id: string; label: string; baseUrl: string; models: string[] }[]>([])

  useEffect(() => {
    void (async () => {
      setStatus(await window.zen.local.status())
    })()
  }, [])

  useEffect(() => window.zen.local.onProgress(setProgress), [])

  const size = status?.catalogue?.[0]?.size || '429 MB'
  const label = status?.catalogue?.[0]?.label || 'Qwen3 0.6B'

  const pct = () => {
    if (!progress?.total) return 6
    return Math.max(2, Math.min(99, Math.round(((progress.got || 0) / progress.total) * 100)))
  }
  const mb = (n?: number) => (n ? `${Math.round(n / 1e6)} MB` : '')

  const phaseLabel = () => {
    switch (progress?.phase) {
      case 'runtime':
        return `Getting the runtime · ${mb(progress.got)} of ${mb(progress.total)}`
      case 'unpacking':
        return 'Unpacking it and checking it runs'
      case 'model':
        return `Getting ${label} · ${mb(progress.got)} of ${mb(progress.total)}`
      case 'model-done':
        return 'Checked it. Starting it up'
      default:
        return 'Getting it ready'
    }
  }

  /** Ask the local server what it is serving, and make that the model the app uses. */
  const adoptLocal = async (baseUrl: string) => {
    const r = await window.zen.models.list({ baseUrl, apiKey: '' })
    const first = r?.models?.[0]?.id
    if (!first) {
      setNote({
        kind: 'err',
        msg: `It is running at ${baseUrl}, but it did not report a model name. Open Settings and press the refresh button beside the model picker.`,
      })
      return
    }
    onConfig({ baseUrl, apiKey: '', model: first })
    setNote({ kind: 'ok', msg: `${first} is answering from this machine. Type below.` })
    onReady({ baseUrl, apiKey: '', model: first })
  }

  /** One click: fetch it, start it, and use it. Downloading is the only slow part. */
  const getIt = async () => {
    setBusy(true)
    setNote({ kind: 'idle', msg: '' })
    try {
      const installed = await window.zen.local.install()
      if (installed?.error) {
        setNote({ kind: 'err', msg: installed.error })
        return
      }
      setProgress({ phase: 'unpacking' })
      const started = await window.zen.local.start()
      if (!started?.ok) {
        setNote({ kind: 'err', msg: String(started?.error || 'it downloaded but would not start') })
        return
      }
      await adoptLocal(started.baseUrl || '')
      setStatus(await window.zen.local.status())
    } catch (err: any) {
      setNote({ kind: 'err', msg: String(err?.message || err) })
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const startAgain = async () => {
    setBusy(true)
    setNote({ kind: 'idle', msg: '' })
    try {
      const started = await window.zen.local.start()
      if (!started?.ok) {
        setNote({ kind: 'err', msg: String(started?.error || 'it would not start') })
        return
      }
      await adoptLocal(started.baseUrl || '')
    } finally {
      setBusy(false)
    }
  }

  const lookForIt = async () => {
    setBusy(true)
    try {
      const r = await window.zen.local.detect()
      const list = Array.isArray(r?.found) ? r.found : []
      setFound(list)
      if (!list.length) {
        setNote({
          kind: 'idle',
          msg: 'Nothing answered on 127.0.0.1:1234 or 127.0.0.1:11434. Start LM Studio or Ollama first, then look again.',
        })
      }
    } finally {
      setBusy(false)
    }
  }

  const card =
    'flex flex-col gap-2 rounded-xl border border-[var(--rule)] bg-[var(--app)] p-3.5 text-left transition hover:bg-[var(--raised)]'
  const act =
    'mt-auto flex h-[34px] items-center justify-center gap-1.5 rounded-lg border border-[var(--accent-rule)] bg-[var(--accent-bg)] px-3 text-[12.5px] text-[var(--accent-soft)] transition disabled:opacity-50'

  return (
    <div className="flex h-full flex-col items-center justify-center pb-24">
      <h1 className="mb-2 select-none text-[30px] font-normal tracking-[-0.02em] text-[var(--text)]">
        Ask it anything.
      </h1>
      <p className="mb-7 max-w-[520px] text-center text-[13.5px] leading-snug text-muted">
        Choose how it should answer. None of these need an account, and you can change it later.
      </p>

      <div className="grid w-full max-w-[640px] grid-cols-1 gap-2.5 sm:grid-cols-3">
        <div className={card}>
          <Cpu size={16} className="text-faint" />
          <div className="text-[13.5px] text-ink">Run a model here</div>
          <div className="text-[11.5px] leading-snug text-faint">
            {size}, downloaded once. Answers in about a second after that, with no account and no key.
          </div>
          {status?.ready ? (
            <button onClick={startAgain} disabled={busy} className={act}>
              {busy ? 'Starting…' : 'Start it'}
            </button>
          ) : (
            <button onClick={getIt} disabled={busy} className={act}>
              <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
              {busy ? 'Getting it…' : `Get it · ${size}`}
            </button>
          )}
        </div>

        <div className={card}>
          <KeyRound size={16} className="text-faint" />
          <div className="text-[13.5px] text-ink">Use a key I have</div>
          <div className="text-[11.5px] leading-snug text-faint">
            Any OpenAI-compatible endpoint: a relay, a provider, or your own box.
          </div>
          <button onClick={onOpenSettings} className={act}>
            Open settings
          </button>
        </div>

        <div className={card}>
          <PlugZap size={16} className="text-faint" />
          <div className="text-[13.5px] text-ink">Use what is running</div>
          <div className="text-[11.5px] leading-snug text-faint">
            LM Studio or Ollama, already open on this machine.
          </div>
          {found.length ? (
            <div className="mt-auto space-y-1.5">
              {found.map((f) => (
                <button
                  key={f.id}
                  onClick={() => {
                    onConfig({ baseUrl: f.baseUrl, apiKey: '', ...(f.models[0] ? { model: f.models[0] } : {}) })
                    setNote({ kind: 'ok', msg: `${f.label} is answering from this machine.` })
                    onReady({ baseUrl: f.baseUrl, apiKey: '', ...(f.models[0] ? { model: f.models[0] } : {}) })
                  }}
                  className={act}
                >
                  Use {f.label}
                </button>
              ))}
            </div>
          ) : (
            <button onClick={lookForIt} disabled={busy} className={act}>
              {busy ? 'Looking…' : 'Look for it'}
            </button>
          )}
        </div>
      </div>

      {busy && progress && (
        <div className="mt-5 w-full max-w-[640px]">
          <div className="mb-1.5 text-[11.5px] text-faint">{phaseLabel()}</div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--raised)]">
            <div className="h-full rounded-full bg-[var(--accent-bg)] transition-all" style={{ width: `${pct()}%` }} />
          </div>
        </div>
      )}

      {note.msg && (
        <div
          className={`mt-4 max-w-[640px] break-words text-center text-[12px] leading-snug ${
            note.kind === 'err' ? 'text-[var(--err)]' : 'text-[var(--ok)]'
          }`}
        >
          {note.msg}
        </div>
      )}
    </div>
  )
}
