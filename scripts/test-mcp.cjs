#!/usr/bin/env node
/**
 * Tests electron/mcp.cjs against real servers, spawned for real.
 *
 *   node scripts/test-mcp.cjs
 *
 * Every check here corresponds to a way an MCP client actually fails in the field: a server that
 * only speaks the new revision and has no `initialize` handshake, a server that only speaks the old
 * one, a community server that prints a banner on stdout, one that stops answering, one that fails
 * a tool without failing the call, and a child that must not inherit this process's API keys. The
 * fixture server is written to a temp file at run time, so nothing here depends on the network or
 * on any package being installed.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const mcp = require('../electron/mcp.cjs')

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fixture-'))
const fixture = path.join(dir, 'server.cjs')

/**
 * A minimal MCP server. MODE changes its personality:
 *   modern  - answers server/discover with a real result
 *   legacy  - rejects it with -32601, so the client must fall back to initialize
 *   banner  - prints a banner line on stdout before any JSON, the classic community bug
 *   hang    - accepts the connection and then never answers anything
 *   picky   - answers only a revision it likes, with -32022 and a supported list
 */
fs.writeFileSync(
  fixture,
  `#!/usr/bin/env node
const MODE = process.env.MODE || 'modern'
const SECRET = process.env.SECRET_IN_CHILD || ''
const TOOLS = [
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'boom', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  { name: 'leak', description: 'Reports what it can see', inputSchema: { type: 'object', properties: {} } },
]
if (MODE === 'banner') process.stdout.write('  npm notice new version available\\n')
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  let nl = buf.indexOf('\\n')
  while (nl !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    nl = buf.indexOf('\\n')
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (!msg.method) continue
    if (MODE === 'hang') continue
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
    const err = (code, message, data) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message, data } }) + '\\n')
    if (msg.method === 'server/discover') {
      if (MODE === 'legacy') return err(-32601, 'Method not found')
      if (MODE === 'picky') return err(-32022, 'Unsupported protocol version', { supported: ['2025-11-25'] })
      return reply({ protocolVersion: '2026-07-28', serverInfo: { name: 'fixture', version: '9.9.9' }, capabilities: { tools: {} } })
    }
    if (msg.method === 'initialize') return reply({ protocolVersion: '2025-11-25', serverInfo: { name: 'fixture', version: '9.9.9' }, capabilities: { tools: {} } })
    if (msg.method === 'notifications/initialized') continue
    if (msg.method === 'tools/list') return reply({ tools: TOOLS })
    if (msg.method === 'tools/call') {
      const name = msg.params && msg.params.name
      if (name === 'add') return reply({ content: [{ type: 'text', text: String((msg.params.arguments.a || 0) + (msg.params.arguments.b || 0)) }] })
      if (name === 'boom') return reply({ isError: true, content: [{ type: 'text', text: 'the fixture refuses' }] })
      if (name === 'leak') return reply({ content: [{ type: 'text', text: 'SECRET_IN_CHILD=' + (SECRET || 'absent') + ' APPKEY=' + (process.env.ZEN_APP_API_KEY || 'absent') }] })
      return reply({ content: [{ type: 'text', text: 'unknown tool' }] })
    }
    return err(-32601, 'Method not found')
  }
})
`,
  { mode: 0o644 },
)

const spec = (mode, extra = {}) => ({
  name: `fixture-${mode}`,
  command: process.execPath,
  args: [fixture],
  env: { MODE: mode, ...(extra.env || {}) },
  enabled: true,
  ...extra.without,
})

