import { useEffect, useRef } from 'react'
import { ArrowUp, Brain, Image as ImageIcon, Mic, Plus, Square, X } from 'lucide-react'
import type { Attachment } from '../types'

export default function Composer({
  value,
  onChange,
  onSend,
  onStop,
  images,
  onAddImages,
  onPickImages,
  onRemoveImage,
  busy,
  thinking,
  onToggleThinking,
  imageMode,
  onToggleImageMode,
  imageModeAvailable,
  refEdit,
  onSetRefEdit,
  modelLabel,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  onStop: () => void
  images: Attachment[]
  onAddImages: (a: Attachment[]) => void
  onPickImages: () => void
  onRemoveImage: (i: number) => void
  busy: boolean
  thinking: boolean
  onToggleThinking: () => void
  /** send the next prompt to the image generator instead of the chat model */
  imageMode: boolean
  onToggleImageMode: () => void
  /** only offered when a hosted image provider is configured and switched on */
  imageModeAvailable: boolean
  /** with a reference attached: edit it at fal, or let the model read it */
  refEdit: boolean
  onSetRefEdit: (v: boolean) => void
  modelLabel: string
  disabled?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // auto-grow the textarea like the real app
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.min(el.scrollHeight, 208) + 'px'
  }, [value])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onPaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items || [])
      const files = items.filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile())
      const real = files.filter(Boolean) as File[]
      if (!real.length) return
      e.preventDefault()
      Promise.all(
        real.map(
          (f) =>
            new Promise<Attachment>((resolve) => {
              const r = new FileReader()
              r.onload = () => resolve({ name: f.name || 'pasted.png', url: String(r.result) })
              r.readAsDataURL(f)
            }),
        ),
      ).then(onAddImages)
    }
    el.addEventListener('paste', onPaste)
    return () => el.removeEventListener('paste', onPaste)
  }, [onAddImages])

  const canSend = (value.trim().length > 0 || images.length > 0) && !disabled

  return (
    <div className="px-4 pb-2">
      <div className="mx-auto w-full max-w-[768px]">
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
            {images.map((im, i) => (
              <div key={i} className="group relative">
                <img
                  src={im.url}
                  alt={im.name}
                  className="h-16 w-16 rounded-xl border border-white/15 object-cover"
                />
                <button
                  onClick={() => onRemoveImage(i)}
                  className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-[#3a3a3a] bg-[#111] text-muted transition hover:text-ink"
                >
                  <X size={11} />
                </button>
              </div>
            ))}

            {/* what happens to the reference: fal edits it, or the model reads it */}
            <div data-refmode className="flex items-center gap-0.5 rounded-full border border-white/15 p-0.5">
              <button
                onClick={() => onSetRefEdit(true)}
                title="Send this image and your words straight to fal.ai to be changed"
                className={`rounded-full px-2.5 py-1 text-[12px] transition ${
                  refEdit ? 'bg-[#20365a] text-[#dfeaff]' : 'text-faint hover:bg-white/10'
                }`}
              >
                Edit image
              </button>
              <button
                onClick={() => onSetRefEdit(false)}
                title="Let the chat model look at the image instead of editing it"
                className={`rounded-full px-2.5 py-1 text-[12px] transition ${
                  !refEdit ? 'bg-white/10 text-ink' : 'text-faint hover:bg-white/10'
                }`}
              >
                Ask about it
              </button>
            </div>
            <span data-refhint className="text-[11.5px] text-faint">
              {refEdit ? 'your words become the fal prompt' : 'the model reads the image'}
            </span>
          </div>
        )}

        <div className="flex items-end gap-1.5 rounded-[28px] bg-pill px-2.5 py-2 shadow-[0_2px_14px_rgba(0,0,0,.35)]">
          <button
            onClick={onPickImages}
            title="Attach images"
            className="mb-[3px] grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/25 text-[#e8e8e8] transition hover:bg-white/10"
          >
            <Plus size={17} />
          </button>

          <textarea
            ref={ref}
            rows={1}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (canSend) onSend()
              }
            }}
            placeholder={
              imageMode
                ? 'Describe the image you want'
                : refEdit && images.length > 0
                  ? 'Describe the change you want'
                  : 'Ask anything'
            }
            className="max-h-[208px] flex-1 resize-none bg-transparent px-1 py-[9px] text-[15.5px] leading-[1.5] placeholder:text-[#9a9a9a] disabled:opacity-60"
          />

          <div className="mb-[2px] flex shrink-0 items-center gap-1">
            {imageModeAvailable && (
              <button
                onClick={onToggleImageMode}
                title={
                  imageMode
                    ? 'Image mode is on — Enter generates a picture'
                    : 'Generate an image instead of a chat reply'
                }
                className={`flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[13px] transition ${
                  imageMode
                    ? 'border-[#3f6db5] bg-[#20365a] text-[#dfeaff]'
                    : 'border-white/15 text-[#cfcfcf] hover:bg-white/10'
                }`}
              >
                <ImageIcon size={14} />
                Image
              </button>
            )}

            <button
              onClick={onToggleThinking}
              title={thinking ? 'Thinking is on' : 'Thinking is off'}
              className={`flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[13px] transition ${
                thinking
                  ? 'border-white/25 bg-white/10 text-[#f0f0f0]'
                  : 'border-white/15 text-[#cfcfcf] hover:bg-white/10'
              }`}
            >
              <Brain size={14} />
              Think
            </button>

            <button
              title="Voice input — no speech-to-text provider configured"
              disabled
              className="grid h-8 w-8 cursor-default place-items-center rounded-full text-[#6f6f6f]"
            >
              <Mic size={17} />
            </button>

            {busy ? (
              <button
                onClick={onStop}
                title="Stop generating"
                className="grid h-8 w-8 place-items-center rounded-full bg-[#e8e8e8] text-black transition hover:bg-white"
              >
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={onSend}
                disabled={!canSend}
                title="Send"
                className={`grid h-8 w-8 place-items-center rounded-full transition ${
                  canSend ? 'bg-accent text-white hover:bg-[#4180f0]' : 'bg-[#3a3a3a] text-[#8a8a8a]'
                }`}
              >
                <ArrowUp size={17} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>

        <div className="pt-2 text-center text-[11.5px] text-faint">
          {imageMode
            ? 'Image mode · your prompt is sent to fal.ai to be drawn'
            : `${modelLabel} · Zen Chat can make mistakes. Check important info.`}
        </div>
      </div>
    </div>
  )
}
