/**
 * Connected apps.
 *
 * The apps here are real: once one is connected, the model can be asked to send the email, create
 * the event, post the message — in the user's own account. So this pane keeps three promises:
 *
 *   · nothing is reachable until the user turns it on and connects an app themselves;
 *   · the key lives in main and never reaches this page;
 *   · every failure is shown as it came back, because "Connect" that quietly does nothing is worse
 *     than an error message.
 *
 * The connect URL is the one Composio returns — main opens it in the real browser. Sign-in links
 * expire (ten minutes by the API's own documentation), so one is fetched fresh on each attempt and
 * this pane polls for a couple of minutes rather than pretending it completed instantly.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ExternalLink, Loader2, RefreshCw, Search } from 'lucide-react'
import type { Config } from '../types'

type AppInfo = {
  slug: string
  name: string
  description: string
  logo: string
  noAuth: boolean
  tools: number
}
type Conn = { id: string; app: string; status: string; reason: string; active: boolean }

const POLL_MS = 3000
const POLL_FOR_MS = 120000

export default function AppsPane({
  config,
  onConfig,
}: {
  config: Config
  onConfig: (patch: Partial<Config>) => void
}) {
  const saved = config.apps || { enabled: false, apiKey: '', userId: '' }
  /**
   * The user id is invented once and then kept: Composio ties a connection to it, so changing it
   * would orphan everything already connected.
   */
  const set = (patch: Partial<typeof saved>) =>
    onConfig({
      apps: {
        ...saved,
        userId: saved.userId || (crypto.randomUUID ? crypto.randomUUID() : `zen-${Date.now()}`),
        ...patch,
      },
    })

  const [key, setKey] = useState(saved.apiKey || '')
  const [query, setQuery] = useState('')
  const [list, setList] = useState<AppInfo[]>([])
  const [conns, setConns] = useState<Conn[]>([])
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState<{ kind: 'ok' | 'err' | 'busy'; msg: string } | null>(null)
  const poll = useRef<{ timer: number; until: number; app: string } | null>(null)

  const refresh = useCallback(async () => {
    const c = await window.zen.apps.connections()
    if (c && c.ok) setConns(c.connections || [])
    return c
  }, [])

  const load = useCallback(
    async (q: string) => {
      setBusy('list')
      const r = await window.zen.apps.list(q)
      setBusy('')
      if (!r || !r.ok) {
        setList([])
        setNote({ kind: 'err', msg: (r && r.error) || 'Could not load the app list.' })
        return
      }
      setList(r.apps || [])
      setNote(null)
    },
    [],
  )

  const stopPolling = () => {
    if (poll.current) {
      window.clearInterval(poll.current.timer)
      poll.current = null
    }
  }

  useEffect(() => () => stopPolling(), [])

  // load the catalogue and what is already connected, once there is a key
  useEffect(() => {
    if (!saved.apiKey) return
    load('')
    refresh()
  }, [saved.apiKey, load, refresh])

  const connect = async (app: string) => {
    stopPolling()
    setBusy(app)
    setNote({ kind: 'busy', msg: 'Opening the sign-in page in your browser…' })
    const r = await window.zen.apps.connect(app)
    setBusy('')
    if (!r || !r.ok) {
      setNote({ kind: 'err', msg: (r && r.error) || `Could not start connecting ${app}.` })
      return
    }
    setNote({
      kind: 'busy',
      msg: `Finish signing in to ${app} in your browser. This pane will notice on its own — the link is good for ten minutes.`,
    })
    // watch for it to become ACTIVE, rather than making the user press Refresh and guess
    const until = Date.now() + POLL_FOR_MS
    const timer = window.setInterval(async () => {
      const c = await refresh()
      const mine = ((c && c.connections) || []).filter((x: Conn) => x.app === app)
      const active = mine.find((x: Conn) => x.active)
      if (active) {
        stopPolling()
        setNote({ kind: 'ok', msg: `${app} is connected. You can ask for things to be done in it now.` })
        return
      }
      const failed = mine.find((x: Conn) => x.status === 'FAILED' || x.status === 'EXPIRED')
      if (failed) {
        stopPolling()
        setNote({
          kind: 'err',
          msg: `${app} did not connect${failed.reason ? `: ${failed.reason}` : '.'} Try again when you are ready.`,
        })
        return
      }
      if (Date.now() > until) {
        stopPolling()
        setNote({
          kind: 'err',
          msg: `${app} still is not connected. The sign-in link expires after ten minutes — press Connect again to get a fresh one.`,
        })
      }
    }, POLL_MS)
    poll.current = { timer, until, app }
  }

  const connectedFor = (slug: string) => conns.filter((c) => c.app === slug)
  const state = (slug: string) => {
    const mine = connectedFor(slug)
    if (mine.some((c) => c.active)) return 'connected'
    if (mine.some((c) => ['INITIALIZING', 'INITIATED'].includes(c.status))) return 'pending'
    if (mine.length) return 'failed'
    return 'off'
  }

  const withKey = !!saved.apiKey

  return (
    <div className="space-y-5" data-apps-pane>
      <div>
        <h3 className="text-[15px] font-medium text-[var(--text-mid)]">Connected apps</h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-faint">
          Let the assistant work in your own accounts — Gmail, Calendar, Slack, Notion, Drive and
          hundreds more. Off by default: nothing here is reachable until you switch it on and connect
          an app yourself. It runs on{' '}
          <button
            className="underline decoration-dotted hover:text-[var(--text-mid)]"
            onClick={() => window.zen.openExternal?.('https://composio.dev')}
          >
            Composio
          </button>
          , which holds the sign-in credentials, so this app never sees your app passwords.
        </p>
      </div>

      <label className="flex items-center gap-3 rounded-xl border border-[var(--rule)] bg-[var(--raised)] px-3.5 py-3">
        <input
          type="checkbox"
          checked={!!saved.enabled}
          onChange={(e) => set({ enabled: e.target.checked })}
          data-apps-enabled
          className="h-4 w-4 accent-[var(--accent-bright)]"
        />
        <span className="text-[13.5px] text-[var(--text-mid)]">
          Let the assistant use my connected apps
          <span className="mt-0.5 block text-[12px] text-faint">
            When this is on, it can send, post and create things in the accounts you connect below.
          </span>
        </span>
      </label>

      <div>
        <label className="mb-1.5 block text-[12.5px] text-faint">Composio API key</label>
        <div className="flex gap-2">
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onBlur={() => set({ apiKey: key.trim() })}
            placeholder="ak_…"
            data-apps-key
            className="min-w-0 flex-1 rounded-lg border border-[var(--rule)] bg-[var(--app)] px-3 py-2 text-[13px] text-[var(--text-mid)] outline-none focus:border-[var(--accent-rule)]"
          />
          <button
            onClick={() => {
              set({ apiKey: key.trim() })
              load(query)
              refresh()
            }}
            disabled={!key.trim() || busy === 'list'}
            className="rounded-lg border border-[var(--rule)] px-3 py-2 text-[13px] text-[var(--text-mid)] transition hover:bg-white/5 disabled:opacity-40"
          >
            {busy === 'list' ? <Loader2 size={15} className="animate-spin" /> : 'Save'}
          </button>
        </div>
        <p className="mt-1.5 text-[12px] text-faint">
          From your Composio dashboard — a project key starts with <code>ak_</code>. There is no
          keyless mode: this one key is what performs the actions.
        </p>
      </div>

      {note && (
        <p
          data-apps-note
          className={`rounded-lg border px-3 py-2 text-[12.5px] ${
            note.kind === 'err'
              ? 'border-red-400/40 bg-red-500/10 text-[var(--err)]'
              : note.kind === 'ok'
                ? 'border-emerald-400/40 bg-emerald-500/10 text-[var(--ok)]'
                : 'border-[var(--rule)] bg-[var(--raised)] text-[var(--text-mid)]'
          }`}
        >
          {note.msg}
        </p>
      )}

      {withKey && (
        <>
          <div>
            <div className="mb-2 flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') load(query)
                  }}
                  placeholder="Search apps — gmail, slack, notion…"
                  className="w-full rounded-lg border border-[var(--rule)] bg-[var(--app)] py-2 pl-8 pr-3 text-[13px] text-[var(--text-mid)] outline-none focus:border-[var(--accent-rule)]"
                />
              </div>
              <button
                onClick={() => load(query)}
                title="Search"
                className="rounded-lg border border-[var(--rule)] p-2 text-[var(--text-mid)] transition hover:bg-white/5"
              >
                <Search size={15} />
              </button>
              <button
                onClick={refresh}
                title="Check connection status again"
                className="rounded-lg border border-[var(--rule)] p-2 text-[var(--text-mid)] transition hover:bg-white/5"
              >
                <RefreshCw size={15} />
              </button>
            </div>

            <div className="max-h-[320px] space-y-1.5 overflow-y-auto pr-1" data-apps-list>
              {list.length === 0 && (
                <p className="px-1 py-3 text-[12.5px] text-faint">
                  No apps to show yet — search for one above.
                </p>
              )}
              {list.map((a) => {
                const st = state(a.slug)
                return (
                  <div
                    key={a.slug}
                    data-app-row={a.slug}
                    className="flex items-center gap-3 rounded-xl border border-[var(--rule)] bg-[var(--app)] px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13.5px] text-[var(--text-mid)]">{a.name}</span>
                        {a.noAuth && <span className="text-[11px] text-faint">no sign-in needed</span>}
                      </div>
                      <span className="mt-0.5 block truncate text-[12px] text-faint">
                        {a.description || `${a.tools} actions`}
                      </span>
                    </div>
                    {st === 'connected' ? (
                      <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-[var(--ok)]">
                        <Check size={14} /> Connected
                      </span>
                    ) : (
                      <button
                        onClick={() => connect(a.slug)}
                        disabled={!saved.enabled || busy === a.slug || st === 'pending'}
                        title={
                          !saved.enabled
                            ? 'Switch on "Let the assistant use my connected apps" first'
                            : st === 'pending'
                              ? 'Finish the sign-in in your browser'
                              : `Connect ${a.name}`
                        }
                        className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--rule)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-mid)] transition hover:bg-white/5 disabled:opacity-40"
                      >
                        {busy === a.slug || st === 'pending' ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <ExternalLink size={13} />
                        )}
                        {st === 'pending' ? 'Waiting' : st === 'failed' ? 'Retry' : 'Connect'}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {conns.length > 0 && (
            <div>
              <h4 className="mb-2 text-[12.5px] text-faint">Already connected</h4>
              <div className="flex flex-wrap gap-2" data-apps-connected>
                {conns.map((c) => (
                  <span
                    key={c.id}
                    title={c.reason || c.status}
                    className={`rounded-lg border px-2.5 py-1 text-[12px] ${
                      c.active
                        ? 'border-emerald-400/40 bg-emerald-500/10 text-[var(--ok)]'
                        : 'border-[var(--rule)] bg-[var(--raised)] text-faint'
                    }`}
                  >
                    {c.app} · {c.status.toLowerCase()}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
