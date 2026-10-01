import { useEffect, useMemo, useRef, useState } from 'react'
import { Brain, Check, ChevronDown, Eye, EyeOff, RefreshCw, Search, Zap } from 'lucide-react'
import type { Config, ModelGroup, ModelInfo } from '../types'

/**
 * The model chooser. Every model this machine can actually reach, grouped under the provider it
 * came from, with one search box that spans all of them. Nothing is pre-selected: until you pick,
 * it says so rather than showing a name you never agreed to.
 *
 * Each row hands back the endpoint it belongs to as well as the model, because the group is the
 * thing that knows which provider a model came from.
 */
export default function ModelPicker({
  models,
  groups,
  unavailable,
  current,
  config,
  onSelect,
  onRefresh,
  onProbe,
  probingId,
  onConfigure,
}: {
  models: ModelInfo[]
  groups?: ModelGroup[]
  unavailable?: { provider: string; error?: string }[]
  current: string
  config: Config
  onSelect: (id: string, from?: { baseUrl: string; key?: string; affinity?: boolean }) => void
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

  // What to draw. A caller with no grouping still gets one heading, so the shape of the list never
  // changes under the mouse and there is always somewhere to put the count.
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    const hit = (m: ModelInfo) =>
      !s || m.id.toLowerCase().includes(s) || String(m.provider || '').toLowerCase().includes(s)
    const src: ModelGroup[] = groups && groups.length ? groups : [{ provider: 'This endpoint', baseUrl: '', models }]
    return src.map((g) => ({ ...g, models: g.models.filter(hit) })).filter((g) => g.models.length)
  }, [groups, models, q])

  const total = shown.reduce((n, g) => n + g.models.length, 0)

  return (
    <div className="relative no-drag" ref={box}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-[13.5px] transition hover:bg-[var(--raised-2)]"
      >
        {current ? (
          <span className="max-w-[280px] truncate text-[var(--text-mid)]">{current}</span>
        ) : (
          <span className="text-faint">Select a model</span>
        )}
        <ChevronDown size={14} className="text-faint" />
      </button>

      {open && (
        <div className="absolute left-0 top-[38px] z-40 w-[350px] overflow-hidden rounded-2xl border border-[var(--rule)] bg-[var(--raised)] shadow-2xl">
          <div className="flex items-center gap-2 border-b border-[var(--rule)] px-3 py-2">
            <Search size={14} className="text-faint" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search every model"
              className="w-full bg-transparent text-[13.5px] placeholder:text-faint"
            />
            <button
              onClick={onRefresh}
              title="Look for models again on every endpoint"
              className="grid h-7 w-7 place-items-center rounded-md text-muted transition hover:bg-[var(--raised-2)] hover:text-ink"
            >
              <RefreshCw size={13} />
            </button>
          </div>

          <div className="max-h-[360px] overflow-y-auto pb-1">
            {total === 0 && (
              <div className="px-3 py-3 text-[13px] text-faint">
                {models.length === 0 ? (
                  // An empty list has a reason, and saying it is the difference between a feature
                  // that is waiting for a key and one that looks broken.
                  <span>
                    No models yet. A provider appears here once it has an API key.{' '}
                    <button onClick={onConfigure} className="text-[var(--accent-bright)] hover:underline">
                      Open Settings
                    </button>
                  </span>
                ) : (
                  'No match.'
                )}
              </div>
            )}

            {shown.map((g, i) => (
              // One heading per provider, with empty space above it, so builds never run together.
              <div key={`${g.provider}|${g.baseUrl}`} className={i ? 'mt-3' : ''}>
                <div className="px-3 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">
                  {g.provider}
                  <span className="ml-1.5 font-normal normal-case tracking-normal opacity-60">{g.models.length}</span>
                </div>
                {g.models.map((m) => {
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
                      // The model travels with the endpoint that offers it, its key and whether it wants
                      // affinity. Without that the app stayed on whichever provider it was already
                      // pointed at, so a model chosen from a second provider was sent to the first one
                      // and it failed. Picking the model is now the whole decision: no click on the
                      // provider first, and every provider that has a key is ready.
                      onSelect(
                        m.id,
                        g.baseUrl ? { baseUrl: g.baseUrl, key: g.key, affinity: g.affinity } : undefined,
                      )
                      setOpen(false)
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 px-1 py-2 text-left"
                  >
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-[var(--text-mid)]">{m.id}</span>
                    {/* Who it belongs to, in small text to the right of the name: with several
                        providers in one list, and a search that spans them, the heading above
                        is not always the one you are looking at. */}
                    <span className="shrink-0 text-[10.5px] text-faint">{m.provider || g.provider}</span>
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
            ))}

            {/* Sources with nothing to offer are named once, quietly, so an empty profile reads as an
                empty profile instead of a missing feature. */}
            {unavailable && unavailable.length > 0 && (
              <div className="mt-3 border-t border-[var(--rule)] px-3 py-2 text-[11px] leading-relaxed text-faint">
                {unavailable.map((u) => `${u.provider}: ${u.error || 'no models'}`).join(' · ')}
              </div>
            )}
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
