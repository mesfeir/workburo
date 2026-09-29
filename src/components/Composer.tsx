import { useEffect, useRef } from 'react'
import { ArrowUp, Brain, FileText, Image as ImageIcon, Mic, Plus, Square, Terminal, X, FolderOpen } from 'lucide-react'
import type { RunningSession, Attachment, Speed } from '../types'

/** What a document chip calls the file: the reader's own kind, in words a person would use. */
function docLabel(d: { docKind?: string }) {
  const k = String(d.docKind || '').toLowerCase()
  if (k === 'pdf') return 'PDF'
  if (k === 'sheet') return 'Spreadsheet'
  if (k === 'docx') return 'Word document'
  if (k === 'text') return 'Text'
  return 'Document'
}

export default function Composer({
  value,
  onChange,
  onSend,
  onStop,
  images,
  onAddImages,
  onPickImages,
  onRemoveImage,
  documents,
  onPickFiles,
  onRemoveDocument,
  busy,
  thinking,
  onToggleThinking,
  imageMode,
  onToggleImageMode,
  imageModeAvailable,
  refEdit,
  onSetRefEdit,
  agentMode,
  onToggleAgent,
  agentAvailable,
  agentWorkspace,
  agentSession,
  onStopAgent,
  onPickAgentWorkspace,
  modelLabel,
  disabled,
  focusNonce,
  speed,
}: {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  onStop: () => void
  images: Attachment[]
  onAddImages: (a: Attachment[]) => void
  /** documents attached to the next message: name, size and a short preview — never the text */
  documents: Attachment[]
  /** the ＋ button: the native picker, the only way to reach a PDF or a spreadsheet */
  onPickFiles: () => void
  onRemoveDocument: (i: number) => void
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
  /** bumped when something wants the caret put back in the input, e.g. after attaching a picture */
  focusNonce?: number
  /** live tokens per second while an answer streams, shown bottom-right in small text */
  speed?: Speed | null
  /** hand the next turns to Pi, which can touch files in the workspace folder */
  agentMode: boolean
  onToggleAgent: () => void
  /** only offered once Pi is installed, in Settings → Agent */
  agentAvailable: boolean
  /** shown in the tooltip, so the folder it may change is never a mystery */
  agentWorkspace?: string
  agentSession?: RunningSession | null
  onStopAgent: (requestId: string) => void
  onPickAgentWorkspace: () => void
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

  // something asked for the caret (a picture attached from the transcript): put it back in the
  // input, because the next thing typed is the instruction that changes that picture
  useEffect(() => {
    if (focusNonce) ref.current?.focus()
  }, [focusNonce])

  const canSend = (value.trim().length > 0 || images.length > 0 || documents.length > 0) && !disabled

  return (
    <div className="px-4 pb-2">
      <div className="mx-auto w-full max-w-[768px]">
        {documents.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-2 px-1" data-documents>
            {documents.map((d, i) => (
              <div
                key={`${d.name}-${i}`}
                data-doc-chip={d.docKind || 'file'}
                title={d.error || d.preview || d.name}
                className={`group relative flex max-w-[300px] items-center gap-2 rounded-xl border px-2.5 py-1.5 ${
                  d.error ? 'border-red-400/40 bg-red-500/10' : 'border-white/15 bg-white/[0.04]'
                }`}
              >
                <FileText size={15} className="shrink-0 text-faint" />
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] text-[var(--text-mid)]">{d.name}</span>
                  <span className="block truncate text-[11px] text-faint" data-doc-meta>
                    {d.error
                      ? d.error
                      : `${docLabel(d)}${
                          d.chars ? ` · ${d.chars.toLocaleString()} characters` : ''
                        }${d.truncated ? ' · part of it' : ''}`}
                  </span>
                </span>
                <button
                  onClick={() => onRemoveDocument(i)}
                  title="Remove"
                  className="ml-0.5 shrink-0 rounded-full p-0.5 text-faint transition hover:text-[var(--text-mid)]"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

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
                  className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-[var(--rule)] bg-[var(--app)] text-muted transition hover:text-ink"
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
                  refEdit ? 'bg-[var(--accent-bg)] text-[var(--accent-soft)]' : 'text-faint hover:bg-white/10'
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

        {/* The input row keeps its shape and the mode switches sit under it: side by side they ate
            the textarea at narrow widths until there was nowhere left to type. */}
        <div className="rounded-[26px] bg-pill px-2.5 py-2 shadow-[0_2px_14px_rgba(0,0,0,.35)]">
          <div className="flex items-end gap-1.5">
          <button
            onClick={onPickFiles}
            title="Attach files — PDF, Word, Excel, CSV, text or images"
            data-attach
            className="mb-[3px] grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/25 text-[var(--text-mid)] transition hover:bg-white/10"
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
            className="max-h-[208px] flex-1 resize-none bg-transparent px-1 py-[9px] text-[15.5px] leading-[1.5] placeholder:text-[var(--text-dim)] disabled:opacity-60"
          />

          <div className="mb-[2px] flex shrink-0 items-center gap-1">
            <button
              title="Voice input — no speech-to-text provider configured"
              disabled
              className="grid h-8 w-8 cursor-default place-items-center rounded-full text-[var(--text-faint)]"
            >
              <Mic size={17} />
            </button>

            {busy ? (
              <button
                onClick={onStop}
                title="Stop generating"
                className="grid h-8 w-8 place-items-center rounded-full bg-[var(--text-mid)] text-black transition hover:bg-[var(--app)]"
              >
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={onSend}
                disabled={!canSend}
                title="Send"
                className={`grid h-8 w-8 place-items-center rounded-full transition ${
                  canSend ? 'bg-accent text-[var(--text-solid)] hover:bg-[var(--accent-bg)]' : 'bg-[var(--raised-2)] text-[var(--text-dim)]'
                }`}
              >
                <ArrowUp size={17} strokeWidth={2.5} />
              </button>
            )}
          </div>
          </div>

          {/* the mode switches: under the input, where a narrow window can never push them over
              the textarea */}
          <div data-modes className="mt-1.5 flex flex-wrap items-center gap-1 px-0.5">
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
                    ? 'border-[var(--accent-rule)] bg-[var(--accent-bg)] text-[var(--accent-soft)]'
                    : 'border-white/15 text-[var(--text-mid)] hover:bg-white/10'
                }`}
              >
                <ImageIcon size={14} />
                Image
              </button>
            )}

            <button
              onClick={onToggleAgent}
              disabled={!agentAvailable}
              title={
                !agentAvailable
                  ? 'Agent mode needs Pi — install it in Settings → Agent'
                  : agentMode
                    ? `Agent mode is on — Pi works in ${agentWorkspace || 'the workspace folder'}`
                    : 'Hand this turn to Pi, which can read, write and run things in your workspace folder'
              }
              className={`flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[13px] transition ${
                agentMode
                  ? 'border-[var(--accent-rule)] bg-[var(--accent-bg)] text-[var(--accent-soft)]'
                  : 'border-white/15 text-[var(--text-mid)] hover:bg-white/10'
              } ${!agentAvailable ? 'cursor-default opacity-45 hover:bg-transparent' : ''}`}
            >
              <Terminal size={14} />
              Agent
            </button>

            {agentMode && (
              <button
                onClick={onPickAgentWorkspace}
                title={
                  agentWorkspace
                    ? `Pi works in ${agentWorkspace} for this chat. Click to choose another folder.`
                    : 'Choose the folder Pi may work in for this chat'
                }
                className="flex h-8 max-w-[200px] items-center gap-1.5 rounded-full border border-white/15 px-2.5 text-[13px] text-[var(--text-mid)] transition hover:bg-white/10"
              >
                <FolderOpen size={14} />
                <span className="truncate">
                  {agentWorkspace ? agentWorkspace.split(/[\\/]/).filter(Boolean).pop() : 'Folder'}
                </span>
              </button>
            )}

            {agentSession && (
              <button
                onClick={() => onStopAgent(agentSession.requestId)}
                title={`Pi is working (${agentSession.seconds}s). Click to stop this session.`}
                className="flex h-8 items-center gap-1.5 rounded-full border border-[var(--ok)] bg-[var(--ok-bg)] px-2.5 text-[13px] text-[var(--ok)] transition hover:bg-[var(--ok)] hover:text-[var(--app)]"
              >
                <Square size={11} className="fill-current" />
                Stop
              </button>
            )}

            <button
              onClick={onToggleThinking}
              title={thinking ? 'Thinking is on' : 'Thinking is off'}
              className={`flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[13px] transition ${
                thinking
                  ? 'border-white/25 bg-white/10 text-[var(--text)]'
                  : 'border-white/15 text-[var(--text-mid)] hover:bg-white/10'
              }`}
            >
              <Brain size={14} />
              Think
            </button>
          </div>
        </div>

        {/* the notice stays centred; the speed sits hard right in the same small text, so the
            number is where the eye already goes for "bottom right of the app" */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 pt-2 text-[11.5px] text-faint">
          <span aria-hidden />
          <span className="text-center">
            {imageMode
              ? 'Image mode · your prompt is sent to fal.ai to be drawn'
              : `${modelLabel} · Zen Chat can make mistakes. Check important info.`}
          </span>
          {speed && Number.isFinite(speed.tps) && speed.tps > 0 ? (
            <span
              data-speed
              title={
                speed.estimated
                  ? 'Estimated from the text arriving so far — it becomes exact when the answer ends'
                  : 'Measured from the model’s own token count'
              }
              className="justify-self-end tabular-nums"
            >
              {speed.estimated ? '≈' : ''}
              {speed.tps >= 100 ? String(Math.round(speed.tps)) : speed.tps.toFixed(1)} tok/s
            </span>
          ) : (
            <span aria-hidden />
          )}
        </div>
      </div>
    </div>
  )
}
