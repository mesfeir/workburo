/*
 * Server mode: does the app's own HTTP surface behave?
 *
 * Two things are checked here, and the first is the one that keeps this honest over time:
 *
 *   1. COVERAGE. Every IPC channel the desktop app uses must either have an HTTP route or be listed
 *      as deliberately not available on the web, with a reason. Without this, the phone silently
 *      drifts behind the desktop -- a feature gets built, the web surface never learns about it, and
 *      nobody notices until someone taps it on a phone.
 *
 *   2. BEHAVIOUR. The server really starts, really refuses a wrong key, really serves the app's own
 *      renderer with the phone's head injected, and really refuses to spend anything without the key.
 *
 * Run: node scripts/test-web.cjs
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const ROOT = path.join(__dirname, '..')
let passed = 0
let failed = 0
const failures = []

function check(name, cond, detail) {
  if (cond) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`  FAIL ${name}${detail ? '  -- ' + detail : ''}`)
  }
}

/*
 * Channels that are meant to be desktop-only, each with the reason. Adding a channel to the app
 * without deciding one way or the other fails this test on purpose.
 */
const DESKTOP_ONLY = {
  'theme:apply': 'the phone has its own system theme',
  'chat:abort': 'not yet routed -- streams are ended by the phone closing them',
  'pi:install': 'installing the agent needs a native binary and a network of its own',
  'pi:uninstall': 'the agent belongs to the host machine',
  'pi:pickWorkspace': 'there is no folder picker on a phone',
  'pi:openWorkspace': 'the folder is on the host, not the phone',
  'local:status': 'the local model runs on the host; status is shown through /api/models',
  'local:install': 'models are downloaded by the host',
  'local:start': 'the host starts its own model server',
  'local:stop': 'the host stops its own model server',
  'local:detect': 'about the host machine',
  'local:open': 'opens a folder on the host',
  'models:probe': 'not yet routed',
  'app:info': 'about the host application',
  'app:setHotkey': 'a phone has no global shortcut',
  'app:getHotkey': 'a phone has no global shortcut',
  'app:getLoginItem': 'start-on-login is a host setting',
  'app:setLoginItem': 'start-on-login is a host setting',
  'mcp:test': 'MCP servers run on the host',
  'mcp:status': 'MCP servers run on the host',
  'mcp:stop': 'MCP servers run on the host',
  'tools:list': 'tools belong to the host agent',
  'tools:probe': 'tools belong to the host agent',
  'search:docker': 'docker runs on the host',
  'search:install': 'installing a search engine is a host action',
  'window:hide': 'there is no window to hide',
  'window:resetBounds': 'there is no window geometry',
  'app:openStore': 'opens a folder on the host',
  'images:cost': 'not yet routed',
  'images:prices': 'not yet routed',
  'images:dataUrl': 'not yet routed -- the phone receives data URLs with the picture',
  'open:external': 'not yet routed',
  'apps:list': 'Composio apps are configured on the host',
  'apps:connections': 'Composio apps are configured on the host',
  'apps:connect': 'Composio apps are configured on the host',
  'apps:status': 'Composio apps are configured on the host',
  'files:open': 'opens a file with a host application',
  'files:reveal': 'reveals a file in a host file manager',
  'images:saveAs': 'a browser downloads instead of writing to a chosen path',
  'images:openFolder': 'opens a folder on the host',
  'app:pickImages': 'the phone has its own picker',
}

/* Channels with a route, and the route that serves them. */
const ROUTED = {
  'chat:start': '/api/chat',
  'chat:title': '/api/title',
  'models:list': '/api/models',
  'models:all': '/api/models',
  'pi:status': '/api/pi/status',
  'pi:turn': '/api/pi/turn',
  'pi:stop': '/api/pi/stop',
  'agent:sessions': '/api/pi/sessions',
  'images:generate': '/api/image',
  'images:models': '/api/image-models',
  'images:options': '/api/config',
  'files:add': '/api/upload',
  'store:get': '/api/store',
  'store:save': '/api/store',
  'store:flush': '/api/store',
}

function channelsInMain() {
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'main.cjs'), 'utf8')
  const out = []
  const re = /ipcMain\.handle\(\s*'([^']+)'/g
  let m
  while ((m = re.exec(src))) out.push(m[1])
  return out
}

function routesInServer() {
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'server.cjs'), 'utf8')
  const out = []
  const re = /'(\/api\/[^']*)':\s*\{/g
  let m
  while ((m = re.exec(src))) out.push(m[1])
  return out
}

const request = (options, body) =>
  new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })

