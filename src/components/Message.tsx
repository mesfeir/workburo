import { useEffect, useRef, useState } from 'react'
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CloudSun,
  Clock3,
  Copy,
  FileText,
  Globe,
  Link2,
  Loader2,
  RefreshCw,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  Wrench,
} from 'lucide-react'
import Markdown from '../lib/Markdown'
import type { ChatMessage, Source, ToolActivity } from '../types'

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
        <div className="mt-1 border-l-2 border-[#2e2e2e] pl-3 text-[13.5px] leading-[1.65] whitespace-pre-wrap text-[#8f8f8f]">
          {text}
        </div>
      )}
    </div>
  )
}

function ImageGrid({ images }: { images: { url: string; name?: string }[] }) {
  const [zoom, setZoom] = useState<string | null>(null)
  if (!images?.length) return null
  return (
    <>
      <div className={`flex flex-wrap gap-2 ${images.length ? 'mb-2' : ''}`}>
        {images.map((im, i) => (
          <button key={i} onClick={() => setZoom(im.url)} className="overflow-hidden rounded-xl border border-white/10">
            <img src={im.url} alt={im.name || 'attachment'} className="max-h-[220px] max-w-[240px] object-cover" />
          </button>
        ))}
      </div>
      {zoom && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/85 p-8"
          onClick={() => setZoom(null)}
        >
          <img src={zoom} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
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
                failed ? 'text-[#ff9b9b]' : 'text-muted hover:text-ink'
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
              <div className="mt-1 mb-1 border-l-2 border-[#2e2e2e] pl-3 text-[12.5px] leading-[1.6] text-[#8f8f8f]">
                {t.error ? (
                  <span className="text-[#ffb3b3]">{t.error}</span>
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
        <div className="mt-1 space-y-1 border-l-2 border-[#2e2e2e] pl-3">
          {sources.map((s, i) => (
            <a
              key={i}
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className="block truncate text-[12.5px] text-[#7fa8e8] hover:underline"
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

export default function Message({
  msg,
  onRetry,
  showUsage,
}: {
  msg: ChatMessage
  onRetry?: () => void
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
          <ImageGrid images={msg.images || []} />
          {msg.content && <div className="whitespace-pre-wrap">{msg.content}</div>}
        </div>
      </div>
    )
  }

  const waiting = msg.streaming && !msg.content && !msg.reasoning && !(msg.tools || []).length

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

      {waiting && (
        <div className="thinking-dots flex items-center gap-1 py-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-[#8f8f8f]" />
          <span className="h-1.5 w-1.5 rounded-full bg-[#8f8f8f]" />
          <span className="h-1.5 w-1.5 rounded-full bg-[#8f8f8f]" />
        </div>
      )}

      {msg.content && (
        <div className="relative">
          <Markdown text={msg.content} />
          {msg.streaming && (
            <span className="ml-0.5 inline-block h-[15px] w-[8px] translate-y-[2px] animate-blink rounded-[1px] bg-[#d8d8d8]" />
          )}
        </div>
      )}

      {!msg.streaming && <Sources sources={msg.sources || []} />}

      {msg.error && (
        <div
          className="mt-2 flex items-start gap-2.5 rounded-xl border border-[#522020] bg-[#2a1414] px-3.5 py-3 text-[13.5px] text-[#ffb3b3]"
          data-msg-error
        >
          <TriangleAlert size={15} className="mt-[1px] shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Request failed{msg.note ? ` · ${msg.note}` : ''}</div>
            <div className="mt-0.5 break-words text-[#e0a0a0]">{msg.error}</div>
            {onRetry && (
              <button
                onClick={onRetry}
                className="mt-2 flex items-center gap-1.5 rounded-lg border border-[#6b2b2b] px-2.5 py-1 text-[12.5px] text-[#ffc9c9] transition hover:bg-[#3a1c1c]"
              >
                <RefreshCw size={12} /> Try again
              </button>
            )}
          </div>
        </div>
      )}

      {/* hover actions */}
      {!msg.streaming && (msg.content || msg.error) && (
        <div className="mt-1.5 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
          <button
            onClick={copy}
            title="Copy"
            className="grid h-7 w-7 place-items-center rounded-md text-muted transition hover:bg-white/[.08] hover:text-ink"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          {onRetry && (
            <button
              onClick={onRetry}
              title="Regenerate"
              className="grid h-7 w-7 place-items-center rounded-md text-muted transition hover:bg-white/[.08] hover:text-ink"
            >
              <RefreshCw size={14} />
            </button>
          )}
          <button
            onClick={() => setVote(vote === 1 ? null : 1)}
            title="Good response"
            className={`grid h-7 w-7 place-items-center rounded-md transition hover:bg-white/[.08] hover:text-ink ${
              vote === 1 ? 'text-ink' : 'text-muted'
            }`}
          >
            <ThumbsUp size={14} />
          </button>
          <button
            onClick={() => setVote(vote === -1 ? null : -1)}
            title="Bad response"
            className={`grid h-7 w-7 place-items-center rounded-md transition hover:bg-white/[.08] hover:text-ink ${
              vote === -1 ? 'text-ink' : 'text-muted'
            }`}
          >
            <ThumbsDown size={14} />
          </button>
          <span className="ml-1.5 text-[11.5px] text-[#8a8a8a]">
            {msg.model}
            {msg.note ? ` · ${msg.note}` : ''}
            {showUsage && msg.usage
              ? ` · ${msg.usage.prompt} in / ${msg.usage.completion} out${
                  msg.usage.reasoning ? ` (${msg.usage.reasoning} thinking)` : ''
                }`
              : ''}
          </span>
        </div>
      )}
    </div>
  )
}
