/**
 * Agent mode tests.
 *
 * Offline by default — no network, no Pi, no keys: fixtures taken from a real Pi run are fed
 * through the stream translator and the config generator is inspected.
 *
 *   node scripts/test-agent.cjs
 *
 * Live checks (an installed Pi plus a relay key) also prove that the provider config this app
 * generates is one Pi really accepts, and that a real turn writes a real file:
 *
 *   ZEN_PI_ROOT=<folder holding <version>/pi.exe> node scripts/test-agent.cjs
 *
 * The key is read from the app's own store, never passed on a command line and never printed.
 */

'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const pi = require('../electron/pi.cjs')

let passed = 0
let failed = 0
const failures = []

function check (label, fn) {
  try {
    const r = fn()
    if (r === false) throw new Error('assertion failed')
    if (r && r.ok === false) throw new Error(r.why || 'assertion failed')
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    failures.push(`${label}: ${err.message}`)
    console.log(`  FAIL  ${label} — ${err.message}`)
  }
}

function assert (cond, why) {
  if (!cond) throw new Error(why || 'assertion failed')
}

/** Real lines, captured from a live Pi turn. */
const FIXTURE = [
  { type: 'session', version: '0.87.1', id: 'sess-abc', timestamp: '2026-09-28T20:51:00.000Z', cwd: 'C:\\ws' },
  { type: 'agent_start' },
  { type: 'turn_start' },
  { type: 'message_start', message: { role: 'assistant' } },
  { type: 'message_update', usage: null, assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } },
  { type: 'message_update', usage: null, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'I should write the file. ' } },
  { type: 'message_update', usage: null, assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Writing it now.' } },
  { type: 'tool_execution_start', toolCallId: 'call_00_abc', toolName: 'write', args: { content: 'SAM\n', path: 's.txt' } },
  { type: 'tool_execution_update', toolCallId: 'call_00_abc', toolName: 'write', args: { path: 's.txt' }, partialResult: { content: [] } },
  { type: 'tool_execution_end', toolCallId: 'call_00_abc', toolName: 'write', result: { content: [{ type: 'text', text: 'Successfully wrote to s.txt' }] }, isError: false },
  { type: 'tool_execution_start', toolCallId: 'call_01_def', toolName: 'bash', args: { command: 'wc -c s.txt' } },
  { type: 'tool_execution_end', toolCallId: 'call_01_def', toolName: 'bash', result: { content: [{ type: 'text', text: '4 s.txt' }] }, isError: true },
  { type: 'message_update', usage: { input: 1200, output: 84, cacheRead: 0, cacheWrite: 0, totalTokens: 1284, cost: { total: 0.0021 } }, assistantMessageEvent: { type: 'text_delta', delta: '' } },
  { type: 'turn_end', message: {}, toolResults: [] },
  { type: 'agent_end', messages: [], willRetry: false },
  { type: 'agent_settled' }
]

function fixtureStream () {
  const events = []
  const t = pi.createTranslator(e => events.push(e))
  // Delivered in awkward chunks on purpose: one byte at a time across record boundaries.
  const text = FIXTURE.map(o => JSON.stringify(o)).join('\n') + '\n'
  for (let i = 0; i < text.length; i += 7) t.push(text.slice(i, i + 7))
  t.flush()
  return { events, state: t.state }
}

console.log('\nAgent mode — offline\n')

check('1. the layout keeps a disposable version directory apart from durable config', () => {
  const L = pi.layout('C:\\data\\pi')
  assert(L.exe.includes(pi.PI_VERSION), 'the binary lives under the pinned version')
  assert(L.agentDir.includes('agent'), 'config lives in an agent directory')
  assert(!L.agentDir.startsWith(L.versionDir), 'config is not inside the version directory, so upgrades keep it')
  return true
})

check('2. an empty root never claims to be installed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-pi-empty-'))
  const s = pi.status(root)
  assert(s.installed === false, 'installed must be false with no binary present')
  assert(s.version === null && s.exe === null, 'no version may be invented')
  return true
})

