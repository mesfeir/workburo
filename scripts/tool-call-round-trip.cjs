/**
 * One real tool round trip, end to end, with nothing stubbed.
 *
 * Every other tool check in this repo stops at the tool: it stubs fetch, or calls executeTool
 * directly, or reads the request shape. None of them prove the thing a person actually cares
 * about, which is that asking a question makes the model reach for a tool, the tool runs for
 * real, and the answer that comes back uses what the tool found.
 *
 * This drives the whole loop the way the app does: the app's own tool definitions go out to a
 * real OpenAI-compatible endpoint, whatever tool call comes back is run through the app's own
 * executeTool with no stubs, and the result is sent back for the model to answer with.
 *
 * Live by nature, so it is not part of npm test. Run it by hand:
 *   node scripts/tool-call-round-trip.cjs
 *   ZEN_PROBE_BASE=http://127.0.0.1:11434/v1 ZEN_PROBE_MODEL=qwen3.5:4b node scripts/tool-call-round-trip.cjs
 */
const { chatToolDefs, executeTool } = require('../electron/tools.cjs')

const BASE = (process.env.ZEN_PROBE_BASE || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '')
const MODEL = process.env.ZEN_PROBE_MODEL || 'qwen3.5:4b'
const QUESTION = 'What is the weather in London, UK right now? Use a tool, do not guess.'
const KEY = process.env.ZEN_PROBE_KEY || ''

async function call(messages) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify({ model: MODEL, messages, tools: chatToolDefs({ toolsEnabled: true }), stream: false }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  return json.choices?.[0]?.message || {}
}

;(async () => {
  const tools = chatToolDefs({ toolsEnabled: true })
  console.log(`endpoint ${BASE}  model ${MODEL}`)
  console.log(`advertising ${tools.length} tools: ${tools.map((t) => t.function.name).join(', ')}\n`)

  const messages = [{ role: 'user', content: QUESTION }]
  const first = await call(messages)
  const calls = first.tool_calls || []

  if (!calls.length) {
    console.log('FAIL  the model answered without calling a tool')
    console.log(`      it said: ${JSON.stringify(String(first.content || '').slice(0, 200))}`)
    process.exit(1)
  }
  console.log(`1. the model asked for ${calls.length} tool call(s):`)
  for (const c of calls) {
    console.log(`     ${c.function?.name}  args=${typeof c.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function?.arguments)}`)
  }

  messages.push({ role: 'assistant', content: first.content || '', tool_calls: calls })

  let anyFailed = false
  for (const c of calls) {
    const name = c.function?.name
    const raw = c.function?.arguments
    // the same normalisation the app does, because a server may send an object
    const args = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {})
    const t0 = Date.now()
    const r = await executeTool(name, args, {})
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    if (!r.ok) anyFailed = true
    console.log(`\n2. ${name} ran for real in ${secs}s -> ${r.ok ? 'ok' : 'FAILED'}`)
    console.log(`   ${String(r.error || r.text || '').split('\n').slice(0, 3).join('\n   ').slice(0, 400)}`)
    messages.push({ role: 'tool', tool_call_id: c.id, content: r.ok ? r.text : `Error: ${r.error}` })
  }

  const last = await call(messages)
  console.log(`\n3. the model answered using it:\n   ${String(last.content || '').split('\n').join('\n   ').slice(0, 500)}`)

  const ok = !anyFailed && Boolean(last.content)
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  a real tool round trip completed`)
  process.exit(ok ? 0 : 1)
})().catch((err) => {
  console.log(`FAIL  the round trip threw: ${err.message}`)
  process.exit(1)
})
