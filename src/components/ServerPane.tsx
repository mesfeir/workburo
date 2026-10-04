import { useCallback, useEffect, useState } from 'react'
import type { ServerSettings, ServerStatus } from '../global'

/*
 * Server mode: this app, served to a phone or another computer.
 *
 * Two things this pane deliberately never does. It never shows the API key -- the key is compared in
 * the main process and is not sent to any page, so a screenshot of this pane is not a way in. And it
 * never pretends a device is something it is not: a device appears here only once it has made a
 * request with the key, so an empty list means nobody has connected, not that something is broken.
 */

const ago = (at: number) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

const clock = (seconds: number) => {
  const s = Math.max(0, seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function ServerPane() {
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [port, setPort] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState('')
  const [pair, setPair] = useState<{ code: string; expiresAt: number } | null>(null)
  const [, setTick] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const next = await window.zen.server.status()
      setStatus(next)
      setPort(String(next.settings.port))
    } catch (err) {
      setError(String((err as Error).message || err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /* While this pane is open: keep the device list and the clock honest. */
  useEffect(() => {
    const t = setInterval(() => {
      void refresh()
      setTick((n) => n + 1)
    }, 3000)
    return () => clearInterval(t)
  }, [refresh])

  const settings = status?.settings
  const running = Boolean(status?.running)
  const on = Boolean(settings?.enabled) && running

  const start = async () => {
    setBusy('start')
    setError('')
    try {
      const r = await window.zen.server.start()
      if (!r.ok) setError(r.error || 'the server did not start')
      else setNote('Reachable now. Pair a device with the code below.')
      await refresh()
    } finally {
      setBusy('')
    }
  }

  const stop = async () => {
    setBusy('stop')
    setError('')
    try {
      await window.zen.server.stop()
      setPair(null)
      setNote('Stopped. Nothing can reach this app now.')
      await refresh()
    } finally {
      setBusy('')
    }
  }

  const save = async (patch: Partial<ServerSettings>) => {
    try {
      const r = await window.zen.server.settings(patch)
      setStatus((s) => (s ? { ...s, settings: r.settings } : s))
      if (r.restartNeeded) setNote('That takes effect when the server restarts.')
      await refresh()
    } catch (err) {
      setError(String((err as Error).message || err))
    }
  }

  const issuePair = async () => {
    setBusy('pair')
    setError('')
    try {
      const p = await window.zen.server.pair()
      setPair({ code: p.code, expiresAt: p.expiresAt })
    } catch (err) {
      setError(String((err as Error).message || err))
    } finally {
      setBusy('')
    }
  }

  const newKey = async () => {
    const ok = window.confirm(
      'Give the server a new key?\n\nEvery device already connected stops working and has to pair again. Nothing else changes.',
    )
    if (!ok) return
    setBusy('key')
    try {
      await window.zen.server.newKey()
      setPair(null)
      setNote('New key. Devices have to pair again; nothing else changed.')
      await refresh()
    } finally {
      setBusy('')
    }
  }

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      setTimeout(() => setCopied(''), 1600)
    } catch {
      setError('Could not copy to the clipboard.')
    }
  }

  const pairSecondsLeft = pair ? Math.round((pair.expiresAt - Date.now()) / 1000) : 0
  const pairLive = Boolean(pair) && pairSecondsLeft > 0
  const lanAddress = (status?.addresses || []).find((a) => !/127\.0\.0\.1|localhost/.test(a)) || ''
  const pairUrl = lanAddress ? `${lanAddress.replace(/\/$/, '')}/pair` : '(this computer only)'

  return (
    <div className="space-y-5" data-server-pane>
      <div>
        <h3 className="text-[15px] font-medium text-[var(--text-mid)]">Use this app from another device</h3>
        <p className="mt-1 max-w-[62ch] text-[12.5px] leading-relaxed text-faint">
          Turns this app into a small web server, so a phone or another computer can open the same app, with the
          same conversations and the same models. Your provider keys never leave this computer: the other device
          only ever holds the key that gets it in the door.
        </p>
      </div>

      {/* ---------------------------------------------------------------- switch */}
      <label className="flex items-start gap-3 rounded-xl border border-[var(--rule)] bg-[var(--raised)] px-3.5 py-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-[var(--accent-bright)]"
          checked={on}
          disabled={busy !== ''}
          onChange={(e) => (e.target.checked ? void start() : void stop())}
          data-server-toggle
        />
        <span>
          <span className="block text-[13px] text-[var(--text-mid)]">
            {on ? 'On — another device can reach this app' : 'Off'}
          </span>
          <span className="mt-0.5 block text-[12px] text-faint">
            {on
              ? `Listening on port ${status?.port}. Stops when the app quits.`
              : 'Nothing is listening. No device can reach this app at all.'}
          </span>
        </span>
      </label>

      {error && (
        <div className="rounded-xl border border-[var(--rule)] bg-[var(--raised)] px-3.5 py-2.5 text-[12.5px] text-[var(--warn)]">
          {error}
        </div>
      )}
      {note && (
        <div className="rounded-xl border border-[var(--rule)] bg-[var(--raised)] px-3.5 py-2.5 text-[12.5px] text-faint">
          {note}
        </div>
      )}

      {on && (
        <>
          {/* ------------------------------------------------------------ address */}
          <div className="space-y-2.5 rounded-xl border border-[var(--rule)] bg-[var(--app)] p-3.5">
            <span className="block text-[11.5px] uppercase tracking-wide text-faint">Reachable at</span>
            {(status?.addresses || []).map((a) => (
              <div key={a} className="flex items-center gap-2.5">
                <code className="flex-1 truncate rounded-lg border border-[var(--rule)] bg-[var(--raised)] px-2.5 py-1.5 text-[12px] text-[var(--text-mid)]">
                  {a}
                </code>
                <button
                  className="rounded-lg border border-[var(--rule)] px-3 py-1.5 text-[12.5px] text-[var(--text-mid)] hover:bg-[var(--raised)]"
                  onClick={() => void copy(a, a)}
                >
                  {copied === a ? 'Copied' : 'Copy'}
                </button>
              </div>
            ))}
            <span className="block text-[11.5px] text-faint">
              {settings?.bind === 'all'
                ? 'Anyone on this network who has the key can reach it.'
                : 'Only this computer can reach it. Set the address to this network for a phone.'}
            </span>
          </div>

          {/* ------------------------------------------------------------ pairing */}
          <div className="space-y-2.5 rounded-xl border border-[var(--rule)] bg-[var(--app)] p-3.5" data-server-pair>
            <span className="block text-[11.5px] uppercase tracking-wide text-faint">Pair a device</span>
            {pairLive && pair ? (
              <>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[30px] tracking-[0.22em] text-[var(--text-mid)]" data-pair-code>
                    {pair.code}
                  </span>
                  <span className="text-[12px] text-faint">{clock(pairSecondsLeft)} left</span>
                </div>
                <span className="block text-[12px] leading-relaxed text-faint">
                  On the device, open <code className="text-[var(--text-mid)]">{pairUrl}</code> and type those six
                  digits. It gets the key and remembers it, so this is once per device.
                </span>
              </>
            ) : (
              <>
                <button
                  className="rounded-lg bg-[var(--accent-bg)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--text-solid)]"
                  disabled={busy !== ''}
                  onClick={() => void issuePair()}
                  data-server-pair-button
                >
                  {busy === 'pair' ? 'Making a code…' : 'Show a pairing code'}
                </button>
                <span className="block text-[12px] leading-relaxed text-faint">
                  Six digits, good for five minutes, once. Beats typing a long key on a phone, and keeps the key out
                  of the address bar where it would end up in history and bookmarks.
                </span>
              </>
            )}
          </div>

          {/* ------------------------------------------------------------- shape */}
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="mb-1 block text-[11.5px] uppercase tracking-wide text-faint">Port</span>
              <input
                className="w-full rounded-lg border border-[var(--rule)] bg-[var(--raised)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-mid)]"
                value={port}
                inputMode="numeric"
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
                onBlur={() => {
                  const n = Number(port)
                  if (n > 0 && n < 65536 && n !== status?.settings.port) void save({ port: n })
                }}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11.5px] uppercase tracking-wide text-faint">Who can reach it</span>
              <select
                className="w-full rounded-lg border border-[var(--rule)] bg-[var(--raised)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-mid)]"
                value={settings?.bind || 'localhost'}
                onChange={(e) => void save({ bind: e.target.value as ServerSettings['bind'] })}
                data-server-bind
              >
                <option value="localhost">This computer only</option>
                <option value="all">This network (for a phone)</option>
              </select>
            </label>
          </div>

          {/* ------------------------------------------------------------- agent */}
          <div
            className={`rounded-xl border px-3.5 py-3 text-[12.5px] leading-relaxed ${
              status?.agentEnabled
                ? 'border-[var(--rule)] bg-[var(--raised)] text-[var(--warn)]'
                : 'border-[var(--rule)] bg-[var(--raised)] text-faint'
            }`}
          >
            {status?.agentEnabled ? (
              <>
                <strong className="font-medium">Agent mode is on, so this is not just a chat.</strong> Anyone who
                pairs can ask the agent to do things, and the agent runs commands on this computer. Pair only devices
                you would hand your laptop to, and use <em>Give it a new key</em> if a device goes missing.
              </>
            ) : (
              <>
                Agent mode is off, so a paired device can chat, attach files and make pictures — nothing that runs on
                this computer. Turn it on in Agent to let a phone use it.
              </>
            )}
          </div>

          {/* ----------------------------------------------------------- devices */}
          <div className="space-y-2 rounded-xl border border-[var(--rule)] bg-[var(--app)] p-3.5">
            <span className="block text-[11.5px] uppercase tracking-wide text-faint">
              Devices that have used the key
            </span>
            {status?.devices?.length ? (
              <ul className="space-y-1.5">
                {status.devices.slice(0, 6).map((d) => (
                  <li key={d.ip} className="flex items-center justify-between text-[12.5px] text-[var(--text-mid)]">
                    <code className="text-[12px]">{d.ip}</code>
                    <span className="text-faint">{ago(d.at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="block text-[12.5px] text-faint">
                Nothing yet. A device shows up here once it has asked for something with the key.
              </span>
            )}
            {Boolean(status?.refusals) && (
              <span className="block text-[12px] text-[var(--warn)]">
                {status?.refusals} request{status?.refusals === 1 ? '' : 's'} refused
                {status?.lastRefusal ? ` — last one ${ago(status.lastRefusal.at)} from ${status.lastRefusal.ip}` : ''}.
              </span>
            )}
          </div>

          {/* ---------------------------------------------------------- requests */}
          <div className="space-y-2 rounded-xl border border-[var(--rule)] bg-[var(--app)] p-3.5">
            <span className="block text-[11.5px] uppercase tracking-wide text-faint">Recent requests</span>
            {status?.requests?.length ? (
              <ul className="space-y-1">
                {[...(status.requests || [])].reverse().slice(0, 8).map((r, i) => (
                  <li key={`${r.at}-${i}`} className="flex items-center gap-2 text-[12px] text-faint">
                    <span className="w-[52px] shrink-0 tabular-nums">{r.status}</span>
                    <span className="w-[42px] shrink-0">{r.method}</span>
                    <code className="flex-1 truncate text-[var(--text-mid)]">{r.path}</code>
                    <span className="shrink-0">{ago(r.at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="block text-[12.5px] text-faint">No requests yet.</span>
            )}
          </div>

          {/* --------------------------------------------------------------- key */}
          <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--rule)] bg-[var(--raised)] px-3.5 py-3">
            <span className="text-[12px] leading-relaxed text-faint">
              The key is {status?.keyLength || 0} characters and stays in the app: it is never shown here, and never
              sent to a device. Give it a new one to shut every device out.
            </span>
            <button
              className="shrink-0 rounded-lg border border-[var(--rule)] px-3 py-1.5 text-[12.5px] text-[var(--text-mid)] hover:bg-[var(--app)]"
              disabled={busy !== ''}
              onClick={() => void newKey()}
              data-server-newkey
            >
              Give it a new key
            </button>
          </div>
        </>
      )}
    </div>
  )
}