check('3. the generated provider config points at our endpoint and keeps the key off disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-pi-cfg-'))
  const L = pi.layout(root)
  const cfg = pi.writeConfig({
    agentDir: L.agentDir,
    baseUrl: 'https://opencode.ai/zen/go/v1',
    models: pi.modelsFor([{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', reasoning: true }, 'another-model'])
  })
  const onDisk = fs.readFileSync(L.configFile, 'utf8')
  assert(cfg.providers.zen.baseUrl === 'https://opencode.ai/zen/go/v1', 'the base URL is the app\'s own')
  assert(cfg.providers.zen.api === 'openai-completions', 'an OpenAI-compatible endpoint uses the openai-completions API')
  assert(cfg.providers.zen.apiKey === '$ZEN_RELAY_KEY', 'the key is an environment reference')
  assert(cfg.providers.zen.models.length === 2, 'every model the chat offers is offered to Pi')
  assert(cfg.providers.zen.models[0].reasoning === true, 'a reasoning model stays a reasoning model')
  // Nothing that looks like a credential may appear in the file.
  const stripped = onDisk.replace('$ZEN_RELAY_KEY', '')
  assert(!/sk[-_]|oc_sk|[A-Za-z0-9_-]{32,}/.test(stripped), 'no credential-shaped literal in the config')
  return true
})

check('4. framing survives U+2028 inside a string — the reason readline is unusable', () => {
  const events = []
  const t = pi.createTranslator(e => events.push(e))
  const nasty = JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a\u2028b\u2029c' } })
  t.push(nasty.slice(0, 40))
  t.push(nasty.slice(40) + '\n')
  t.flush()
  const text = events.filter(e => e.kind === 'text').map(e => e.delta).join('')
  assert(events.length === 1, `one record must yield one event, got ${events.length}`)
  assert(text === 'a\u2028b\u2029c', 'the characters survive intact')
  return true
})

check('5. a record left unterminated when the process exits is still read', () => {
  const events = []
  const t = pi.createTranslator(e => events.push(e))
  t.push(JSON.stringify({ type: 'session', id: 'x' }))  // no trailing newline
  t.flush()
  assert(events.length === 1 && events[0].id === 'x', 'the final record is flushed')
  return true
})

check('6. the event stream becomes the chat\'s own events, in order', () => {
  const { events, state } = fixtureStream()
  const kinds = events.map(e => e.kind)
  assert(kinds[0] === 'session', 'the session header arrives first')
  assert(kinds.includes('thinking') && kinds.includes('text'), 'reasoning and answer are told apart')
  assert(kinds.indexOf('tool_start') < kinds.indexOf('tool_end'), 'a tool row opens before it closes')
  assert(kinds[kinds.length - 1] === 'settled', 'the turn ends with settled')
  assert(state.text === 'Writing it now.', `answer text accumulated, got ${JSON.stringify(state.text)}`)
  assert(state.thinking === 'I should write the file. ', 'thinking accumulated separately')
  assert(state.sessionId === 'sess-abc', 'the session id is kept')
  assert(state.usage && state.usage.totalTokens === 1284, 'usage is kept for an honest token count')
  return true
})

check('7. tool calls arrive with a human label, a one-line summary and a real outcome', () => {
  const { events, state } = fixtureStream()
  const start = events.find(e => e.kind === 'tool_start')
  assert(start.tool.label === 'Write file', 'Pi\'s "write" is labelled in the chat\'s words')
  assert(start.tool.summary === 's.txt', 'the row is summarised by the file it touches')
  const ends = events.filter(e => e.kind === 'tool_end')
  assert(ends[0].ok === true && ends[0].text === 'Successfully wrote to s.txt', 'a successful call reports what it did')
  assert(ends[1].ok === false, 'a failed call is marked failed, not hidden')
  assert(state.tools.filter(t => t.ok === false).length === 1, 'the failure is visible on the tool it belongs to')
  return true
})

check('8. a stray non-JSON line is counted, not fatal', () => {
  const events = []
  const t = pi.createTranslator(e => events.push(e))
  t.push('npm warn: something chattered on stdout\n')
  t.push(JSON.stringify({ type: 'agent_settled' }) + '\n')
  t.flush()
  assert(t.state.unparsed === 1, 'the stray line is counted')
  assert(events.length === 1 && events[0].kind === 'settled', 'the stream carries on')
  return true
})

check('9. a command is summarised by the command, not by its working directory', () => {
  assert(pi.summarize('bash', { command: 'npm test', cwd: 'C:\\x' }) === 'npm test', 'bash shows the command')
  assert(pi.summarize('write', { path: 'src/a.ts', content: 'x' }) === 'src/a.ts', 'write shows the path')
  assert(pi.summarize('bash', { command: 'x'.repeat(300) }).length <= 120, 'long arguments are elided')
  return true
})

check('10. the pinned release asset is chosen per platform and verified by checksum', () => {
  assert(pi.assetFor('win32', 'x64') === 'pi-windows-x64.zip', 'Windows x64 asset')
  assert(pi.assetFor('darwin', 'arm64') === 'pi-darwin-arm64.tar.gz', 'Apple silicon asset')
  const sums = 'aaaa\n' + 'b'.repeat(64) + '  pi-windows-x64.zip\nc'.repeat(64) + '  other.zip\n'
  assert(pi.shaFor(sums, 'pi-windows-x64.zip') === 'b'.repeat(64), 'the checksum line is matched exactly')
  assert(pi.shaFor(sums, 'pi-linux-x64.tar.gz') === null, 'an unpublished asset is not guessed at')
  return true
})

check('11. agent mode with nothing installed fails cleanly instead of pretending', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-pi-missing-'))
  const events = []
  return pi.runTurn({ piRoot: root, model: 'x', prompt: 'hi', onEvent: e => events.push(e), workspace: root })
    .promise
    .then(r => {
      assert(r.ok === false, 'the turn cannot succeed without a binary')
      const err = events.find(e => e.kind === 'error')
      assert(err && /Pi|ENOENT|could not start/i.test(err.message), 'the failure explains itself')
      return true
    })
})

