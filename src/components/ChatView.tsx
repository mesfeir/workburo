import { useEffect, useRef, useState } from 'react'
import { ArrowDown, Sparkles } from 'lucide-react'
import Message from './Message'
import type { Attachment, Conversation, Config } from '../types'

const SUGGESTIONS = [
  'Explain this code and find the bug',
  'Summarise the image I attach',
  'Write a regex for UK postcodes',
  'Compare two API design approaches',
]

/** shown instead of the chat prompts while image mode is armed */
const IMAGE_SUGGESTIONS = [
  'A red fox asleep in falling snow, cinematic',
  'Isometric cutaway of a tiny workshop, warm light',
  'A seaside town at golden hour, film grain',
  'Bold poster: geometric shapes, three colours',
]

/** a tick on the right-hand rail: one of your own messages, and where it sits */
interface Mark {
  id: string
  ratio: number
  label: string
}

function EmptyState({ onPick, imageMode }: { onPick: (t: string) => void; imageMode?: boolean }) {
  const list = imageMode ? IMAGE_SUGGESTIONS : SUGGESTIONS
  return (
    <div className="flex h-full flex-col items-center justify-center pb-24">
      <h1 className="mb-8 select-none text-[30px] font-normal tracking-[-0.02em] text-[#f2f2f2]">
        {imageMode ? 'What should I draw?' : 'Ready when you are.'}
      </h1>
      <div className="grid w-full max-w-[560px] grid-cols-1 gap-2 sm:grid-cols-2">
        {list.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="flex items-start gap-2.5 rounded-xl border border-[#242424] bg-[#131313] px-3.5 py-3 text-left text-[13.5px] text-[#c3c3c3] transition hover:border-[#333] hover:bg-[#1a1a1a]"
          >
            <Sparkles size={14} className="mt-0.5 shrink-0 text-faint" />
            <span>{s}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export default function ChatView({
  conversation,
  config,
  imageMode,
  onRetry,
  onPickSuggestion,
  onUseImage,
}: {
  conversation: Conversation | null
  config: Config
  /** composer is aimed at the image generator */
  imageMode?: boolean
  onRetry: (messageId: string) => void
  onPickSuggestion: (text: string) => void
  /** put a picture from the transcript into the composer so the next message changes it */
  onUseImage: (im: Attachment) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(false)
  const stuckRef = useRef(false)
  stuckRef.current = stuck
  // ignore the scroll events our own scroll-to-bottom produces, or they latch "stuck"
  const lastPin = useRef(0)
  // markers on the right edge: one per message you sent, click to jump there
  const [rail, setRail] = useState<{ marks: Mark[]; overflowing: boolean }>({ marks: [], overflowing: false })
  const [hover, setHover] = useState<string | null>(null)

  const last = conversation?.messages[conversation.messages.length - 1]
  const sig = (last?.content?.length || 0) + (last?.reasoning?.length || 0)
  const count = conversation?.messages.length || 0

  const measure = () => {
    const el = scroller.current
    const inner = el?.firstElementChild as HTMLElement | null
    if (!el || !inner) return
    const nodes = Array.from(inner.querySelectorAll('[data-user]')) as HTMLElement[]
    const base = inner.getBoundingClientRect().top
    const total = inner.scrollHeight || 1
    const marks: Mark[] = nodes.map((n) => ({
      id: n.getAttribute('data-user') || '',
      ratio: Math.min(Math.max((n.getBoundingClientRect().top - base) / total, 0), 1),
      label:
        (n.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 110) ||
        (n.querySelector('img') ? '[Image]' : 'Your message'),
    }))
    const overflowing = el.scrollHeight - el.clientHeight > 8
    setRail((prev) => {
      const same =
        prev.overflowing === overflowing &&
        prev.marks.length === marks.length &&
        prev.marks.every((m, i) => m.id === marks[i].id && Math.abs(m.ratio - marks[i].ratio) < 0.001)
      return same ? prev : { marks, overflowing }
    })
  }
  const measureRef = useRef(measure)
  measureRef.current = measure

  const jumpTo = (id: string) => {
    const el = scroller.current
    const inner = el?.firstElementChild as HTMLElement | null
    if (!el || !inner) return
    const nodes = Array.from(inner.querySelectorAll('[data-user]')) as HTMLElement[]
    const node = nodes.find((n) => n.getAttribute('data-user') === id)
    if (!node) return
    const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top
    lastPin.current = Date.now()
    el.scrollTo({ top: Math.max(el.scrollTop + delta - 16, 0), behavior: 'smooth' })
  }

  const pin = () => {
    const el = scroller.current
    if (!el) return
    lastPin.current = Date.now()
    el.scrollTop = el.scrollHeight
  }

  // a new turn, or a different conversation, always re-anchors to the newest message
  const prev = useRef({ id: '', count: 0 })
  useEffect(() => {
    const changedChat = prev.current.id !== (conversation?.id || '')
    const grew = count > prev.current.count
    prev.current = { id: conversation?.id || '', count }
    if (changedChat || grew) {
      setStuck(false)
      pin()
      requestAnimationFrame(pin)
    }
  }, [conversation?.id, count])

  // follow the stream, but never yank the view if the user scrolled up
  useEffect(() => {
    if (!stuck) pin()
  }, [sig, stuck])

  // late layout — images decoding, code highlighting — must not strand the view
  useEffect(() => {
    const el = scroller.current
    const inner = el?.firstElementChild
    if (!el || !inner || typeof ResizeObserver === 'undefined') return
    let queued = false
    const ro = new ResizeObserver(() => {
      if (!stuckRef.current) {
        lastPin.current = Date.now()
        el.scrollTop = el.scrollHeight
      }
      // content height moved, so the rail markers moved with it
      if (!queued) {
        queued = true
        requestAnimationFrame(() => {
          queued = false
          measureRef.current()
        })
      }
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [conversation?.id])

  // the rail tracks your inputs as the transcript grows, reflows or is resized
  useEffect(() => {
    measureRef.current()
    const onResize = () => measureRef.current()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [conversation?.id, count, sig])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    if (Date.now() - lastPin.current < 250) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    setStuck(!near)
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto">
        {!conversation || conversation.messages.length === 0 ? (
          <EmptyState onPick={onPickSuggestion} imageMode={imageMode} />
        ) : (
          <div className="mx-auto w-full max-w-[768px] px-4 py-6">
            {conversation.messages.map((m) => (
              <Message
                key={m.id}
                msg={m}
                showUsage={Boolean(config.showUsage)}
                onRetry={m.role === 'assistant' ? () => onRetry(m.id) : undefined}
                onUseImage={onUseImage}
              />
            ))}
            <div className="h-6" />
          </div>
        )}
      </div>

      {rail.overflowing && rail.marks.length > 1 && (
        <div className="pointer-events-none absolute top-0 right-2.5 bottom-0 z-10 w-4" data-rail>
          <div className="relative h-full w-full">
            {rail.marks.map((m) => (
              <button
                key={m.id}
                data-mark={m.id}
                aria-label={`Jump to your message: ${m.label}`}
                style={{ top: `${m.ratio * 100}%` }}
                onMouseEnter={() => setHover(m.id)}
                onMouseLeave={() => setHover((h) => (h === m.id ? null : h))}
                onClick={() => jumpTo(m.id)}
                className="pointer-events-auto absolute right-0 flex h-3 w-4 -translate-y-1/2 items-center justify-end"
              >
                <span
                  className={`block h-[3px] rounded-full transition-all duration-150 ${
                    hover === m.id ? 'w-4 bg-[#8ab4f8]' : 'w-2.5 bg-[#4a4a4a] hover:bg-[#8ab4f8]'
                  }`}
                />
              </button>
            ))}
            {hover &&
              (() => {
                const m = rail.marks.find((x) => x.id === hover)
                if (!m?.label) return null
                return (
                  <div
                    style={{ top: `${m.ratio * 100}%` }}
                    className="pointer-events-none absolute right-6 w-[220px] -translate-y-1/2 rounded-lg border border-[#333] bg-[#1c1c1c] px-2.5 py-1.5 text-[12px] leading-snug text-[#dcdcdc] shadow-xl"
                  >
                    <span className="line-clamp-3">{m.label}</span>
                  </div>
                )
              })()}
          </div>
        </div>
      )}

      {stuck && (
        <button
          onClick={() => {
            const el = scroller.current
            if (el) el.scrollTop = el.scrollHeight
            setStuck(false)
          }}
          className="absolute bottom-3 left-1/2 grid h-8 w-8 -translate-x-1/2 place-items-center rounded-full border border-[#333] bg-[#1c1c1c] text-muted shadow-lg transition hover:text-ink"
        >
          <ArrowDown size={15} />
        </button>
      )}
    </div>
  )
}
