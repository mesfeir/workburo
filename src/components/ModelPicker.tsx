import { useEffect, useMemo, useRef, useState } from 'react'
import { Brain, Check, ChevronDown, Eye, EyeOff, RefreshCw, Search, Zap } from 'lucide-react'
import type { Config, ModelInfo } from '../types'

export default function ModelPicker({
  models,
  current,
  config,
  onSelect,
  onRefresh,
  onProbe,
  probingId,
  onConfigure,
}: {
  models: ModelInfo[]
  current: string
  config: Config
  onSelect: (id: string) => void
  onRefresh: () => void
  onProbe: (id: string) => void
  probingId: string | null
  onConfigure: () => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (open && box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? models.filter((m) => m.id.toLowerCase().includes(s)) : models
  }, [models, q])

  return (
    <div className="relative no-drag" ref={box}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[15px] font-medium text-[var(--text-mid)] transition hover:bg-[var(--raised-2)]"
      >
        <span className="max-w-[280px] truncate">{current || 'Select a model'}</span>
        <ChevronDown size={15} className="text-faint" />
      </button>

      {open && (
        <div className="absolute left-0 top-[38px] z-40 w-[350px] overflow-hidden rounded-2xl border border-[var(--rule)] bg-[var(--raised)] shadow-2xl">
          <div className="flex items-center gap-2 border-b border-[var(--rule)] px-3 py-2">
            <Search size={14} className="text-faint" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search models"
              className="w-full bg-transparent text-[13.5px] placeholder:text-faint"
            />
            <button
              onClick={onRefresh}
              title="Refresh model list from the API"
              className="grid h-7 w-7 place-items-center rounded-md text-muted transition hover:bg-[var(--raised-2)] hover:text-ink"
            >
              <RefreshCw size={13} />
            </button>
          </div>

          <div className="max-h-[340px] overflow-y-auto py-1">
            {list.length === 0 && (
              <div className="px-3 py-3 text-[13px] text-faint">
                {models.length === 0 ? (
                  <button onClick={onConfigure} className="text-[var(--accent-bright)] hover:underline">
                    No models loaded — open Settings to test your API
                  </button>
                ) : (
                  'No match.'
                )}
              </div>
            )}
            {list.map((m) => {
              const pref = config.modelPrefs?.[m.id] || {}
              const vision = pref.vision === 'yes'
              const novision = pref.vision === 'no'
              return (
                <div
                  key={m.id}
                  className={`group flex items-center gap-1 px-2 ${
                    m.id === current ? 'bg-[var(--raised-2)]' : 'hover:bg-[var(--raised)]'
                  }`}
                >
                  <button
                    onClick={() => {
                      onSelect(m.id)
                      setOpen(false)
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 px-1 py-2 text-left"
                  >
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-[var(--text-mid)]">{m.id}</span>
                    {vision && (
                      <span title="Takes image input">
                        <Eye size={13} className="text-[var(--ok)]" />
                      </span>
                    )}
                    {novision && (
                      <span title="Text only — will reject images">
                        <EyeOff size={13} className="text-[var(--text-faint)]" />
                      </span>
                    )}
                    {pref.thinking && (
                      <span title="Reasoning model">
                        <Brain size={13} className="text-[var(--accent-bright)]" />
                      </span>
                    )}
                    {pref.protocol === 'responses' && (
                      <span
                        title="Uses the Responses protocol"
                        className="rounded bg-[var(--raised-2)] px-1 text-[9.5px] uppercase tracking-wide text-[var(--text-mid)]"
                      >
                        resp
                      </span>
                    )}
                    {m.id === current && <Check size={14} className="text-[var(--text-dim)]" />}
                  </button>
                  <button
                    onClick={() => onProbe(m.id)}
                    title="Test this model (capabilities + a live call)"
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted opacity-0 transition hover:bg-[var(--raised-2)] hover:text-ink group-hover:opacity-100"
                  >
                    <Zap size={13} className={probingId === m.id ? 'animate-pulse text-[var(--warn)]' : ''} />
                  </button>
                </div>
              )
            })}
          </div>

          <button
            onClick={() => {
              setOpen(false)
              onConfigure()
            }}
            className="flex w-full items-center gap-2 border-t border-[var(--rule)] px-3 py-2 text-left text-[13px] text-muted transition hover:bg-[var(--raised)] hover:text-ink"
          >
            <Zap size={13} /> API &amp; model settings
          </button>
        </div>
      )}
    </div>
  )
}
