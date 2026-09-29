/**
 * Composio, without a key and without the network.
 *
 * The failures worth guarding against here are the quiet ones: the wrong auth header, a connect URL
 * this app made up instead of the one Composio returned, a tool that answered 200 while reporting
 * `successful: false`, or an account id the model was allowed to invent. So every check below reads
 * the request that was actually sent, or the way a response was interpreted.
 */
const assert = require('node:assert')

const { makeClient, BASE, ACTIVE } = require('../electron/composio.cjs')

let passed = 0
let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
    passed += 1
  } catch (err) {
    console.log(`FAIL  ${name}\n        ${err.message}`)
    failed += 1
  }
}

/** A fetch that records what it was asked to do and answers with whatever the test wants. */
function fakeFetch(answers) {
  const calls = []
  const queue = Array.isArray(answers) ? [...answers] : null
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body ? JSON.parse(init.body) : null })
    const answer = queue ? queue.shift() : answers
    const a = answer || { status: 200, json: {} }
    const status = a.status || 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => (a.headers && a.headers[k.toLowerCase()]) || null },
      text: async () => JSON.stringify(a.json === undefined ? {} : a.json),
    }
  }
  fetchImpl.calls = calls
  return fetchImpl
}

const client = (fetchImpl, extra = {}) =>
  makeClient({ apiKey: 'ak_test_key', userId: 'zen-user-1', fetchImpl, ...extra })

