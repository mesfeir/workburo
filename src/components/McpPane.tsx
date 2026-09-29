/**
 * MCP servers.
 *
 * Model Context Protocol servers, run on this machine, whose tools the assistant can then use. The
 * pane keeps the same three promises the connected-apps pane does, for the same reason: a server is
 * a real program the user starts on their own computer, so
 *
 *   · nothing is started until the feature is switched on and a server is enabled;
 *   · credentials live in the store and are only ever shown as proof they are set, never as values;
 *   · every failure is shown as it came back, because a Test button that quietly does nothing is
 *     worse than an error message.
 *
 * "Test" connects, lists what the server offers, and disconnects again, so trying a server never
 * leaves a process running.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, Play, Plus, RefreshCw, Square, Trash2 } from 'lucide-react'
import type { Config, McpServer } from '../types'

type Status = {
  name: string
  key: string
  running: boolean
  era: string | null
  info: { name?: string; version?: string }
  tools: { name: string; description: string }[]
  lastOutput: string[]
}

const blank = (): McpServer => ({ name: '', command: '', args: [], env: {}, enabled: true })

export default function McpPane({
  config,
  onConfig,
}: {
  config: Config
  onConfig: (patch: Partial<Config>) => void
}) {
  const saved = config.mcp || { enabled: false, servers: [] }
  const set = (patch: Partial<typeof saved>) => onConfig({ mcp: { ...saved, ...patch } })
  const servers = saved.servers || []

  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState<McpServer>(blank())
  const [busy, setBusy] = useState('')
  const [status, setStatus] = useState<Status[]>([])
  const [result, setResult] = useState<{ name: string; kind: 'ok' | 'err'; lines: string[] } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const list = await window.zen.mcp?.status?.()
      setStatus(Array.isArray(list) ? list : [])
    } catch {
      setStatus([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const commit = (next: McpServer[]) => {
    set({ servers: next })
    setEditing(null)
    setDraft(blank())
  }

  const save = (index: number) => {
    const server: McpServer = {
      name: draft.name.trim(),
      command: draft.command.trim(),
      args: (draft.args || []).filter((a) => String(a).trim() !== ''),
      env: draft.env || {},
      cwd: (draft.cwd || '').trim(),
      enabled: draft.enabled !== false,
    }
    if (!server.name || !server.command) {
      setResult({ name: server.name || 'new server', kind: 'err', lines: ['A server needs a name and a command.'] })
      return
    }
    const next = [...servers]
    if (index < 0) next.push(server)
    else next[index] = server
    commit(next)
  }

  const test = async (server: McpServer) => {
    setBusy(server.name || 'new')
    setResult(null)
    try {
      const r = await window.zen.mcp?.test?.(server)
      if (!r || r.ok === false) {
        setResult({ name: server.name, kind: 'err', lines: [String((r && r.error) || 'the test returned nothing')] })
      } else {
        setResult({
          name: server.name,
          kind: 'ok',
          lines: [
            `Connected using the ${r.era === 'modern' ? 'current' : 'older'} protocol revision.`,
            r.info && r.info.name ? `Server: ${r.info.name} ${r.info.version || ''}`.trim() : '',
            r.tools && r.tools.length
              ? `${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}: ${r.tools.join(', ')}`
              : 'This server offers no tools.',
          ].filter(Boolean),
        })
      }
    } catch (err) {
      setResult({ name: server.name, kind: 'err', lines: [String((err as Error).message || err)] })
    } finally {
      setBusy('')
      void refresh()
    }
  }

  const stop = async (name: string) => {
    setBusy(name)
    try {
      await window.zen.mcp?.stop?.(name)
    } finally {
      setBusy('')
      void refresh()
    }
  }

  const runningFor = (s: McpServer) => status.find((x) => x.key === (s.name || '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-'))

  const field = 'w-full rounded-lg border border-[#2c2c2c] bg-[#141414] px-2.5 py-2 text-[12.5px] text-[#e8e8e8] outline-none focus:border-[#4f8cff]'

  const editor = (index: number) => (
    <div className="space-y-2.5 rounded-xl border border-[#2c2c2c] bg-[#191919] p-3.5" data-mcp-editor>
      <div className="grid grid-cols-2 gap-2.5">
        <label className="block">
          <span className="mb-1 block text-[11.5px] uppercase tracking-wide text-faint">Name</span>
          <input
            className={field}
            value={draft.name}
            placeholder="files"
            data-mcp-name
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11.5px] uppercase tracking-wide text-faint">Command</span>
          <input
            className={field}
            value={draft.command}
            placeholder="npx"
            data-mcp-command
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
          />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-[11.5px] uppercase tracking-wide text-faint">
          Arguments, one per line
        </span>
        <textarea
          className={`${field} h-16 font-mono`}
          value={(draft.args || []).join('\n')}
          placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\Me\\Documents'}
          data-mcp-args
          onChange={(e) => setDraft({ ...draft, args: e.target.value.split('\n').map((a) => a.trim()).filter(Boolean) })}
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-[11.5px] uppercase tracking-wide text-faint">
          Environment, one NAME=value per line
        </span>
        <textarea
          className={`${field} h-16 font-mono`}
          value={Object.entries(draft.env || {})
            .map(([k, v]) => `${k}=${v}`)
            .join('\n')}
          placeholder={'GITHUB_TOKEN=…'}
          data-mcp-env
          onChange={(e) => {
            const env: Record<string, string> = {}
            for (const line of e.target.value.split('\n')) {
              const at = line.indexOf('=')
              if (at > 0) env[line.slice(0, at).trim()] = line.slice(at + 1).trim()
            }
            setDraft({ ...draft, env })
          }}
        />
        <span className="mt-1 block text-[11.5px] text-faint">
          Passed to the server only. The assistant never sees these, and they are stored on this machine.
        </span>
      </label>
      <div className="flex items-center gap-2.5">
        <button
          className="rounded-lg bg-[#4f8cff] px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-[#6a9dff]"
          data-mcp-save
          onClick={() => save(index)}
        >
          Save server
        </button>
        <button
          className="rounded-lg border border-[#333] px-3 py-1.5 text-[12.5px] text-[#ddd] hover:bg-[#232323]"
          onClick={() => {
            setEditing(null)
            setDraft(blank())
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )

  return (
    <div className="space-y-5" data-mcp-pane>
      <div>
        <h3 className="text-[15px] font-medium text-[#ececec]">MCP servers</h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-faint">
          Connect servers that speak the Model Context Protocol. Whatever tools a server offers become
          tools the assistant can use in a chat, alongside the ones built into this app. Off by
          default, and nothing is started at all while it is off: a server is a real program, run on
          this machine, only when a message actually needs tools.
        </p>
      </div>

      <label className="flex items-center gap-3 rounded-xl border border-[#2c2c2c] bg-[#1a1a1a] px-3.5 py-3">
        <input
          type="checkbox"
          checked={!!saved.enabled}
          onChange={(e) => set({ enabled: e.target.checked })}
          data-mcp-enabled
          className="h-4 w-4 accent-[#4f8cff]"
        />
        <span className="text-[13.5px] text-[#e4e4e4]">
          Use MCP servers
          <span className="mt-0.5 block text-[12px] text-faint">
            When this is on, enabled servers below start with the first chat that uses tools.
          </span>
        </span>
      </label>

      <div className="space-y-2.5">
        {servers.map((s, i) => {
          const live = runningFor(s)
          if (editing === i) return <div key={i}>{editor(i)}</div>
          return (
            <div
              key={i}
              className="rounded-xl border border-[#2c2c2c] bg-[#1a1a1a] px-3.5 py-3"
              data-mcp-server={s.name}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={s.enabled !== false}
                  data-mcp-server-toggle
                  className="mt-0.5 h-4 w-4 accent-[#4f8cff]"
                  onChange={(e) => {
                    const next = [...servers]
                    next[i] = { ...s, enabled: e.target.checked }
                    set({ servers: next })
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13.5px] text-[#e4e4e4]">{s.name}</span>
                    {live?.running ? (
                      <span className="rounded bg-[#17351f] px-1.5 py-0.5 text-[11px] text-[#5fd07f]">
                        running
                      </span>
                    ) : null}
                    {live?.era ? (
                      <span className="text-[11px] text-faint">
                        {live.era === 'modern' ? 'current protocol' : 'older protocol'}
                      </span>
                    ) : null}
                  </div>
                  <div className="truncate font-mono text-[11.5px] text-faint">
                    {[s.command, ...(s.args || [])].join(' ')}
                  </div>
                  {s.env && Object.keys(s.env).length ? (
                    <div className="mt-0.5 text-[11.5px] text-faint">
                      {Object.keys(s.env).length} environment value
                      {Object.keys(s.env).length === 1 ? '' : 's'} set
                    </div>
                  ) : null}
                  {live && live.tools.length ? (
                    <div className="mt-1 text-[11.5px] text-faint">
                      Tools: {live.tools.map((t) => t.name).join(', ')}
                    </div>
                  ) : null}
                  {live && live.lastOutput.length ? (
                    <div className="mt-1 truncate font-mono text-[11px] text-faint">{live.lastOutput.slice(-1)[0]}</div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    className="flex items-center gap-1.5 rounded-lg border border-[#333] px-2.5 py-1.5 text-[12px] text-[#ddd] hover:bg-[#232323] disabled:opacity-50"
                    data-mcp-test={s.name}
                    disabled={busy === s.name}
                    onClick={() => void test(s)}
                  >
                    {busy === s.name ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                    Test
                  </button>
                  {live?.running ? (
                    <button
                      className="flex items-center gap-1.5 rounded-lg border border-[#333] px-2.5 py-1.5 text-[12px] text-[#ddd] hover:bg-[#232323] disabled:opacity-50"
                      data-mcp-stop={s.name}
                      disabled={busy === s.name}
                      onClick={() => void stop(s.name)}
                    >
                      <Square size={12} />
                      Stop
                    </button>
                  ) : null}
                  <button
                    className="rounded-lg border border-[#333] p-1.5 text-[#bbb] hover:bg-[#232323]"
                    title="Edit"
                    onClick={() => {
                      setEditing(i)
                      setDraft({ ...blank(), ...s })
                    }}
                  >
                    <RefreshCw size={13} />
                  </button>
                  <button
                    className="rounded-lg border border-[#333] p-1.5 text-[#c66] hover:bg-[#232323]"
                    title="Remove"
                    data-mcp-remove={s.name}
                    onClick={() => commit(servers.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            </div>
          )
        })}

        {editing === -1 ? editor(-1) : null}
        {!servers.length && editing !== -1 ? (
          <p className="rounded-xl border border-dashed border-[#2c2c2c] px-3.5 py-4 text-center text-[12.5px] text-faint">
            No servers yet. Anything that speaks MCP over stdio works here.
          </p>
        ) : null}
      </div>

      {editing === -1 ? null : (
        <button
          className="flex items-center gap-1.5 rounded-lg border border-[#333] px-3 py-2 text-[12.5px] text-[#ddd] hover:bg-[#232323]"
          data-mcp-add
          onClick={() => {
            setDraft(blank())
            setEditing(-1)
          }}
        >
          <Plus size={14} />
          Add a server
        </button>
      )}

      {result ? (
        <div
          className={`rounded-xl border px-3.5 py-3 text-[12.5px] ${
            result.kind === 'ok'
              ? 'border-[#2c4a33] bg-[#152018] text-[#cfe8d5]'
              : 'border-[#4a2c2c] bg-[#201515] text-[#e8cfcf]'
          }`}
          data-mcp-result
        >
          <div className="font-medium">{result.name}</div>
          {result.lines.map((line, i) => (
            <div key={i} className="mt-0.5 break-words font-mono text-[11.5px]">
              {line}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