async function main() {
  /* ---------------------------------------------------------------- 1. the modern era */

  const modern = await mcp.connect(spec('modern'))
  check('a modern server is detected as modern', modern.era === 'modern', modern.era)
  check('its identity is read without a handshake', modern.info && modern.info.name === 'fixture', JSON.stringify(modern.info))
  check('its tools are listed', modern.tools.length === 3, `${modern.tools.length} tools`)

  const defs = mcp.defs()
  check('a tool is exposed under a prefixed name', defs.some((d) => d.function.name === `mcp__fixture-modern__add`), defs.map((d) => d.function.name).join(', '))
  const addDef = defs.find((d) => d.function.name.endsWith('__add'))
  check('its schema is passed through unchanged', addDef && addDef.function.parameters.required[0] === 'a', JSON.stringify(addDef && addDef.function.parameters.required))
  check('the description says which server it came from', addDef && /fixture-modern/.test(addDef.function.description), String(addDef && addDef.function.description))

  const sum = await mcp.callTool('mcp__fixture-modern__add', { a: 19, b: 23 })
  check('a tool call returns its content', sum.ok === true && sum.text === '42', sum.text)

  const boom = await mcp.callTool('mcp__fixture-modern__boom', {})
  check('a tool that fails is a result, not an exception', boom.ok === false && /refuses/.test(boom.text), boom.text)

  let threw = false
  try {
    await mcp.callTool('mcp__fixture-modern__nope', {})
  } catch {
    threw = true
  }
  const unknown = await mcp.callTool('mcp__fixture-modern__nope', {})
  check(
    'a tool the server does not know returns its own message, not a crash',
    unknown.text === 'unknown tool' || threw === true,
    unknown.text,
  )

  let badId = ''
  try {
    await mcp.callTool('generate_image', {})
  } catch (err) {
    badId = err.message
  }
  check('a name that is not an MCP tool is refused clearly', /not an MCP tool name/.test(badId), badId)

  /* ---------------------------------------------------------------- 2. the legacy era */

  const legacy = await mcp.connect(spec('legacy'))
  check('a server without the modern method is detected as legacy', legacy.era === 'legacy', legacy.era)
  check('its tools are still listed', legacy.tools.length === 3, `${legacy.tools.length} tools`)
  await mcp.stop(legacy)

  const picky = await mcp.connect(spec('picky'))
  check('a server that rejects the revision still counts as modern, and is not retried as legacy', picky.era === 'modern', picky.era)
  check('the supported revisions it named are kept', Array.isArray(picky.info.supported) && picky.info.supported[0] === '2025-11-25', JSON.stringify(picky.info.supported))
  await mcp.stop(picky)

  /* ---------------------------------------------------------------- 3. the banner on stdout */

  const banner = await mcp.connect(spec('banner'))
  check('a banner printed on stdout does not break the connection', banner.era === 'modern' && banner.tools.length === 3, `${banner.era}, ${banner.tools.length} tools`)
  check('the banner is kept as output instead of being thrown away', banner.stderr.some((l) => /npm notice/.test(l)), banner.stderr.slice(-1).join(''))
  await mcp.stop(banner)

  /* ---------------------------------------------------------------- 4. the environment */

  process.env.ZEN_APP_API_KEY = 'oc_sk_this_must_not_reach_the_child'
  const envSpec = spec('modern', { env: { SECRET_IN_CHILD: 'ghp_abcdefghijklmnopqrstuvwxyz012345' } })
  const envConn = await mcp.connect(envSpec)
  const leak = await mcp.callTool('mcp__fixture-modern__leak', {})
  check(
    'the child gets the environment it was configured with',
    /SECRET_IN_CHILD=ghp_/.test(leak.text),
    leak.text.slice(0, 60),
  )
  check(
    'the child does NOT inherit the app, so it cannot read the app API key',
    /APPKEY=absent/.test(leak.text),
    leak.text.slice(-24),
  )
  await mcp.stop(envConn)

  const built = mcp.childEnv({ PATH: 'x', SECRET: 'ghp_abc' })
  check('childEnv keeps the baseline a process needs to start', built.PATH === 'x' && typeof built.SystemRoot === 'string', Object.keys(built).length + ' vars')
  check('childEnv carries only what was configured, never the whole environment', built.ZEN_APP_API_KEY === undefined, String(built.ZEN_APP_API_KEY))

  /* ---------------------------------------------------------------- 5. redaction */

  const redacted = mcp.redact('key=oc_sk_9f8e7d6c5b4a Authorization: Bearer eyJhbGciOiJIUzI1NiJ9 ghp_abcdefghijklmnopqrstuvwxyz')
  check('a key in a log or an error is masked', !/oc_sk_[0-9a-f]{6}/.test(redacted) && !/ghp_[a-z]{10}/.test(redacted), redacted)
  check('a bearer token is masked', /Bearer …/.test(redacted), redacted)
  check('what the window sees proves a value is set without revealing it', mcp.redactedValue('oc_sk_abcdef123456') === '••••3456', mcp.redactedValue('oc_sk_abcdef123456'))
  check('an empty value reads as empty, not as a fake one', mcp.redactedValue('') === '', JSON.stringify(mcp.redactedValue('')))

  /* ---------------------------------------------------------------- 6. a hang, and a missing command */

  const t0 = Date.now()
  const hung = await mcp
    .connect(spec('hang'), { timeouts: { handshake: 1500, list: 1500, call: 1500 } })
    .catch((err) => ({ error: err }))
  check('a server that never answers fails instead of hanging', !!hung.error, String(hung.error && hung.error.message).slice(0, 80))
  const waited = Date.now() - t0
  check('and it fails on a timeout, not after an age', waited < 25_000, `${waited} ms`)

  const missing = await mcp.connect({ name: 'nothing', command: 'definitely-not-a-real-command-xyz', args: [], enabled: true }).catch((err) => ({ error: err }))
  check('a command that does not exist names the missing binary', /was not found on this machine/.test(String(missing.error && missing.error.message)), String(missing.error && missing.error.message))

  const resolved = mcp.resolveCommand('node')
  check(
    'a bare command is resolved on PATH, the way cmd would',
    !!resolved && resolved.missing === false && /node\.exe$/i.test(resolved.file),
    String(resolved && resolved.file),
  )
  check('a command that is nowhere is reported as missing, not guessed at', mcp.resolveCommand('no-such-binary-xyz').missing === true, 'missing')
  const shim = mcp.resolveCommand('npx')
  check(
    'a shim is recognised as needing cmd.exe to run it',
    shim.needsShell === /\.(cmd|bat)$/i.test(shim.file),
    `npx -> ${shim.file} needsShell=${shim.needsShell}`,
  )
  check('an argument with spaces is quoted for cmd', mcp.winQuote('a b') === '"a b"', mcp.winQuote('a b'))
  check('an argument that could chain a command is quoted, not passed through', mcp.winQuote('a & del /q x') === '"a & del /q x"', mcp.winQuote('a & del /q x'))

  /* ---------------------------------------------------------------- 7. no process is left behind */

  const conn = await mcp.connect(spec('modern'))
  const pid = conn.child.pid
  await mcp.stop(conn)
  await new Promise((r) => setTimeout(r, 400))
  let alive = true
  try {
    process.kill(pid, 0)
  } catch {
    alive = false
  }
  check('stopping a server really stops the process', alive === false, `pid ${pid} ${alive ? 'still alive' : 'gone'}`)
  check('and it is forgotten, so the next turn does not reuse a dead one', mcp.live.size === 0, `${mcp.live.size} live`)

  /* ---------------------------------------------------------------- 8. how it plugs into the app */

  const tools = require('../electron/tools.cjs')
  const cfg = { toolsEnabled: true, toolToggles: {} }
  const conn2 = await mcp.connect(spec('modern'))
  const withMcp = tools.chatToolDefs(cfg, mcp.defs())
  check(
    'a tool discovered at run time reaches the model’s tool list',
    withMcp.some((d) => d.function.name === 'mcp__fixture-modern__add'),
    `${withMcp.length} definitions`,
  )
  check(
    'and the app’s own tools are still there beside it',
    withMcp.some((d) => d.function.name === 'generate_image'),
    'generate_image present',
  )
  const turnedOff = tools.chatToolDefs({ toolsEnabled: false }, mcp.defs())
  check('the master switch still means no tools at all, MCP included', turnedOff.length === 0, `${turnedOff.length} definitions`)

  const viaBridge = await tools.executeTool('mcp__fixture-modern__add', JSON.stringify({ a: 1, b: 2 }), {
    mcp: { call: (n, a) => mcp.callTool(n, a) },
  })
  check('the tool loop can run an MCP tool through the bridge', viaBridge.ok === true && viaBridge.text === '3', viaBridge.text)

  const noBridge = await tools.executeTool('mcp__fixture-modern__add', '{}', {})
  check('without a bridge it refuses instead of pretending', noBridge.ok === false && /not available/.test(noBridge.error), String(noBridge.error))

  await mcp.stop(conn2)
  const dead = await tools.executeTool('mcp__fixture-modern__add', '{}', { mcp: { call: (n, a) => mcp.callTool(n, a) } })
  check('a dead server returns a failed tool result rather than hanging the turn', dead.ok === false && /not running|MCP server problem/.test(String(dead.error)), String(dead.error).slice(0, 70))

  const summary = mcp.status()
  check('status is empty once everything is stopped', summary.length === 0, `${summary.length} entries`)

  await mcp.closeAll()
  fs.rmSync(dir, { recursive: true, force: true })

  console.log(`\n${pass}/${pass + fail} checks passed`)
  process.exit(fail ? 1 : 0)
}

main().catch((err) => {
  console.error('the test itself failed:', err)
  process.exit(2)
})