;(async () => {
  /* ------------------------------------------------------------ requests are right */

  await check('the key goes in x-api-key, against the documented base URL', async () => {
    const f = fakeFetch({ json: { items: [] } })
    await client(f).listApps('gmail')
    const c = f.calls[0]
    assert.strictEqual(c.headers['x-api-key'], 'ak_test_key', `headers were ${JSON.stringify(c.headers)}`)
    assert.ok(c.url.startsWith(`${BASE}/toolkits`), `url was ${c.url}`)
    assert.match(c.url, /search=gmail/)
  })

  await check('with no key it says where to add one, and never calls out', async () => {
    const f = fakeFetch({ json: {} })
    const r = await makeClient({ fetchImpl: f }).listApps('gmail')
    assert.strictEqual(r.ok, false)
    assert.match(r.error, /Settings → Connected apps/)
    assert.strictEqual(f.calls.length, 0, 'it tried the network anyway')
  })

  await check('an app name is turned into a searchable, usable list', async () => {
    const f = fakeFetch({
      json: {
        items: [
          { slug: 'gmail', name: 'Gmail', no_auth: false, meta: { description: 'Email', tools_count: 42, logo: 'x' } },
        ],
      },
    })
    const r = await client(f).listApps('gmail')
    assert.ok(r.ok, r.error)
    assert.deepStrictEqual(r.apps[0], {
      slug: 'gmail',
      name: 'Gmail',
      description: 'Email',
      logo: 'x',
      noAuth: false,
      tools: 42,
    })
  })

  /* ------------------------------------------------------------ auth configs */

  await check('an existing managed auth config is reused instead of making another', async () => {
    const f = fakeFetch({ json: { items: [{ id: 'ac_1', is_composio_managed: true, auth_scheme: 'OAUTH2' }] } })
    const r = await client(f).authConfigFor('gmail')
    assert.ok(r.ok, r.error)
    assert.strictEqual(r.id, 'ac_1')
    assert.strictEqual(f.calls.length, 1, 'it created one when it did not need to')
  })

  await check('with none, one is created with the documented body', async () => {
    const f = fakeFetch([
      { json: { items: [] } },
      { json: { toolkit: { slug: 'gmail' }, auth_config: { id: 'ac_new', is_composio_managed: true } } },
    ])
    const r = await client(f).authConfigFor('gmail')
    assert.ok(r.ok, r.error)
    assert.strictEqual(r.id, 'ac_new')
    const post = f.calls[1]
    assert.strictEqual(post.method, 'POST')
    assert.ok(post.url.endsWith('/auth_configs'))
    assert.strictEqual(post.body.toolkit.slug, 'gmail')
    assert.strictEqual(post.body.auth_config.type, 'use_composio_managed_auth')
  })

  /* ------------------------------------------------------------ connecting */

  await check('the connect URL is the one Composio returned, never one this app built', async () => {
    const returned = 'https://backend.composio.dev/some/returned/link/abc123'
    const f = fakeFetch([
      { json: { items: [{ id: 'ac_1', is_composio_managed: true }] } },
      { json: { redirect_url: returned, connected_account_id: 'ca_9', link_token: 'lt', expires_at: 'soon' } },
    ])
    const r = await client(f).startConnection('gmail')
    assert.ok(r.ok, r.error)
    assert.strictEqual(r.url, returned, `app returned ${r.url}`)
    assert.strictEqual(r.accountId, 'ca_9')
    const post = f.calls[1]
    assert.ok(post.url.endsWith('/connected_accounts/link'))
    assert.strictEqual(post.body.auth_config_id, 'ac_1')
    assert.strictEqual(post.body.user_id, 'zen-user-1', 'the user id the app invents must be sent')
  })

  await check('a link that comes back without a URL is an error, not an empty click', async () => {
    const f = fakeFetch([
      { json: { items: [{ id: 'ac_1', is_composio_managed: true }] } },
      { json: { connected_account_id: 'ca_9' } },
    ])
    const r = await client(f).startConnection('gmail')
    assert.strictEqual(r.ok, false)
    assert.match(r.error, /connect link/i)
  })

  await check('connection state is read from status, and only ACTIVE counts as connected', async () => {
    const f = fakeFetch({
      json: {
        items: [
          { id: 'ca_1', status: 'INITIALIZING', toolkit: { slug: 'gmail' } },
          { id: 'ca_2', status: 'ACTIVE', toolkit: { slug: 'slack' } },
          { id: 'ca_3', status: 'FAILED', toolkit: { slug: 'notion' }, status_reason: 'user denied' },
        ],
      },
    })
    const r = await client(f).connections()
    assert.ok(r.ok, r.error)
    const byApp = Object.fromEntries(r.connections.map((c) => [c.app, c]))
    assert.strictEqual(byApp.gmail.active, false)
    assert.strictEqual(byApp.slack.active, true)
    assert.strictEqual(byApp.notion.status, 'FAILED')
    assert.match(byApp.notion.reason, /denied/)
    assert.strictEqual(ACTIVE, 'ACTIVE')
  })

  await check('an app that is not connected is refused with the place to fix it', async () => {
    const f = fakeFetch({ json: { items: [] } })
    const r = await client(f).activeAccountFor('gmail')
    assert.strictEqual(r.ok, false)
    assert.match(r.error, /Settings → Connected apps/)
  })

  await check('a half-finished sign-in is told apart from no sign-in', async () => {
    const f = fakeFetch({ json: { items: [{ id: 'ca_1', status: 'INITIATED', toolkit: { slug: 'gmail' } }] } })
    const r = await client(f).activeAccountFor('gmail')
    assert.strictEqual(r.ok, false)
    assert.match(r.error, /not finished|not connected yet/i, `said: ${r.error}`)
  })

  /* ------------------------------------------------------------ tools */

  await check('an app’s tools come back with the schema the model must fill in', async () => {
    const f = fakeFetch({
      json: {
        items: [
          {
            slug: 'GMAIL_SEND_EMAIL',
            name: 'Send email',
            description: 'Send an email',
            input_parameters: { type: 'object', properties: { to: { type: 'string', required: true } } },
          },
        ],
      },
    })
    const r = await client(f).toolsFor('gmail', 'send')
    assert.ok(r.ok, r.error)
    assert.strictEqual(r.tools[0].slug, 'GMAIL_SEND_EMAIL')
    assert.ok(r.tools[0].input.properties.to, 'the input schema was dropped')
    const c = f.calls[0]
    assert.match(c.url, /toolkit_slug=gmail/)
    assert.match(c.url, /query=send/)
    assert.match(c.url, /toolkit_versions=latest/, 'tool execution needs an explicit toolkit version')
  })

  await check('running a tool fills in the account itself, so the model cannot invent one', async () => {
    const f = fakeFetch([
      { json: { items: [{ id: 'ca_live', status: 'ACTIVE', toolkit: { slug: 'gmail' } }] } },
      { json: { successful: true, data: { id: 'msg_1' }, log_id: 'log_1' } },
    ])
    const r = await client(f).runTool('GMAIL_SEND_EMAIL', { to: 'a@b.c' })
    assert.ok(r.ok, r.error)
    assert.deepStrictEqual(r.data, { id: 'msg_1' })
    const post = f.calls[1]
    assert.ok(post.url.endsWith('/tools/execute/GMAIL_SEND_EMAIL'), `url was ${post.url}`)
    assert.strictEqual(post.body.connected_account_id, 'ca_live')
    assert.strictEqual(post.body.user_id, 'zen-user-1')
    assert.strictEqual(post.body.version, 'latest')
    assert.deepStrictEqual(post.body.arguments, { to: 'a@b.c' })
  })

  await check('a 200 that reports failure is a failure', async () => {
    const f = fakeFetch([
      { json: { items: [{ id: 'ca_live', status: 'ACTIVE', toolkit: { slug: 'gmail' } }] } },
      { json: { successful: false, error: 'insufficient scope', data: null } },
    ])
    const r = await client(f).runTool('GMAIL_SEND_EMAIL', {})
    assert.strictEqual(r.ok, false, 'a 200 was treated as success')
    assert.match(r.error, /insufficient scope/)
  })

  await check('running a tool for an unconnected app never reaches the API', async () => {
    const f = fakeFetch({ json: { items: [] } })
    const r = await client(f).runTool('SLACK_SEND_MESSAGE', { text: 'hi' })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(f.calls.length, 1, 'it tried to execute anyway')
  })

  /* ------------------------------------------------------------ failures are worth reading */

  await check('a rejected key is fatal, and says so in plain words', async () => {
    const f = fakeFetch({ status: 401, json: { error: { message: 'No authentication provided', status: 401 } } })
    const r = await client(f).listApps('gmail')
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.fatal, true)
    assert.match(r.error, /starts with ak_/)
  })

  await check('a rate limit is reported with the wait, not as a mystery', async () => {
    const f = fakeFetch({ status: 429, headers: { 'retry-after': '30' }, json: { message: 'Rate limit exceeded' } })
    const r = await client(f).listApps('gmail')
    assert.strictEqual(r.ok, false)
    assert.match(r.error, /30s/)
  })

  await check('a network that is down is not an empty list', async () => {
    const f = async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }
    const r = await client(f).connections()
    assert.strictEqual(r.ok, false)
    assert.match(r.error, /Could not reach Composio/)
  })

  console.log(`\n${passed}/${passed + failed} checks passed`)
  process.exit(failed ? 1 : 0)
})()
