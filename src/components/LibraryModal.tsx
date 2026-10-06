import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, FolderOpen, ImageOff, Loader2, RefreshCw, Search, X } from 'lucide-react'

/**
 * Everything this app has made or been handed, read off disk.
 *
 * It used to be the pictures folder alone, which made the Library look like a gallery and made the
 * folder button look like the whole of it: a document the app wrote, a file attached to the agent
 * and a file sent from the phone were all invisible, because none of them live in that folder. Now
 * every folder the app writes to is listed, and each file says which one it came from.
 *
 * The point is still that it is the folders, not the conversations. A file stays after its chat is
 * deleted, and a file put in one of these folders by hand shows up here too.
 *
 * Previews are fetched a few at a time rather than all at once: each one crosses the IPC boundary as
 * a data URL, so loading the lot would stall the window to show pictures nobody has scrolled to.
 */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg'])
const SHOWN_AT_ONCE = 24
const PREVIEW_BATCH = 6

type LibSource = { id: string; label: string; dir: string; count: number }
type OutFile = {
  name: string
  path: string
  size: number
  mtime: number
  ext: string
  source: string
  sourceLabel: string
}

function ago(ms: number) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} d ago`
  return new Date(ms).toLocaleDateString()
}

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function LibraryModal({ onClose }: { onClose: () => void }) {
  const [sources, setSources] = useState<LibSource[]>([])
  const [files, setFiles] = useState<OutFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [where, setWhere] = useState('all')
  const [shown, setShown] = useState(SHOWN_AT_ONCE)
  const [urls, setUrls] = useState<Record<string, string>>({})
  const asked = useRef(new Set<string>())

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await window.zen.library.files()
      if (!res?.ok) throw new Error(res?.error || 'Could not read the folders')
      setSources(res.sources || [])
      setFiles(res.files || [])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])

  /* Files this app has written, and only those — a source with no folder yet has nothing to show. */
  const real = useMemo(() => sources.filter((s) => s.dir), [sources])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return files.filter((f) => {
      if (where !== 'all' && f.source !== where) return false
      if (needle && !f.name.toLowerCase().includes(needle)) return false
      return true
    })
  }, [files, q, where])

  const visible = filtered.slice(0, shown)

  /* The folder the button opens: the one being looked at, or the pictures folder for "everything". */
  const activeDir = where === 'all' ? '' : real.find((s) => s.id === where)?.dir || ''

  /* Fetch previews for what is on screen, a few at a time, and never twice for the same file. */
  useEffect(() => {
    const want = visible.filter((f) => IMAGE_EXT.has(f.ext) && !asked.current.has(f.path))
    if (want.length === 0) return
    let cancelled = false
    ;(async () => {
      for (let i = 0; i < want.length; i += PREVIEW_BATCH) {
        if (cancelled) return
        const batch = want.slice(i, i + PREVIEW_BATCH)
        await Promise.all(
          batch.map(async (f) => {
            asked.current.add(f.path)
            try {
              const r = await window.zen.images.dataUrl(f.path)
              if (!cancelled && r?.ok && r.url) setUrls((prev) => ({ ...prev, [f.path]: r.url as string }))
            } catch {
              // a file that cannot be read is shown as a name and an icon, which is still true
            }
          }),
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [visible])

  const openFile = (f: OutFile) => void window.zen.files.open(f.path)
  const revealFile = (f: OutFile) => void window.zen.files.reveal(f.path)

  const chip = (id: string, label: string, count: number) => {
    const on = where === id
    return (
      <button
        key={id}
        data-library-source={id}
        onClick={() => {
          setWhere(id)
          setShown(SHOWN_AT_ONCE)
        }}
        className={`shrink-0 rounded-full border px-2.5 py-1 text-[12px] transition ${
          on
            ? 'border-[var(--accent)] bg-[var(--raised-2)] text-ink'
            : 'border-[var(--rule)] text-muted hover:bg-[var(--raised-2)] hover:text-ink'
        }`}
      >
        {label} <span className="text-faint">{count}</span>
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3" onMouseDown={onClose}>
      <div
        data-library
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-[min(88vh,760px)] w-[min(96vw,860px)] flex-col overflow-hidden rounded-3xl border border-[var(--rule)] bg-[var(--app)] shadow-2xl"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--rule)] px-4 py-3">
          <h2 className="text-[15px] text-ink">Library</h2>
          <span data-library-count className="text-[12px] text-faint">
            {loading ? 'reading…' : `${filtered.length} file${filtered.length === 1 ? '' : 's'}`}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <div className="flex items-center gap-1.5 rounded-lg bg-[var(--raised)] px-2 py-1">
              <Search size={13} className="text-faint" />
              <input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value)
                  setShown(SHOWN_AT_ONCE)
                }}
                placeholder="Find a file"
                className="w-[130px] bg-transparent text-[12.5px] placeholder:text-faint"
              />
            </div>
            <button
              onClick={() => void load()}
              title="Read the folders again"
              className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-[var(--raised-2)] hover:text-ink"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={() =>
                void (activeDir ? window.zen.library.openFolder(activeDir) : window.zen.images.openFolder())
              }
              title={activeDir ? `Open ${activeDir}` : 'Open the pictures folder'}
              className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-muted transition hover:bg-[var(--raised-2)] hover:text-ink"
            >
              <FolderOpen size={14} /> Folder
            </button>
            <button
              onClick={onClose}
              className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-[var(--raised-2)] hover:text-ink"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* where each file came from — the app writes to four different folders */}
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-[var(--rule)] px-4 py-2">
          {chip('all', 'Everything', files.length)}
          {real.map((s) => chip(s.id, s.label, s.count))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error && <p className="text-[13px] text-[var(--text-dim)]">{error}</p>}

          {!error && !loading && files.length === 0 && (
            <p className="py-10 text-center text-[13px] text-faint">
              Nothing here yet. Pictures you generate, documents it writes, files you attach and files
              your phone sends all show up here.
            </p>
          )}

          {!error && files.length > 0 && filtered.length === 0 && (
            <p className="py-10 text-center text-[13px] text-faint">
              {q ? <>No file matches “{q}”.</> : <>Nothing in this folder yet.</>}
            </p>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {visible.map((f) => (
              <div
                key={f.path}
                data-library-file={f.name}
                className="group overflow-hidden rounded-2xl border border-[var(--rule)] bg-[var(--raised)]"
              >
                <button
                  onClick={() => openFile(f)}
                  title={`Open ${f.name}`}
                  className="block h-[124px] w-full overflow-hidden bg-[var(--raised-2)]"
                >
                  {IMAGE_EXT.has(f.ext) ? (
                    urls[f.path] ? (
                      <img src={urls[f.path]} alt={f.name} className="h-full w-full object-cover" />
                    ) : (
                      <span className="grid h-full w-full place-items-center text-faint">
                        <Loader2 size={16} className="animate-spin" />
                      </span>
                    )
                  ) : (
                    <span className="grid h-full w-full place-items-center gap-1 text-faint">
                      <ImageOff size={18} />
                      <span className="text-[11px] uppercase">{f.ext || 'file'}</span>
                    </span>
                  )}
                </button>
                <div className="flex items-center gap-1 px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] text-[var(--text-mid)]" title={f.name}>
                      {f.name}
                    </p>
                    <p className="text-[10.5px] text-faint">
                      {size(f.size)} · {ago(f.mtime)}
                      {where === 'all' ? ` · ${f.sourceLabel}` : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => revealFile(f)}
                    title="Show in folder"
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted opacity-0 transition hover:bg-[var(--raised-2)] hover:text-ink group-hover:opacity-100"
                  >
                    <ExternalLink size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {filtered.length > shown && (
            <div className="mt-4 flex justify-center">
              <button
                onClick={() => setShown((n) => n + SHOWN_AT_ONCE)}
                className="rounded-full border border-[var(--rule)] px-3 py-1.5 text-[12.5px] text-muted transition hover:bg-[var(--raised-2)] hover:text-ink"
              >
                Show {Math.min(SHOWN_AT_ONCE, filtered.length - shown)} more
              </button>
            </div>
          )}
        </div>

        <div className="shrink-0 truncate border-t border-[var(--rule)] px-4 py-2 text-[11px] text-faint">
          {activeDir || real.map((s) => s.dir).join('  ·  ')}
        </div>
      </div>
    </div>
  )
}
