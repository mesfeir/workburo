import { useMemo, useState, type ReactNode } from 'react'
import {
  Search,
  PanelLeft,
  SquarePen,
  Image as ImageIcon,
  Library,
  CalendarClock,
  Plug,
  FolderOpen,
  MoreHorizontal,
  Settings,
  Trash2,
  Pencil,
  Check,
  X,
  Pin,
  Square,
} from 'lucide-react'
import type { Conversation, Config, RunningSession } from '../types'

function NavRow({
  icon,
  label,
  onClick,
  disabled,
  title,
}: {
  icon: ReactNode
  label: string
  onClick?: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-left text-[14px] transition
        ${disabled ? 'cursor-default text-faint' : 'text-[var(--text-mid)] hover:bg-white/[.07]'}`}
    >
      <span className="grid h-[18px] w-[18px] place-items-center">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}

export default function Sidebar({
  conversations,
  activeId,
  config,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onPin,
  onOpenSettings,
  onOpenImages,
  onCollapse,
  agentSessions,
  onStopAgent,
}: {
  conversations: Conversation[]
  activeId: string | null
  config: Config
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onPin: (id: string) => void
  onOpenSettings: () => void
  onOpenImages: () => void
  onCollapse: () => void
  /** agent sessions running now — a chat with one gets a stop button in its row */
  agentSessions: RunningSession[]
  onStopAgent: (requestId: string) => void
}) {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    const arr = q
      ? conversations.filter(
          (c) =>
            c.title.toLowerCase().includes(q) ||
            c.messages.some((m) => m.content.toLowerCase().includes(q)),
        )
      : conversations
    return [...arr].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt)
  }, [conversations, query])

  const host = useMemo(() => {
    try {
      return new URL(config.baseUrl).hostname
    } catch {
      return config.baseUrl
    }
  }, [config.baseUrl])

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-[var(--rule)] bg-sidebar">
      {/* title bar */}
      <div className="drag-region flex h-11 items-center justify-between pl-4 pr-2">
        <span className="select-none text-[15px] font-semibold tracking-[-0.01em]">Zen Chat</span>
        <div className="no-drag flex items-center gap-0.5">
          <button
            title="Search chats"
            onClick={() => setSearching((s) => !s)}
            className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-white/[.08] hover:text-ink"
          >
            <Search size={16} />
          </button>
          <button
            title="Hide sidebar"
            onClick={onCollapse}
            className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-white/[.08] hover:text-ink"
          >
            <PanelLeft size={16} />
          </button>
        </div>
      </div>

      {searching && (
        <div className="px-2 pb-2">
          <div className="flex items-center gap-2 rounded-lg bg-[var(--raised)] px-2.5 py-1.5">
            <Search size={14} className="text-faint" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="w-full bg-transparent text-[13.5px] placeholder:text-faint"
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-faint hover:text-ink">
                <X size={13} />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="px-2">
        <button
          onClick={onNew}
          className="flex w-full items-center gap-2.5 rounded-lg bg-[var(--raised)] px-2 py-[7px] text-left text-[14px] text-[var(--text-mid)] transition hover:bg-[var(--raised)]"
        >
          <SquarePen size={17} className="-ml-px" />
          <span>New chat</span>
        </button>
      </div>

      <nav className="mt-1 space-y-px px-2">
        <NavRow
          icon={<ImageIcon size={17} />}
          label="Images"
          onClick={onOpenImages}
          title="Every picture you have attached or drawn, and the settings behind them"
        />
        <NavRow icon={<Library size={17} />} label="Library" disabled title="Saved outputs — coming soon" />
        <NavRow icon={<CalendarClock size={17} />} label="Scheduled" disabled title="Scheduled prompts — coming soon" />
        <NavRow icon={<Plug size={17} />} label="Plugins" disabled title="Plugins — coming soon" />
        <NavRow icon={<FolderOpen size={17} />} label="Projects" disabled title="Projects — coming soon" />
        <NavRow icon={<MoreHorizontal size={17} />} label="More" disabled />
      </nav>

      <div className="mt-3 flex-1 overflow-y-auto px-2 pb-2">
        <div className="px-2 pb-1 pt-2 text-[12px] font-medium text-faint">
          {query ? 'Results' : 'Recents'}
        </div>
        {list.length === 0 && (
          <div className="px-2 py-3 text-[13px] text-faint">
            {query ? 'No matches.' : 'No chats yet.'}
          </div>
        )}
        <div className="space-y-px">
          {list.map((c) => (
            <div
              key={c.id}
              className={`group relative flex items-center rounded-lg ${
                c.id === activeId ? 'bg-white/[.08]' : 'hover:bg-white/[.06]'
              }`}
            >
              {editingId === c.id ? (
                <div className="flex w-full items-center gap-1 px-2 py-1">
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        onRename(c.id, draft.trim() || 'Untitled')
                        setEditingId(null)
                      }
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    className="w-full rounded bg-[var(--app)] px-1.5 py-1 text-[13.5px]"
                  />
                  <button
                    onClick={() => {
                      onRename(c.id, draft.trim() || 'Untitled')
                      setEditingId(null)
                    }}
                    className="text-muted hover:text-ink"
                  >
                    <Check size={14} />
                  </button>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => onSelect(c.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-[7px] text-left"
                  >
                    {c.pinned && <Pin size={12} className="shrink-0 text-faint" />}
                    <span
                      className={`truncate text-[13.5px] ${
                        c.id === activeId ? 'text-ink' : 'text-[var(--text-mid)]'
                      }`}
                    >
                      {c.title}
                    </span>
                  </button>
                  {(() => {
                    const runner = agentSessions.find((s) => s.conversationId === c.id)
                    if (!runner) return null
                    return (
                      <button
                        onClick={() => onStopAgent(runner.requestId)}
                        title={`Pi is working in ${runner.workspace} (${runner.seconds}s). Click to stop this session.`}
                        className="mr-0.5 grid h-6 w-6 shrink-0 place-items-center rounded text-[var(--ok)] transition hover:bg-white/10"
                      >
                        <Square size={10} className="fill-current" />
                      </button>
                    )
                  })()}
                  <button
                    onClick={() => setMenuId(menuId === c.id ? null : c.id)}
                    className={`mr-1 grid h-6 w-6 shrink-0 place-items-center rounded text-muted transition hover:bg-white/10 hover:text-ink ${
                      menuId === c.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                  {menuId === c.id && (
                    <>
                      <div className="fixed inset-0 z-20" onClick={() => setMenuId(null)} />
                      <div className="absolute right-1 top-[30px] z-30 w-[168px] overflow-hidden rounded-xl border border-[var(--rule)] bg-[var(--raised)] py-1 shadow-2xl">
                        <button
                          onClick={() => {
                            setEditingId(c.id)
                            setDraft(c.title)
                            setMenuId(null)
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-white/[.08]"
                        >
                          <Pencil size={13} /> Rename
                        </button>
                        <button
                          onClick={() => {
                            onPin(c.id)
                            setMenuId(null)
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-white/[.08]"
                        >
                          <Pin size={13} /> {c.pinned ? 'Unpin' : 'Pin'}
                        </button>
                        <button
                          onClick={() => {
                            onDelete(c.id)
                            setMenuId(null)
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--err)] hover:bg-white/[.08]"
                        >
                          <Trash2 size={13} /> Delete
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* footer */}
      <div className="border-t border-[var(--rule)] p-2">
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
          <div className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[var(--accent-bg)] to-[var(--accent-bg)] text-[11px] font-semibold text-[var(--text-solid)]">
            {(host || 'Z').charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[13px] text-[var(--text-mid)]" title={config.baseUrl}>
              {host || 'Not connected'}
            </div>
            <div className="truncate text-[11px] text-faint">{config.model || 'No model selected'}</div>
          </div>
          <button
            title="Settings"
            onClick={onOpenSettings}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-white/[.08] hover:text-ink"
          >
            <Settings size={16} />
          </button>
        </div>
      </div>
    </aside>
  )
}
