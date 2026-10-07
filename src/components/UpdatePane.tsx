import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowDownToLine, Check, ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import type { Config, UpdateState } from '../types'

/**
 * Updating the app, from inside the app.
 *
 * Everything that decides whether an update is safe to run lives in the main process; this only shows
 * it. The one rule the layout follows is that the window never offers a button that will not work:
 * when a file cannot be checked, or when this platform cannot replace itself, the button that appears
 * is the honest alternative and the reason is spelled out underneath.
 *
 * The work is the same everywhere — check, download, verify against the published checksums — and only
 * the ending differs by platform.
 */

function mb(bytes: number) {
  if (!bytes) return '0 MB'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function ago(ms: number) {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

const ACTION_LABEL: Record<string, string> = {
  'run-installer': 'Restart and install',
  'open-dmg': 'Open the disk image',
  'open-folder': 'Show the file',
  'open-release': 'Open the download page',
}

export default function UpdatePane({
  config,
  onConfig,
}: {
  config?: Config
  onConfig?: (patch: Partial<Config>) => void
}) {
  const [u, setU] = useState<UpdateState | null>(null)
  const [auto, setAuto] = useState(config?.update?.autoCheck !== false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  useEffect(() => {
    let alive = true
    void window.zen.update.state().then((s) => {
      if (!alive) return
      setU(s)
      setAuto(s.autoCheck)
    })
    const off = window.zen.update.onChanged((s) => {
      if (alive) setU(s)
    })
    return () => {
      alive = false
      off?.()
    }
  }, [])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setProblem('')
    try {
      await fn()
    } catch (err) {
      setProblem((err as Error).message || 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  const phase = u?.phase || 'idle'
  const error = problem || u?.error || ''
  /* An automatic check that failed stays quiet: it is only spoken about when it was asked for. */
  const showError = Boolean(error) && (Boolean(problem) || u?.checkedBy === 'user')

  const pill = (text: string, tone: 'ok' | 'wait' | 'new' | 'bad' = 'ok') => {
    const colour =
      tone === 'ok'
        ? 'text-[var(--text-dim)]'
        : tone === 'bad'
          ? 'text-[var(--err)]'
          : tone === 'new'
            ? 'text-ink'
            : 'text-faint'
    return <span className={`text-[12px] ${colour}`}>{text}</span>
  }

  return (
    <div className="rounded-xl border border-[var(--rule)] bg-[var(--app)] p-3" data-update data-update-phase={phase}>
      <div className="mb-2 flex items-center gap-2">
        <ArrowDownToLine size={14} className="text-faint" />
        <span className="font-medium text-muted">Updates</span>
        {phase === 'checking' && <Loader2 size={13} className="animate-spin text-faint" />}
        {u?.newer && phase === 'available' && (
          <span data-update-badge className="rounded-full border border-[var(--accent)] px-2 py-0.5 text-[11px] text-ink">
            {u.latest} ready
          </span>
        )}
      </div>

      <div className="space-y-2 text-[12.5px] text-[var(--text-mid)]">
        {/* what is running, and what is out there */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-[var(--text-dim)]">
            This is WorkBuro <span className="font-mono">{u?.current || '…'}</span>
          </span>
          {phase === 'checking' && pill('asking GitHub…', 'wait')}
          {phase === 'uptodate' && pill('up to date', 'wait')}
          {phase === 'available' && u && pill(`${u.latest} is available`, 'new')}
          {phase === 'idle' && !showError && pill('not checked yet', 'wait')}
        </div>

        {/* while a download is in flight */}
        {phase === 'downloading' && u && (
          <div data-update-progress>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--raised-2)]">
              <div className="h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: `${u.progress.percent}%` }} />
            </div>
            <div className="mt-1 flex items-center justify-between text-[11.5px] text-faint">
              <span>
                {u.progress.percent}% · {mb(u.progress.received)} of {mb(u.progress.total)}
              </span>
              <span className="truncate">{u.asset?.name}</span>
            </div>
          </div>
        )}

        {/* what has been checked about the downloaded file */}
        {phase === 'ready' && u?.checksum && (
          <div className="flex items-start gap-1.5" data-update-checksum={u.checksum.ok ? 'ok' : 'not-ok'}>
            {u.checksum.ok ? (
              <ShieldCheck size={13} className="mt-0.5 shrink-0 text-[var(--ok,#5bd07a)]" />
            ) : (
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--err)]" />
            )}
            <span className="text-[11.5px] text-faint">
              {u.checksum.ok
                ? `Checked against the published SHA256SUMS — sha256 ${u.checksum.got.slice(0, 16)}…`
                : u.checksum.hasChecksum
                  ? 'That file does not match the published checksum.'
                  : 'No checksum was published for this file, so it could not be checked.'}
            </span>
          </div>
        )}

        {/* the ending, in the app's own words */}
        {phase === 'ready' && u?.plan && <p className="text-[12px] text-[var(--text-dim)]">{u.plan.why}</p>}

        {phase === 'ready' && u?.plan?.action === 'run-installer' && (
          <p className="text-[11.5px] text-faint">
            Server mode drops for about twenty seconds while the app restarts.
          </p>
        )}

        {showError && <p className="text-[12px] text-[var(--err)]">{error}</p>}

        {/* the controls */}
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {phase === 'available' && (
            <>
              <button
                data-update-action="download"
                disabled={busy}
                onClick={() => void act(() => window.zen.update.download())}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-[12.5px] text-[var(--app)] transition disabled:opacity-50"
              >
                <ArrowDownToLine size={13} /> Download{u?.asset?.size ? ` (${mb(u.asset.size)})` : ''}
              </button>
              <button
                onClick={() => void act(() => window.zen.update.openRelease())}
                className="flex items-center gap-1.5 rounded-lg border border-[var(--rule)] px-2.5 py-1.5 text-[12.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink"
              >
                <ExternalLink size={13} /> What&rsquo;s new
              </button>
            </>
          )}

          {phase === 'downloading' && (
            <button
              data-update-action="cancel"
              onClick={() => void act(() => window.zen.update.cancel())}
              className="rounded-lg border border-[var(--rule)] px-2.5 py-1.5 text-[12.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink"
            >
              Cancel
            </button>
          )}

          {phase === 'ready' && (
            <>
              {u?.plan && u.plan.action !== 'none' && (
                <button
                  data-update-action={u.plan.action}
                  disabled={busy}
                  onClick={() => void act(async () => {
                    const res = await window.zen.update.install()
                    if (res && !res.ok && res.error) setProblem(res.error)
                  })}
                  className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-[12.5px] text-[var(--app)] transition disabled:opacity-50"
                >
                  <Check size={13} /> {ACTION_LABEL[u.plan.action] || 'Continue'}
                </button>
              )}
              {/* a refusal still leaves a way forward that is not a dead end */}
              {(u?.plan?.action === 'none' || !u?.plan) && (
                <button
                  data-update-action="open-release"
                  onClick={() => void act(() => window.zen.update.openRelease())}
                  className="flex items-center gap-1.5 rounded-lg border border-[var(--rule)] px-2.5 py-1.5 text-[12.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink"
                >
                  <ExternalLink size={13} /> Open the download page
                </button>
              )}
              {u?.file && <span className="truncate font-mono text-[10.5px] text-faint">{u.file.path}</span>}
            </>
          )}

          {(phase === 'idle' || phase === 'uptodate' || showError) && (
            <button
              data-update-action="check"
              disabled={busy}
              onClick={() => void act(() => window.zen.update.check())}
              className="flex items-center gap-1.5 rounded-lg border border-[var(--rule)] px-2.5 py-1.5 text-[12.5px] text-muted transition hover:bg-[var(--raised)] hover:text-ink disabled:opacity-50"
            >
              <RefreshCw size={13} className={phase === 'checking' ? 'animate-spin' : ''} /> Check for updates
            </button>
          )}

          {u?.checkedAt ? <span className="text-[11.5px] text-faint">checked {ago(u.checkedAt)}</span> : null}
        </div>

        {/* the one outbound call this app makes on its own */}
        <label className="flex items-start gap-2 pt-1 text-[11.5px] text-faint">
          <input
            type="checkbox"
            data-update-auto
            checked={auto}
            onChange={(e) => {
              setAuto(e.target.checked)
              onConfig?.({ update: { ...(config?.update || {}), autoCheck: e.target.checked } })
            }}
            className="mt-0.5"
          />
          <span>
            Check automatically, quietly, when the app starts. One request to GitHub&rsquo;s public
            releases endpoint — no account, no identifier, nothing about this machine.
          </span>
        </label>
      </div>
    </div>
  )
}
