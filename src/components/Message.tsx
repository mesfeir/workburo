import { useEffect, useRef, useState } from 'react'
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CloudSun,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Globe,
  ImageOff,
  Link2,
  Loader2,
  RefreshCw,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  Wand2,
  Wrench,
} from 'lucide-react'
import Markdown from '../lib/Markdown'
import type { Attachment, ChatMessage, Source, ToolActivity } from '../types'

function Reasoning({ text, streaming, ms }: { text: string; streaming?: boolean; ms?: number }) {
  const [open, setOpen] = useState(false)
  const secs = ms ? Math.max(1, Math.round(ms / 1000)) : null

  // auto-open while it is the only thing happening, so the wait is legible
  useEffect(() => {
    if (streaming && !text.trim()) setOpen(true)
  }, [streaming, text])

  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="group flex items-center gap-1.5 rounded-md py-1 text-[13px] text-muted transition hover:text-ink"
      >
        <Brain size={13} className="text-faint" />
        <span>{secs ? `Thought for ${secs}s` : streaming ? 'Thinking' : 'Thoughts'}</span>
        <ChevronRight size={13} className={`transition ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && text.trim() && (
        <div className="mt-1 border-l-2 border-[var(--rule)] pl-3 text-[13.5px] leading-[1.65] whitespace-pre-wrap text-[var(--text-dim)]">
          {text}
        </div>
      )}
    </div>
  )
}

function ImageGrid({
  images,
  large,
  onUseImage,
}: {
  images: Attachment[]
  large?: boolean
  /** hand this picture to the composer, so the next thing typed changes it rather than drawing
   *  something new — the way to "reply" to a picture that is already in the conversation */
  onUseImage?: (im: Attachment) => void
}) {
  const [zoom, setZoom] = useState<Attachment | null>(null)
  if (!images?.length) return null
  return (
    <>
      <div className={`flex flex-wrap gap-2 ${images.length ? 'mb-2' : ''}`} data-images>
        {images.map((im, i) =>
          !im.url || im.missing ? (
            <div
              key={i}
              data-image-missing
              className="flex h-24 w-44 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-[var(--rule)] px-3 text-center text-[11.5px] text-faint"
            >
              <ImageOff size={15} />
              <span>Image file missing</span>
              <span className="w-full truncate font-mono text-[10px] opacity-70">{im.name}</span>
            </div>
          ) : (
            <div key={i} className="group/img relative">
              <button
                onClick={() => setZoom(im)}
                className="block overflow-hidden rounded-xl border border-[var(--rule-soft)]"
              >
                <img
                  src={im.url}
                  alt={im.name || 'attachment'}
                  width={im.width || undefined}
                  height={im.height || undefined}
                  className={
                    large
                      ? 'max-h-[420px] max-w-[420px] object-contain'
                      : 'max-h-[220px] max-w-[240px] object-cover'
                  }
                />
              </button>
              {im.path && (
                <button
                  onClick={() => window.zen.images.saveAs(im.path as string)}
                  title="Save a copy"
                  className="absolute top-1.5 right-1.5 grid h-7 w-7 place-items-center rounded-lg border border-[var(--rule)] bg-[var(--scrim)] text-[var(--text-solid)] opacity-0 transition group-hover/img:opacity-100"
                >
                  <Download size={13} />
                </button>
              )}
              {onUseImage && (
                <button
                  onClick={() => onUseImage(im)}
                  data-use-image
                  title="Change this picture — it goes into the composer as the reference, then you say what to change"
                  className={`absolute bottom-1.5 left-1.5 flex h-7 items-center gap-1.5 rounded-lg border border-[var(--rule)] bg-[var(--scrim)] px-2 text-[11.5px] text-[var(--text-solid)] transition hover:bg-[var(--scrim)] ${
                    // a picture the assistant drew has no other way back into the conversation, so
                    // its button is always there; a picture you attached is already yours to edit
                    large ? 'opacity-100' : 'opacity-0 group-hover/img:opacity-100'
                  }`}
                >
                  <Wand2 size={12} />
                  Change this image
                </button>
              )}
            </div>
          ),
        )}
      </div>
      {zoom && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-[var(--scrim)] p-8"
          onClick={() => setZoom(null)}
        >
          <img src={zoom.url} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
        </div>
      )}
    </>
  )
}

const TOOL_ICONS: Record<string, typeof Globe> = {
  web_search: Globe,
  fetch_url: FileText,
  get_weather: CloudSun,
  get_time: Clock3,
}

function toolDetail(t: ToolActivity): string {
  const a = t.args || {}
  if (t.query) return String(t.query)
  if (t.name === 'web_search') return String(a.query || '')
  if (t.name === 'fetch_url') return String(a.url || '').replace(/^https?:\/\//, '')
  if (t.name === 'get_weather') return String(a.location || a.city || '')
  if (t.name === 'get_time') return String(a.timezone || 'local time')
  return ''
}

function ToolRun({ tools }: { tools: ToolActivity[] }) {
  const [open, setOpen] = useState<string | null>(null)
  if (!tools?.length) return null
  return (
    <div className="mb-1.5 space-y-0.5" data-tools>
      {tools.map((t) => {
        const Icon = TOOL_ICONS[t.name] || Wrench
        const detail = toolDetail(t)
        const running = t.status === 'running'
        const failed = t.status === 'error'
        const label = t.server ? 'Searched the web' : t.label || t.name
        const canExpand = Boolean(t.preview || t.error)
        return (
          <div key={t.id}>
            <button
              onClick={() => canExpand && setOpen(open === t.id ? null : t.id)}
              className={`flex w-full items-center gap-1.5 rounded-md py-1 text-left text-[13px] transition ${
                failed ? 'text-[var(--err)]' : 'text-muted hover:text-ink'
              }`}
              title={failed ? t.error || '' : detail}
            >
              {running ? (
                <Loader2 size={13} className="shrink-0 animate-spin text-faint" />
              ) : failed ? (
                <TriangleAlert size={13} className="shrink-0" />
              ) : (
                <Icon size={13} className="shrink-0 text-faint" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {label}
                {detail ? `: ${detail}` : ''}
              </span>
              {canExpand && (
                <ChevronDown size={12} className={`shrink-0 text-faint transition ${open === t.id ? 'rotate-180' : ''}`} />
              )}
            </button>
            {open === t.id && (
              <div className="mt-1 mb-1 border-l-2 border-[var(--rule)] pl-3 text-[12.5px] leading-[1.6] text-[var(--text-dim)]">
                {t.error ? (
                  <span className="text-[var(--err)]">{t.error}</span>
                ) : (
                  <span className="whitespace-pre-wrap">{t.preview}</span>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function Sources({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(false)
  if (!sources?.length) return null
  return (
    <div className="mt-2" data-sources>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md py-1 text-[12.5px] text-muted transition hover:text-ink"
      >
        <Link2 size={12} className="text-faint" />
        <span>
          {sources.length} source{sources.length === 1 ? '' : 's'}
        </span>
        <ChevronRight size={12} className={`text-faint transition ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="mt-1 space-y-1 border-l-2 border-[var(--rule)] pl-3">
          {sources.map((s, i) => (
            <a
              key={i}
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className="block truncate text-[12.5px] text-[var(--accent-bright)] hover:underline"
              title={s.url}
            >
              {i + 1}. {s.title || s.url}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

/** A file size a person can read at a glance. */
function fileSize(bytes?: number): string {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** "38.4 tok/s", with a ≈ while it is still an estimate rather than the endpoint's own count. */
function fmtSpeed(speed?: ChatMessage['speed']): string {
  if (!speed || !Number.isFinite(speed.tps) || speed.tps <= 0) return ''
  const n = speed.tps >= 100 ? String(Math.round(speed.tps)) : speed.tps.toFixed(1)
  return `${speed.estimated ? '≈' : ''}${n} tok/s`
}

export default function Message({
  msg,
  onRetry,
  onUseImage,
  showUsage,
}: {
  msg: ChatMessage
  onRetry?: () => void
  onUseImage?: (im: Attachment) => void
  showUsage?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [vote, setVote] = useState<1 | -1 | null>(null)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(msg.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {}
  }

  if (msg.role === 'user') {
    return (
      <div className="flex animate-fade-up justify-end py-2" data-user={msg.id}>
        <div className="max-w-[85%] rounded-[22px] bg-bubble px-4 py-2.5 text-[15.5px] leading-[1.6]">
          <ImageGrid images={msg.images || []} onUseImage={onUseImage} />
          {(msg.documents || []).length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2" data-msg-documents>
              {(msg.documents || []).map((d, i) => (
                <div
                  key={`${d.name}-${i}`}
                  title={d.preview || d.name}
                  className={`flex max-w-[300px] items-center gap-2 rounded-lg border px-2 py-1 ${
                    d.error ? 'border-red-400/40 bg-red-500/10' : 'border-[var(--rule-soft)] bg-[var(--raised)]'
                  }`}
                >
                  <FileText size={14} className="shrink-0 text-faint" />
                  <span className="min-w-0 truncate text-[12px] text-[var(--text-mid)]">{d.name}</span>
                  <span className="shrink-0 text-[11px] text-faint">
                    {d.error ? 'could not be read' : d.chars ? `${d.chars.toLocaleString()} chars` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
          {msg.content && <div className="whitespace-pre-wrap">{msg.content}</div>}
        </div>
      </div>
    )
  }

  const waiting = msg.streaming && !msg.content && !msg.reasoning && !(msg.tools || []).length

  /**
   * A picture being drawn by the Image switch: not a stream, no content yet, and fal reporting
   * phases on the note. It gets a state of its own — the phase in words, with movement — because
   * this row previously sat empty apart from whatever the last progress event happened to say,
   * and a bare queue number told the user nothing was happening.
   */
  /**
   * A picture being drawn, from either door.
   *
   * The Image switch starts a message of its own: not streaming, with a note — which is exactly what
   * this used to require. The model's generate_image tool draws *inside* a streaming answer, so that
   * test could never be true for it, and progress arriving was not enough: the row stayed hidden.
   * `msg.drawing` is the explicit signal both doors now set.
   */
  const drawing =
    !msg.finished &&
    !(msg.images || []).length &&
    !msg.error &&
    (!!msg.drawing || (!msg.streaming && !msg.content && /^fal\b/i.test(String(msg.note || ''))))
  const drawingPhase =
    String(msg.note || '')
      .replace(/^fal\s*(·\s*)?/i, '')
      .trim()
      // never show a bare number, whatever the endpoint reports
      .replace(/^-?[0-9]+$/, '') || 'starting'
  // Which wording: a change to a picture that already exists, or a fresh draw. The tool path knows
  // from the reference it was handed; the switch path has to read it off the endpoint's name.
  const drawingEdit = !!msg.drawingEdit || /\/edit$|-edit$/.test(String(msg.model || ''))

  return (
    <div
      className="group animate-fade-up py-2"
      data-msg={msg.id}
      data-streaming={msg.streaming ? 'yes' : undefined}
    >
      {(msg.reasoning || waiting) && (
        <Reasoning text={msg.reasoning || ''} streaming={msg.streaming} ms={msg.elapsedMs} />
      )}

      <ToolRun tools={msg.tools || []} />

      {/* generated images come back as their own attachment, above the text */}
      {!!(msg.images || []).length && (
        <ImageGrid images={msg.images || []} large onUseImage={onUseImage} />
      )}

      {waiting && (
        <div className="thinking-dots flex items-center gap-1 py-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-dim)]" />
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-dim)]" />
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-dim)]" />
        </div>
      )}

      {drawing && (
        <div
          data-drawing={drawingEdit ? 'edit' : 'create'}
          className="mt-0.5 flex w-fit items-center gap-3 rounded-2xl border border-[var(--rule-soft)] bg-[var(--raised)] py-2.5 pr-5 pl-2.5"
        >
          <span className="drawing-tile" aria-hidden />
          <span className="drawing-body">
            <span className="drawing-title">
              {drawingEdit ? 'Changing the image…' : 'Creating the image…'}
            </span>
            <span className="drawing-phase" data-drawing-phase>
              {drawingPhase}
            </span>
          </span>
        </div>
      )}

      {msg.content && (
        <div className="relative">
          <Markdown text={msg.content} streaming={msg.streaming} />
          {msg.streaming && (
            <span className="ml-0.5 inline-block h-[15px] w-[8px] translate-y-[2px] animate-blink rounded-[1px] bg-[var(--text-mid)]" />
          )}
        </div>
      )}

      {(msg.files || []).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2" data-msg-files>
          {(msg.files || []).map((f, i) => (
            <div
              key={`${f.path}-${i}`}
              className="flex items-center gap-2 rounded-xl border border-[var(--rule-soft)] bg-[var(--raised)] py-2 pl-2.5 pr-2"
              title={f.path}
            >
              {f.kind === 'xlsx' || f.kind === 'csv' ? (
                <FileSpreadsheet size={16} className="shrink-0 text-[var(--ok)]" />
              ) : (
                <FileText size={16} className="shrink-0 text-[var(--accent-bright)]" />
              )}
              <div className="min-w-0">
                <div className="truncate text-[12.5px] text-[var(--text-mid)]">{f.name}</div>
                <div className="text-[11px] text-faint">
                  {f.kind.toUpperCase()} · {fileSize(f.bytes)}
                </div>
              </div>
              <button
                onClick={() => void window.zen.files.open(f.path)}
                data-open-file={f.name}
                title="Open it"
                className="ml-1 flex items-center gap-1 rounded-lg border border-[var(--rule-soft)] px-2 py-1 text-[11.5px] text-[var(--text-mid)] transition hover:bg-[var(--raised-2)]"
              >
                <ExternalLink size={12} /> Open
              </button>
              <button
                onClick={() => void window.zen.files.reveal(f.path)}
                data-reveal-file={f.name}
                title="Show it in the folder"
                className="rounded-lg border border-[var(--rule-soft)] px-2 py-1 text-[var(--text-mid)] transition hover:bg-[var(--raised-2)]"
              >
                <FolderOpen size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {!msg.streaming && <Sources sources={msg.sources || []} />}

      {msg.error && (
        <div
          className="mt-2 flex items-start gap-2.5 rounded-xl border border-[var(--err-rule)] bg-[var(--err-bg)] px-3.5 py-3 text-[13.5px] text-[var(--err)]"
          data-msg-error
        >
          <TriangleAlert size={15} className="mt-[1px] shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Request failed{msg.note ? ` · ${msg.note}` : ''}</div>
            <div className="mt-0.5 break-words text-[var(--err)]">{msg.error}</div>
            {onRetry && (
              <button
                onClick={onRetry}
                className="mt-2 flex items-center gap-1.5 rounded-lg border border-[var(--err-rule)] px-2.5 py-1 text-[12.5px] text-[var(--err)] transition hover:bg-[var(--err-bg)]"
              >
                <RefreshCw size={12} /> Try again
              </button>
            )}
          </div>
        </div>
      )}

      {/* hover actions — the `!!` is load-bearing: without it this chain evaluates to the *number*
          0 while a picture is being drawn (no content, no error, no images yet), and React renders
          a falsy value that is a number. That bare "0" sat in the message row and is what the user
          kept seeing when they pressed the Image button. */}
      {!msg.streaming && !!(msg.content || msg.error || (msg.images || []).length) && (
        <div className="mt-1.5 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
          <button
            onClick={copy}
            title="Copy"
            className="grid h-7 w-7 place-items-center rounded-md text-muted transition hover:bg-[var(--raised-2)] hover:text-ink"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          {onRetry && (
            <button
              onClick={onRetry}
              title="Regenerate"
              className="grid h-7 w-7 place-items-center rounded-md text-muted transition hover:bg-[var(--raised-2)] hover:text-ink"
            >
              <RefreshCw size={14} />
            </button>
          )}
          <button
            onClick={() => setVote(vote === 1 ? null : 1)}
            title="Good response"
            className={`grid h-7 w-7 place-items-center rounded-md transition hover:bg-[var(--raised-2)] hover:text-ink ${
              vote === 1 ? 'text-ink' : 'text-muted'
            }`}
          >
            <ThumbsUp size={14} />
          </button>
          <button
            onClick={() => setVote(vote === -1 ? null : -1)}
            title="Bad response"
            className={`grid h-7 w-7 place-items-center rounded-md transition hover:bg-[var(--raised-2)] hover:text-ink ${
              vote === -1 ? 'text-ink' : 'text-muted'
            }`}
          >
            <ThumbsDown size={14} />
          </button>
          <span className="ml-1.5 text-[11.5px] text-[var(--text-dim)]">
            {msg.model}
            {/* Not `msg.note` while a picture is being drawn: that note is fal's own line, e.g.
                "Waiting in the queue… 0", and printing it here put a bare queue number on screen —
                which is exactly the "0" the user kept seeing. The drawing row above already says
                the phase in words, so the number is never shown on its own. */}
            {!drawing && msg.note ? ` · ${msg.note}` : ''}
            {showUsage && msg.usage
              ? ` · ${msg.usage.prompt} in / ${msg.usage.completion} out${
                  msg.usage.reasoning ? ` (${msg.usage.reasoning} thinking)` : ''
                }`
              : ''}
            {fmtSpeed(msg.speed) ? ` · ${fmtSpeed(msg.speed)}` : ''}
          </span>
        </div>
      )}
    </div>
  )
}