check('11b. each conversation gets its own session directory, and the name is sanitised', () => {
  const root = 'C:\\data\\pi'
  const a = pi.sessionDirFor(root, 'conv-abc')
  const b = pi.sessionDirFor(root, 'conv-xyz')
  assert(a !== b, 'two conversations must never share one memory')
  assert(a === pi.sessionDirFor(root, 'conv-abc'), 'the same conversation always maps to the same place')
  assert(
    pi.sessionDirFor(root, '../../escape').startsWith(pi.layout(root).sessionsDir),
    'a hostile id cannot climb out of the sessions directory'
  )
  assert(pi.sessionDirFor(root, '').endsWith('default'), 'a missing id falls back rather than failing')
  return true
})

check('11c. "has Pi written a session here" answers honestly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-pi-sess-'))
  assert(pi.hasSession(dir) === false, 'an empty directory means there is no context to continue')
  assert(pi.hasSession(path.join(dir, 'not-there')) === false, 'a missing directory is not a crash')
  fs.writeFileSync(path.join(dir, '2026-01-01T00-00-00-000Z_abc.jsonl'), '{}\n')
  assert(pi.hasSession(dir) === true, 'a written session is found')
  return true
})

// ---- live checks -------------------------------------------------------------------------
// Skipped unless a Pi install is pointed at and a key can be found.

function storeConfig () {
  const file = path.join(process.env.APPDATA || '', 'zen-chat', 'zen-chat-store.json')
  if (!fs.existsSync(file)) return {}
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).config || {} } catch { return {} }
}