async function main() {
  console.log('server mode: coverage and behaviour\n')

  const channels = channelsInMain()
  const routes = routesInServer()
  check(`the app has IPC channels to account for (${channels.length})`, channels.length > 40)
  check(`the server has routes (${routes.length})`, routes.length > 8)

  const unaccounted = channels.filter((c) => !DESKTOP_ONLY[c] && !ROUTED[c])
  check('every channel is either routed or declared desktop-only', unaccounted.length === 0, unaccounted.join(', '))

  const staleRoutes = Object.values(ROUTED).filter((r) => !routes.includes(r))
  check('every route named in the map exists in the server', staleRoutes.length === 0, staleRoutes.join(', '))

  const staleExclusions = Object.keys(DESKTOP_ONLY).filter((c) => !channels.includes(c))
  check('no exclusion names a channel that no longer exists', staleExclusions.length === 0, staleExclusions.join(', '))

  const wronglyRouted = Object.entries(ROUTED).filter(([c]) => DESKTOP_ONLY[c])
  check('no channel is both routed and excluded', wronglyRouted.length === 0, wronglyRouted.map(([c]) => c).join(', '))

  /* behaviour: really start it */
  const server = require(path.join(ROOT, 'electron', 'server.cjs'))
  const key = server.keygen()
  check('a generated key is long enough to be a secret', key.length >= 40, `got ${key.length}`)

  const appData = process.env.APPDATA || path.join(process.env.HOME || '.', 'AppData', 'Roaming')
  const store = path.join(appData, 'WorkBuro', 'zen-chat-store.json')
  check('the app store to serve is present', fs.existsSync(store), store)

  const status = await server.start({
    rendererDir: path.join(ROOT, 'dist'),
    store,
    imagesDir: path.join(appData, 'WorkBuro', 'images'),
    piRoot: path.join(appData, 'WorkBuro', 'pi'),
    agentExt: path.join(appData, 'WorkBuro', 'agent-ext'),
    key,
    port: 8391,
    bind: '127.0.0.1',
  })
  check('the server reports it is running', status.running === true)
  check('it knows an address to print', Array.isArray(status.addresses) && status.addresses.length > 0, JSON.stringify(status.addresses))
  check('the key is held, never returned', status.keySet === true && !JSON.stringify(status).includes(key))

  const base = { host: '127.0.0.1', port: 8391 }

  const health = await request({ ...base, path: '/api/health', method: 'GET' })
  check('health answers without a key (so the settings pane can self-test)', health.status === 200, String(health.status))
  check('health does not leak the key', !health.body.includes(key))

  const noKey = await request({ ...base, path: '/api/config', method: 'GET' })
  check('a request with no key is refused', noKey.status === 401, String(noKey.status))

  const wrongKey = await request({ ...base, path: '/api/config', method: 'GET', headers: { authorization: 'Bearer not-the-key' } })
  check('a request with a wrong key is refused', wrongKey.status === 401, String(wrongKey.status))

  const rightKey = await request({ ...base, path: '/api/config', method: 'GET', headers: { authorization: `Bearer ${key}` } })
  check('a request with the key is served', rightKey.status === 200, String(rightKey.status))
  let cfg = {}
  try { cfg = JSON.parse(rightKey.body) } catch {}
  check('the settings it returns carry no provider key', !JSON.stringify(cfg).includes('apiKey') && cfg.falKey === undefined)
  check('it reports whether images are possible without naming the key', typeof cfg.hasFalKey === 'boolean')

  const page = await request({ ...base, path: '/', method: 'GET' })
  check('the phone page is served', page.status === 200, String(page.status))
  check('it is the app\'s own renderer', /<div id="root">/.test(page.body) && /assets\/index-/.test(page.body))
  check('the phone head is injected', page.body.includes('user-scalable=no') && page.body.includes('safe-area-inset-top'))
  check('the bridge loads before the app bundle', page.body.indexOf('/bridge.js') < page.body.indexOf('assets/index-'))

  const bridge = await request({ ...base, path: '/bridge.js', method: 'GET' })
  check('the bridge is served', bridge.status === 200 && bridge.body.includes('window.zen'), String(bridge.status))

  const manifest = await request({ ...base, path: '/manifest.webmanifest', method: 'GET' })
  check('the manifest is served', manifest.status === 200)
  check('the manifest carries no key in its start_url', (() => {
    try { const m = JSON.parse(manifest.body); return m.start_url === '/' } catch { return false }
  })())

  /* the icons the manifest and the page promise, so a Home Screen icon is not a broken image */
  for (const icon of ['/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']) {
    const r = await request({ ...base, path: icon, method: 'GET' })
    check(`${icon} is served as a png`, r.status === 200 && r.headers['content-type'] === 'image/png', `${r.status} ${r.headers['content-type']}`)
  }

  const missing = await request({ ...base, path: '/api/nope', method: 'GET', headers: { authorization: `Bearer ${key}` } })
  check('an unknown route is a clean 404', missing.status === 404, String(missing.status))

  const wrongMethod = await request({ ...base, path: '/api/chat', method: 'GET', headers: { authorization: `Bearer ${key}` } })
  check('a wrong method is refused', wrongMethod.status === 405, String(wrongMethod.status))

  const log = await request({ ...base, path: '/api/log', method: 'GET', headers: { authorization: `Bearer ${key}` } })
  let entries = { entries: [], refusals: 0 }
  try { entries = JSON.parse(log.body) } catch {}
  check('the refusals were counted', entries.refusals >= 2, String(entries.refusals))
  check('the log records what happened, without the key', Array.isArray(entries.entries) && entries.entries.length > 4 && !log.body.includes(key))

  const stopped = await server.stop()
  check('the server stops cleanly', stopped.running === false)

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) {
    console.log('failed: ' + failures.join('; '))
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('the test itself broke:', err)
  process.exit(1)
})
