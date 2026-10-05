import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Image as ImageIcon, Search } from 'lucide-react'
import type { Config } from '../types'

type Price = { text: string; perImage: number | null }

/**
 * The image model, chosen from the top bar beside the chat model — the same place, because it is
 * the same kind of decision. Each name carries what it costs per picture at the size currently
 * selected, in the small text beside it, so the price is visible before anything is drawn.
 *
 * Prices come from fal's own rate for the endpoint (billed per megapixel for most of them) and are
 * only shown where fal publishes one: a model with no published rate says so rather than showing a
 * made-up number.
 */
export default function ImageModelPicker({
  config,
  onChange,
  onConfigure,
  inline,
  field = 'model',
  onPicked,
}: {
  config: Config
  onChange: (id: string) => void
  onConfigure: () => void
  /* Rendered inside someone else's panel: no button of its own, no placement of its own. */
  inline?: boolean
  /* Which model in the config this list is choosing: the one that draws, or the one that edits. */
  field?: 'model' | 'editModel'
  onPicked?: () => void
}) {
  const ig = config.imageGen
  const key = ig?.falKey || ''
  const enabled = Boolean(ig?.enabled)
  const current = (field === 'editModel' ? ig?.editModel : ig?.model) || ''

  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
  const [prices, setPrices] = useState<Record<string, Price>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [size, setSize] = useState<{ width?: number; height?: number }>({})
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (open && box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  // what the selected size costs the rate calculation, from the app's own presets
  useEffect(() => {
    let alive = true
    window.zen.images
      .options()
      .then((r) => {
        if (!alive) return
        const hit = (r?.sizes || []).find((s: { id: string }) => s.id === (ig?.size || 'square_hd'))
        if (hit) setSize({ width: hit.width, height: hit.height })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [ig?.size])

  // the catalogue, and the price of whatever is chosen right now
  useEffect(() => {
    if (!enabled || !key) return
    let alive = true
    setLoading(true)
    window.zen.images
      .models(key, '')
      .then((r) => {
        if (!alive) return
        if (!r?.ok) {
          setError(r?.error || 'Could not load image models from fal.ai.')
          setModels([])
          return
        }
        setError(null)
        setModels((r.models || []).map((m: { id: string; name?: string }) => ({ id: m.id, name: m.name || m.id })))
      })
      .catch((e: Error) => alive && setError(e?.message || 'Could not load image models.'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [enabled, key])

  useEffect(() => {
    if (!enabled || !key || !current) return
    let alive = true
    window.zen.images
      .prices(key, [current], size)
      .then((r) => alive && r?.ok && setPrices((p) => ({ ...p, ...r.prices })))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [enabled, key, current, size])

  useEffect(() => {
    if (!open || !key) return
    let alive = true
    const ids = models.map((m) => m.id)
    window.zen.images
      .prices(key, ids, size)
      .then((r) => alive && r?.ok && setPrices((p) => ({ ...p, ...r.prices })))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open, key, models, size])

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? models.filter((m) => m.id.toLowerCase().includes(s)) : models
  }, [models, q])

  const short = (id: string) => id.replace(/^fal-ai\//, '')
  const priceOf = (id: string) => prices[id]?.text || ''

  // Nothing at all until there is a key: an image model you cannot use is not a choice, and a
  // control that is always there asking for a key is noise in a bar this small.
  if (!key) return null

  if (!enabled) {
    return (
      <button
        onClick={onConfigure}
        data-image-model-off
        title="Image generation is switched off — turn it on in Settings → Images"
        className="flex cursor-default items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-[13.5px] text-[var(--text-faint)]"
      >
        <ImageIcon size={14} />
        <span>Images off</span>
      </button>
    )
  }

  return (
    <div className={inline ? '' : 'relative no-drag'} ref={box}>
      {!inline && (
        <button
          onClick={() => setOpen((o) => !o)}
          data-image-model
          title={
            current
              ? `${field === 'editModel' ? 'Image edit model' : 'Image model'}: ${current}${priceOf(current) ? ` · ${priceOf(current)}` : ''}`
              : field === 'editModel'
                ? 'Choose the model that changes a picture it is given'
                : 'Choose the model that draws pictures'
          }
          className="flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-[13.5px] text-[var(--text-mid)] transition hover:bg-[var(--raised-2)]"
        >
          <ImageIcon size={14} className="shrink-0 text-faint" />
          <span className="max-w-[210px] truncate">
            {current ? short(current) : field === 'editModel' ? 'Choose edit model' : 'Choose image model'}
          </span>
          {current && priceOf(current) ? (
            <span data-image-model-price className="shrink-0 text-[11px] text-faint">
              {priceOf(current)}
            </span>
          ) : null}
          <ChevronDown size={14} className="shrink-0 text-faint" />
        </button>
      )}

      {(inline || open) && (
        <div
          className={
            inline
              ? 'overflow-hidden'
              : 'absolute left-0 top-[38px] z-40 w-[460px] overflow-hidden rounded-2xl border border-[var(--rule)] bg-[var(--raised)] shadow-2xl'
          }
        >
          <div className="flex items-center gap-2 border-b border-[var(--rule)] px-3 py-2">
            <Search size={14} className="text-faint" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search image models"
              className="w-full bg-transparent text-[13.5px] placeholder:text-faint"
            />
            {loading ? <span className="text-[11.5px] text-faint">loading…</span> : null}
          </div>

          <div className="max-h-[340px] overflow-y-auto py-1">
            {error ? (
              <div className="px-3 py-3 text-[13px] text-[var(--err)]">{error}</div>
            ) : list.length === 0 ? (
              <div className="px-3 py-3 text-[13px] text-faint">
                {loading ? 'Loading fal’s catalogue…' : 'No image models matched.'}
              </div>
            ) : (
              <>
                {/* One heading per provider, the same shape the chat model list uses. fal.ai is the
                    only one today; grouping now means a second provider is a new entry in a list
                    rather than a rewrite of the rows. */}
                <div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">
                  fal.ai
                  <span className="ml-1.5 font-normal normal-case tracking-normal opacity-60">{list.length}</span>
                </div>
                {list.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => {
                      onChange(m.id)
                      setOpen(false)
                      onPicked?.()
                    }}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-[var(--raised)]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] text-ink">{short(m.id)}</span>
                      {m.name !== m.id ? (
                        <span className="block truncate text-[11px] text-faint">{m.name}</span>
                      ) : null}
                    </span>
                    <span
                      data-price={priceOf(m.id) ? 'yes' : 'no'}
                      className="shrink-0 text-right text-[11px] text-faint tabular-nums"
                    >
                      {priceOf(m.id) || 'no published price'}
                    </span>
                    {m.id === current ? <span className="shrink-0 text-[11px] text-accent">current</span> : null}
                  </button>
                ))}
              </>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-[var(--rule)] px-3 py-2 text-[11.5px] text-faint">
            <span>Prices are fal’s own rates for the size selected in Settings → Images.</span>
            <button onClick={onConfigure} className="shrink-0 text-[var(--accent-bright)] hover:underline">
              Image settings
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
