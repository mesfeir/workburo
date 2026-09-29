import { useMemo, useState } from 'react'
import { Settings as SettingsIcon, X } from 'lucide-react'
import type { Conversation } from '../types'

type Shot = {
  key: string
  url: string
  name: string
  /** attached by you, or drawn here */
  kind: 'drawn' | 'attached'
  convId: string
  convTitle: string
  at: number
  prompt: string
}

/**
 * Everything you have ever attached or drawn, in one place — the gallery behind the Images item
 * in the sidebar. Reading only: a picture opens the chat it belongs to, and the settings are one
 * button away rather than in the way.
 */
export default function GalleryModal({
  conversations,
  onClose,
  onOpenChat,
  onOpenSettings,
}: {
  conversations: Conversation[]
  onClose: () => void
  onOpenChat: (conversationId: string) => void
  onOpenSettings: () => void
}) {
  const [kind, setKind] = useState<'all' | 'drawn' | 'attached'>('all')

  const shots = useMemo(() => {
    const out: Shot[] = []
    for (const c of conversations) {
      c.messages.forEach((m, i) => {
        for (const img of m.images || []) {
          const url = String(img?.url || '')
          // a picture whose file has gone missing has no url to show; it is simply not listed
          if (!url) continue
          out.push({
            key: `${c.id}:${i}:${img?.name || 'image'}`,
            url,
            name: String(img?.name || 'image'),
            kind: m.role === 'user' ? 'attached' : 'drawn',
            convId: c.id,
            convTitle: c.title || 'Chat',
            at: m.createdAt || c.updatedAt || 0,
            prompt: m.role === 'user' ? String(m.content || '') : '',
          })
        }
      })
    }
    return out.sort((a, b) => b.at - a.at)
  }, [conversations])

  const shown = kind === 'all' ? shots : shots.filter((s) => s.kind === kind)
  const drawn = shots.filter((s) => s.kind === 'drawn').length
  const attached = shots.length - drawn

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onMouseDown={onClose}>
      <div
        data-gallery
        className="flex h-[660px] max-h-[86vh] w-[740px] flex-col overflow-hidden rounded-2xl border border-[var(--rule)] bg-[var(--app)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--rule)] px-5 py-3.5">
          <div className="flex items-baseline gap-2.5">
            <h2 className="text-[16px] font-semibold">Images</h2>
            <span data-gallery-count className="text-[12px] text-faint">
              {shots.length === 0
                ? 'none yet'
                : `${shots.length} picture${shots.length === 1 ? '' : 's'} · ${drawn} drawn · ${attached} attached`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div data-gallery-filter className="flex items-center gap-0.5 rounded-full border border-white/15 p-0.5">
              {(
                [
                  ['all', 'All'],
                  ['drawn', 'Drawn'],
                  ['attached', 'Attached'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setKind(id)}
                  className={`rounded-full px-2.5 py-1 text-[12px] transition ${
                    kind === id ? 'bg-[var(--accent-bg)] text-[var(--accent-soft)]' : 'text-faint hover:bg-white/10'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              onClick={onOpenSettings}
              title="Image settings — provider, key, models, cost"
              className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-white/10 hover:text-ink"
            >
              <SettingsIcon size={15} />
            </button>
            <button
              onClick={onClose}
              title="Close"
              className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-white/10 hover:text-ink"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {shown.length === 0 ? (
            <div className="grid h-full place-items-center text-center text-[13px] text-faint">
              {shots.length === 0
                ? 'No pictures yet. Attach one, or ask for one, and it shows up here.'
                : `Nothing ${kind === 'drawn' ? 'drawn' : 'attached'} yet.`}
            </div>
          ) : (
            <div data-gallery-grid className="grid grid-cols-3 gap-2.5">
              {shown.map((s) => (
                <button
                  key={s.key}
                  onClick={() => onOpenChat(s.convId)}
                  title={`${s.kind === 'drawn' ? 'Drawn' : 'Attached'} · ${s.convTitle}${
                    s.prompt ? `\n${s.prompt.slice(0, 200)}` : ''
                  }`}
                  className="group relative overflow-hidden rounded-xl border border-white/10 bg-black/30 transition hover:border-[var(--accent-rule)]"
                >
                  <img src={s.url} alt={s.name} className="aspect-square w-full object-cover" />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/85 to-transparent px-2 pb-1.5 pt-5 text-left">
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-px text-[10.5px] ${
                        s.kind === 'drawn' ? 'bg-[var(--accent-bg)] text-[var(--accent-soft)]' : 'bg-white/15 text-[var(--text-mid)]'
                      }`}
                    >
                      {s.kind === 'drawn' ? 'drawn' : 'attached'}
                    </span>
                    <span className="truncate text-[11.5px] text-[var(--text-mid)]">{s.convTitle}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-[var(--rule)] px-5 py-2.5 text-[11.5px] text-faint">
          Click a picture to open the chat it came from.
        </div>
      </div>
    </div>
  )
}
