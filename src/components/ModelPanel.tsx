import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ImageIcon, MessageSquare, Wand2 } from 'lucide-react'
import ImageModelPicker from './ImageModelPicker'
import ModelPicker from './ModelPicker'
import type { Config, ModelGroup, ModelInfo } from '../types'

/**
 * One control for every model the app can be pointed at.
 *
 * There were two buttons up here -- the chat model and the image model -- and adding the
 * image-to-image model would have made three. Three controls in a bar this size, each opening its own
 * list, with nothing to say they belong together. This is one button that says what is in use and one
 * panel with a tab per job: what answers, what draws, what edits.
 *
 * The lists are the pickers already used in Settings, rendered inline rather than reimplemented, so
 * searching, grouping, the prices, the eye icon and the "look again" button are the same code and
 * cannot drift from what the settings screen does.
 */
type Tab = 'chat' | 'image' | 'edit'

const TABS: { id: Tab; label: string; icon: typeof MessageSquare; hint: string }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare, hint: 'The model that answers' },
  { id: 'image', label: 'Picture', icon: ImageIcon, hint: 'The model that draws a picture' },
  { id: 'edit', label: 'Edit', icon: Wand2, hint: 'The model that changes a picture it is given' },
]

/* fal's ids carry a publisher prefix that is the same for almost everything; the name is the part
   that differs. The panel is small, so the prefix goes. */
const short = (id: string) => String(id || '').replace(/^fal-ai\//, '')

export default function ModelPanel({
  config,
  models,
  groups,
  unavailable,
  onSelect,
  onRefresh,
  onProbe,
  probingId,
  onConfigure,
  onImageChange,
  onConfigureImages,
}: {
  config: Config
  models: ModelInfo[]
  groups?: ModelGroup[]
  unavailable?: { provider: string; error?: string }[]
  onSelect: (id: string, from?: { baseUrl: string; key?: string; affinity?: boolean }) => void
  onRefresh: () => void
  onProbe: (id: string) => void
  probingId: string | null
  onConfigure: () => void
  onImageChange: (id: string, field: 'model' | 'editModel') => void
  onConfigureImages: () => void
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('chat')
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (open && box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const ig = config.imageGen
  /* The image tabs are only worth offering when there is a key to draw with. */
  const imagesUsable = Boolean(ig?.enabled && ig?.falKey)
  const imageModel = ig?.model ? short(ig.model) : ''
  const editModel = ig?.editModel ? short(ig.editModel) : ''

  return (
    <div className="relative no-drag" ref={box}>
      <button
        onClick={() => setOpen((o) => !o)}
        data-model-panel
        title={config.model || 'Choose a model'}
        className="flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-[13.5px] transition hover:bg-[var(--raised-2)]"
      >
        <span className="max-w-[220px] truncate text-[var(--text-mid)]">
          {config.model || 'Select a model'}
        </span>
        {/* A picture model in use is worth seeing without opening anything: it is the other half of
            "what will this do when I press send". */}
        {imagesUsable && imageModel ? (
          <span
            data-model-panel-image
            className="flex items-center gap-1 rounded-md bg-[var(--raised-2)] px-1.5 py-0.5 text-[11px] text-faint"
          >
            <ImageIcon size={11} />
            <span className="max-w-[120px] truncate">{imageModel}</span>
          </span>
        ) : null}
        <ChevronDown size={14} className="shrink-0 text-faint" />
      </button>

      {open && (
        <div className="absolute left-0 top-[38px] z-40 w-[min(92vw,430px)] overflow-hidden rounded-2xl border border-[var(--rule)] bg-[var(--raised)] shadow-2xl">
          <div className="flex items-center gap-0.5 border-b border-[var(--rule)] p-1.5">
            {TABS.map((t) => {
              const on = tab === t.id
              return (
                <button
                  key={t.id}
                  data-model-tab={t.id}
                  onClick={() => setTab(t.id)}
                  title={t.hint}
                  className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] transition ${
                    on ? 'bg-[var(--raised-2)] text-ink' : 'text-muted hover:bg-[var(--raised)]'
                  }`}
                >
                  <t.icon size={13} className="shrink-0" />
                  <span className="truncate">{t.label}</span>
                </button>
              )
            })}
          </div>

          {/* What this tab is for, and what it is set to. The model name lives here rather than in
              the tabs themselves: three labels and three model names do not fit a bar this wide, and
              the name is only interesting while the list is open. */}
          <div className="flex items-center justify-between gap-3 px-3 py-1.5 text-[11px] text-faint">
            <span className="truncate">{TABS.find((t) => t.id === tab)?.hint}</span>
            {tab !== 'chat' && (imageModel || editModel) ? (
              <span
                data-model-panel-current
                className="max-w-[45%] shrink-0 truncate text-[var(--text-mid)]"
              >
                {tab === 'image' ? imageModel : editModel}
              </span>
            ) : null}
          </div>

          {tab === 'chat' ? (
            <ModelPicker
              inline
              models={models}
              groups={groups}
              unavailable={unavailable}
              current={config.model}
              config={config}
              onSelect={onSelect}
              onRefresh={onRefresh}
              onProbe={onProbe}
              probingId={probingId}
              onConfigure={onConfigure}
              onPicked={() => setOpen(false)}
            />
          ) : imagesUsable ? (
            <ImageModelPicker
              inline
              field={tab === 'image' ? 'model' : 'editModel'}
              config={config}
              onChange={(id) => onImageChange(id, tab === 'image' ? 'model' : 'editModel')}
              onConfigure={onConfigureImages}
              onPicked={() => setOpen(false)}
            />
          ) : (
            <div className="px-3 pb-3 pt-1 text-[13px] text-faint">
              Drawing is switched off.{' '}
              <button
                onClick={onConfigureImages}
                className="text-[var(--text-mid)] underline decoration-dotted underline-offset-2 hover:text-ink"
              >
                Add a fal key in Settings
              </button>{' '}
              to choose a picture or edit model.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