async function live () {
  const root = process.env.ZEN_PI_ROOT
  if (!root) {
    console.log('\nLive checks skipped (set ZEN_PI_ROOT to an installed Pi).\n')
    return
  }
  const store = storeConfig()
  const baseUrl = process.env.ZEN_RELAY_BASE || store.baseUrl || 'https://opencode.ai/zen/go/v1'
  const apiKey = process.env.ZEN_RELAY_KEY || store.apiKey || ''
  const model = process.env.ZEN_PI_MODEL || store.model || 'deepseek-v4.1-flash'

  console.log('\nAgent mode — live\n')

  if (!pi.status(root).installed) {
    console.log(`  FAIL  live checks — no Pi binary under ${root}`)
    failed++
    failures.push('no Pi binary under ZEN_PI_ROOT')
    return
  }
  if (!apiKey) {
    console.log('  FAIL  live checks — no relay key found')
    failed++
    failures.push('no relay key')
    return
  }

  // The config this app generates must be one Pi accepts: prove it by using it.
  const L = pi.layout(root)
  pi.writeConfig({ agentDir: L.agentDir, baseUrl, models: pi.modelsFor([{ id: model, reasoning: true }]) })

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-pi-ws-'))
  const events = []
  const t0 = Date.now()
  const r = await pi.runTurn({
    piRoot: root,
    workspace: ws,
    model,
    relayKey: apiKey,
    prompt: 'Create a file called agent-check.txt whose only line is AGENT-OK. Then run a shell command that proves what is in it.',
    timeoutMs: 180000,
    onEvent: e => events.push(e)
  }).promise
  const secs = ((Date.now() - t0) / 1000).toFixed(1)

  const file = path.join(ws, 'agent-check.txt')
  const body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null

  check(`12. the selected model (${model}) runs a real turn through the generated config`, () => {
    assert(r.ok, `the turn failed: ${r.stderr || 'no stderr'}`)
    assert(r.text && r.text.length > 0, 'the model produced an answer')
    return true
  })
  check('13. the agent really has hands on the machine', () => {
    assert(body !== null, 'agent-check.txt was not created')
    assert(body === 'AGENT-OK', `unexpected contents: ${JSON.stringify(body)}`)
    assert(r.tools.some(t => t.name === 'bash' || t.name === 'powershell'), 'it ran a shell command to prove it')
    return true
  })
  check('14. the UI would have something to render live', () => {
    assert(events.some(e => e.kind === 'tool_start'), 'tool rows stream as they start')
    assert(events.some(e => e.kind === 'tool_end'), 'and complete')
    assert(r.unparsed === 0 || r.unparsed < 5, `${r.unparsed} lines were unparseable`)
    console.log(`        ${secs}s · ${r.tools.length} tool calls · ${r.events.lines} events · ${r.usage ? r.usage.totalTokens + ' tokens' : 'no usage reported'}`)
    return true
  })

  // The bug this exists for: every agent turn used to start from nothing, so a follow-up
  // ("now change that file") had no idea what "that" was.
  const memDir = pi.sessionDirFor(root, `mem-${Date.now()}`)
  const quiet = () => {}
  const r1 = await pi.runTurn({
    piRoot: root,
    workspace: ws,
    sessionDir: memDir,
    model,
    relayKey: apiKey,
    timeoutMs: 180000,
    prompt: 'Remember the word TANGERINE for my next message. Reply with just OK.',
    onEvent: quiet
  }).promise
  const r2 = await pi.runTurn({
    piRoot: root,
    workspace: ws,
    sessionDir: memDir,
    model,
    relayKey: apiKey,
    timeoutMs: 180000,
    prompt: 'What word did I ask you to remember? Reply with just that word.',
    onEvent: quiet
  }).promise

  check('15. a follow-up turn remembers the one before it', () => {
    assert(r1.ok && r2.ok, `a turn failed: ${(r1.stderr || r2.stderr || '').slice(-200)}`)
    assert(
      /TANGERINE/i.test(r2.text),
      `the agent did not remember — it answered ${JSON.stringify(String(r2.text).slice(0, 140))}`
    )
    return true
  })

  const otherDir = pi.sessionDirFor(root, `isolation-${Date.now()}`)
  const r3 = await pi.runTurn({
    piRoot: root,
    workspace: ws,
    sessionDir: otherDir,
    model,
    relayKey: apiKey,
    timeoutMs: 180000,
    prompt: 'What word did I ask you to remember? Reply with just that word, or NONE if you do not know.',
    onEvent: quiet
  }).promise

  check('16. another conversation does not inherit that memory', () => {
    assert(r3.ok, `the isolation turn failed: ${(r3.stderr || '').slice(-200)}`)
    assert(!/TANGERINE/i.test(r3.text), 'memory leaked from one conversation into another')
    return true
  })

  /* The point of running several sessions at once: two turns that overlap in time, each in its own
     folder with its own provider config. Before this, both wrote one shared models.json, and the
     second turn silently ran on the first turn's model. B starting before A finishes is the
     evidence that they really did run at the same time rather than one after the other. */
  const wsA = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-two-a-'))
  const wsB = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-two-b-'))
  const stamp = Date.now()
  const idA = `two-a-${stamp}`
  const idB = `two-b-${stamp}`
  const dirA = pi.sessionAgentDirFor(root, idA)
  const dirB = pi.sessionAgentDirFor(root, idB)
  pi.writeConfig({ agentDir: dirA, baseUrl, models: pi.modelsFor([{ id: model, reasoning: true }]) })
  pi.writeConfig({ agentDir: dirB, baseUrl, models: pi.modelsFor([{ id: model, reasoning: true }]) })

  let endA = 0
  let endB = 0
  const startA = Date.now()
  const hA = pi.runTurn({
    piRoot: root, workspace: wsA, sessionDir: pi.sessionDirFor(root, idA), agentDir: dirA,
    model, relayKey: apiKey, timeoutMs: 240000, onEvent: quiet,
    prompt: 'Create a file called a.txt whose only line is A-DONE. Then reply with just DONE.'
  })
  const startB = Date.now()
  const hB = pi.runTurn({
    piRoot: root, workspace: wsB, sessionDir: pi.sessionDirFor(root, idB), agentDir: dirB,
    model, relayKey: apiKey, timeoutMs: 240000, onEvent: quiet,
    prompt: 'Create a file called b.txt whose only line is B-DONE. Then reply with just DONE.'
  })
  const [rrA, rrB] = await Promise.all([
    hA.promise.then(r => { endA = Date.now(); return r }),
    hB.promise.then(r => { endB = Date.now(); return r })
  ])

  check('17. two agent sessions run at the same time, not one after the other', () => {
    assert(rrA.ok && rrB.ok, `a turn failed: ${(rrA.stderr || rrB.stderr || '').slice(-200)}`)
    assert(startB < endA && startA < endB, 'the two turns did not overlap, so they did not run together')
    console.log(`        A ${((endA - startA) / 1000).toFixed(1)}s · B ${((endB - startB) / 1000).toFixed(1)}s · overlapped by ${((Math.min(endA, endB) - Math.max(startA, startB)) / 1000).toFixed(1)}s`)
    return true
  })

  check('18. each session works in its own folder and does not touch the other one', () => {
    const a = fs.existsSync(path.join(wsA, 'a.txt')) ? fs.readFileSync(path.join(wsA, 'a.txt'), 'utf8').trim() : null
    const b = fs.existsSync(path.join(wsB, 'b.txt')) ? fs.readFileSync(path.join(wsB, 'b.txt'), 'utf8').trim() : null
    assert(a === 'A-DONE', `session A's file says ${JSON.stringify(a)}`)
    assert(b === 'B-DONE', `session B's file says ${JSON.stringify(b)}`)
    assert(!fs.existsSync(path.join(wsB, 'a.txt')), "session A's file appeared in session B's folder")
    assert(!fs.existsSync(path.join(wsA, 'b.txt')), "session B's file appeared in session A's folder")
    return true
  })

  check('19. each session kept its own provider config', () => {
    const cfgA = fs.readFileSync(path.join(dirA, 'models.json'), 'utf8')
    const cfgB = fs.readFileSync(path.join(dirB, 'models.json'), 'utf8')
    assert(cfgA.includes(model) && cfgB.includes(model), 'a session lost the model it was told to use')
    assert(dirA !== dirB, 'both sessions shared one agent dir')
    return true
  })
}


/* ---------------------------------- more than one agent session at a time */
// Every session gets its own agent dir, because Pi writes its provider config into that directory.
// A single shared one meant two turns running at once overwrote each other's models.json: the
// second turn silently ran on the first turn's model. These checks are the reason the isolation is
// safe rather than merely possible.
const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-pi-sessions-'))

check('two agent sessions get two different agent dirs', () => {
  const a = pi.sessionAgentDirFor(sessionsRoot, 'conv-a')
  const b = pi.sessionAgentDirFor(sessionsRoot, 'conv-b')
  if (a === b) throw new Error('two sessions share one agent dir')
  if (!/[\\/]agents[\\/]/.test(a)) throw new Error(`not under an agents folder: ${a}`)
})

check('the same session always resolves to the same dir, so a follow-up turn keeps its context', () => {
  const once = pi.sessionAgentDirFor(sessionsRoot, 'conv-a')
  const twice = pi.sessionAgentDirFor(sessionsRoot, 'conv-a')
  if (once !== twice) throw new Error('one session id resolved to two directories')
})

check('a session id with path characters cannot climb out of the sessions folder', () => {
  // derive the folder from the helper rather than hardcoding the layout, so this checks the
  // invariant (resolves inside the agents folder) and not my idea of where that folder is
  const agentsRoot = path.dirname(pi.sessionAgentDirFor(sessionsRoot, 'sample'))
  // containment, not substring matching. A single segment may legitimately be called
  // '-..-..-etc-passwd' (that is one harmless folder name); what matters is whether the resolved
  // path stays under the agents folder, which is exactly what path.relative answers.
  const inside = (p) => {
    const rel = path.relative(agentsRoot, path.resolve(p))
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  const nasty = pi.sessionAgentDirFor(sessionsRoot, '../../../etc/passwd')
  if (!inside(nasty)) throw new Error(`escaped to: ${nasty}`)

  // '..' on its own is the case that really would resolve to the parent directory
  const dotdot = pi.sessionAgentDirFor(sessionsRoot, '..')
  if (path.resolve(dotdot) !== path.resolve(path.join(agentsRoot, 'default'))) {
    throw new Error(`a session id of '..' was not neutralised: ${dotdot}`)
  }
  if (!inside(dotdot)) throw new Error(`'..' escaped to: ${dotdot}`)
})

check('two sessions keep two separate provider configs', () => {
  const a = pi.sessionAgentDirFor(sessionsRoot, 'one')
  const b = pi.sessionAgentDirFor(sessionsRoot, 'two')
  pi.writeConfig({ agentDir: a, baseUrl: 'https://one.example/v1', models: [{ id: 'model-one', name: 'model-one' }] })
  pi.writeConfig({ agentDir: b, baseUrl: 'https://two.example/v1', models: [{ id: 'model-two', name: 'model-two' }] })
  const readA = fs.readFileSync(path.join(a, 'models.json'), 'utf8')
  const readB = fs.readFileSync(path.join(b, 'models.json'), 'utf8')
  if (!/model-one/.test(readA)) throw new Error('the first session lost its own model')
  if (!/model-two/.test(readB)) throw new Error('the second session lost its own model')
  if (/model-two/.test(readA)) throw new Error('the second write reached into the first session')
})


/* ------------------------- which folder a session works in, and what the window shows */
const { pickWorkspace, sessionSummary } = require('../electron/agent-session.cjs')

check('a session works in the folder the request names', () => {
  if (pickWorkspace({ request: 'C:/one', conversation: 'C:/two', global: 'C:/three' }) !== 'C:/one') {
    throw new Error('the request did not win')
  }
})
check('a chat with its own folder overrides the global default', () => {
  if (pickWorkspace({ conversation: 'C:/two', global: 'C:/three' }) !== 'C:/two') throw new Error('the chat folder was ignored')
  if (pickWorkspace({ global: 'C:/three' }) !== 'C:/three') throw new Error('the fallback failed')
})
check('a blank or missing folder is skipped rather than used', () => {
  if (pickWorkspace({ request: '   ', conversation: '', global: 'C:/three' }) !== 'C:/three') {
    throw new Error('a blank folder was accepted')
  }
  if (pickWorkspace({}) !== '') throw new Error('nothing should resolve to nothing')
})
check('two sessions in two chats resolve to two different folders', () => {
  const a = pickWorkspace({ conversation: 'C:/work-a', global: 'C:/default' })
  const b = pickWorkspace({ conversation: 'C:/work-b', global: 'C:/default' })
  if (a === b) throw new Error('both sessions were given the same folder')
})
check('a session summary carries what the window draws, and for how long it has run', () => {
  const s = sessionSummary({ requestId: 'r1', conversationId: 'c1', title: 'Deploy notes', workspace: 'C:/a', model: 'm', startedAt: 1000 }, 7000)
  if (s.seconds !== 6) throw new Error(`seconds came out as ${s.seconds}`)
  if (s.title !== 'Deploy notes' || s.workspace !== 'C:/a') throw new Error('a field was lost')
  const blank = sessionSummary({})
  if (blank.seconds !== 0 || blank.title !== 'New chat') throw new Error('a blank summary must still be drawable')
})

live().then(() => {
  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}).catch(err => {
  console.error('\ntest harness error:', err)
  process.exitCode = 1
})
