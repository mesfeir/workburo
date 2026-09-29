/**
 * Composio, over plain REST.
 *
 * Why not the SDK: `@composio/core` is ESM-only and declares engines.node >= 22.22.3, while
 * Electron 35's main process is CommonJS on Node 22.16 — it cannot be required here at all. So this
 * talks to the documented v3.1 REST API with the built-in fetch.
 *
 * The endpoints and field names below come from the official reference (docs.composio.dev), not from
 * memory, and the places the documentation is silent are marked. Two of those matter enough to spell
 * out:
 *
 *   • The connect URL is read from the response's `redirect_url`. It is NOT constructed here —
 *     no `connect.composio.dev/link/ln_…` string is built anywhere in this file.
 *   • Tool execution is judged by the response's top-level `successful`, with the payload in `data`
 *     and the reason in `error`. A 200 does not mean the tool worked.
 *
 * Everything network-facing lives here, in main, so the API key never enters the renderer. `fetchImpl`
 * is injectable so scripts/test-composio.cjs can exercise every request shape offline.
 */

const BASE = 'https://backend.composio.dev/api/v3.1'

/** Documented connected-account statuses. Only ACTIVE can run tools. */
const ACTIVE = 'ACTIVE'
const PENDING = new Set(['INITIALIZING', 'INITIATED'])

/** Turn an HTTP failure into something worth showing a person. */
function explain(status, json, retryAfter) {
  const detail =
    (json && json.error && (json.error.message || json.error.slug)) ||
    (json && json.message) ||
    ''
  if (status === 401 || status === 403) {
    return {
      fatal: true,
      error:
        'Composio refused that API key. Check it in Settings → Connected apps — a project key starts with ak_.',
    }
  }
  if (status === 429) {
    return {
      error: `Composio is rate limiting this key${retryAfter ? ` — try again in ${retryAfter}s` : ''}. ${detail}`.trim(),
    }
  }
  return { error: detail || `Composio answered ${status}.` }
}

function makeClient({ apiKey, userId, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch
  const uid = () => String(userId || 'zen-chat-user')

  async function call(path, { method = 'GET', body, query } = {}) {
    if (!apiKey) {
      return {
        ok: false,
        fatal: true,
        error: 'No Composio API key is saved. Add one in Settings → Connected apps.',
      }
    }
    if (typeof doFetch !== 'function') {
      return { ok: false, fatal: true, error: 'This build cannot make network requests.' }
    }

    const url = new URL(BASE + path)
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }

    let res
    try {
      res = await doFetch(url.toString(), {
        method,
        headers: { 'x-api-key': String(apiKey), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (err) {
      return { ok: false, error: `Could not reach Composio: ${(err && err.message) || 'network error'}` }
    }

    let json = null
    try {
      const text = await res.text()
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }

    if (!res.ok) {
      const { error, fatal } = explain(res.status, json, res.headers && res.headers.get && res.headers.get('retry-after'))
      return { ok: false, status: res.status, error, fatal }
    }
    return { ok: true, data: json }
  }

  /* ------------------------------------------------------------------ apps */

  /** Apps (toolkits) someone can connect. `search` is the documented name filter. */
  async function listApps(query, limit = 40) {
    const r = await call('/toolkits', {
      query: { search: query, sort_by: query ? undefined : 'usage', limit },
    })
    if (!r.ok) return r
    const items = (r.data && r.data.items) || []
    return {
      ok: true,
      apps: items.map((t) => ({
        slug: t.slug,
        name: t.name || t.slug,
        description: (t.meta && t.meta.description) || '',
        logo: (t.meta && t.meta.logo) || '',
        noAuth: !!t.no_auth,
        tools: (t.meta && t.meta.tools_count) || 0,
      })),
    }
  }

  /* ------------------------------------------------------- connecting an app */

  /**
   * A Composio-managed auth config for a toolkit: reuse the account's if there is one, otherwise
   * create it. Managed means Composio holds the OAuth credentials, so the user only has to click a
   * connect link — the app never needs its own client id for Gmail, Slack, and so on.
   *
   * The docs show the managed create body as a schema default rather than a worked example, so this
   * sends the documented key names and reports plainly if the API disagrees rather than pretending.
   */
  async function authConfigFor(slug) {
    const found = await call('/auth_configs', {
      query: { toolkit_slug: slug, is_composio_managed: 'true' },
    })
    if (!found.ok) return found
    const items = (found.data && found.data.items) || []
    const usable = items.find((c) => !c.is_disabled && c.status !== 'DISABLED')
    if (usable && usable.id) return { ok: true, id: usable.id, existing: true }

    const made = await call('/auth_configs', {
      method: 'POST',
      body: {
        toolkit: { slug },
        auth_config: { type: 'use_composio_managed_auth' },
      },
    })
    if (!made.ok) {
      return {
        ok: false,
        fatal: made.fatal,
        error: `Could not set up managed sign-in for ${slug}. ${made.error || ''}`.trim(),
      }
    }
    const id = made.data && made.data.auth_config && made.data.auth_config.id
    if (!id) {
      return { ok: false, error: `Composio did not return an auth config id for ${slug}.` }
    }
    return { ok: true, id, existing: false }
  }

  /**
   * Start a connection and hand back the URL the user must open. Only the URL the API returns is
   * used — it is short-lived (the docs say ten minutes), so it is fetched fresh each time rather
   * than cached or rebuilt.
   */
  async function startConnection(slug) {
    const cfg = await authConfigFor(slug)
    if (!cfg.ok) return cfg
    const link = await call('/connected_accounts/link', {
      method: 'POST',
      body: { auth_config_id: cfg.id, user_id: uid() },
    })
    if (!link.ok) return link
    const d = link.data || {}
    if (!d.redirect_url) {
      return { ok: false, error: `Composio did not return a connect link for ${slug}.` }
    }
    return {
      ok: true,
      app: slug,
      url: d.redirect_url,
      accountId: d.connected_account_id || '',
      expiresAt: d.expires_at || '',
    }
  }

  /** One connected account's state. */
  async function accountStatus(id) {
    const r = await call(`/connected_accounts/${encodeURIComponent(id)}`)
    if (!r.ok) return r
    const d = r.data || {}
    return {
      ok: true,
      id: d.id || id,
      status: String(d.status || '').toUpperCase(),
      reason: d.status_reason || '',
      app: (d.toolkit && d.toolkit.slug) || '',
    }
  }

  /** Every connection this user has, newest first — the app's own view of what is connected. */
  async function connections() {
    const r = await call('/connected_accounts', {
      query: { user_ids: uid(), limit: 100, order_by: 'created_at', order_direction: 'desc' },
    })
    if (!r.ok) return r
    const items = (r.data && r.data.items) || []
    const out = []
    const seen = new Map()
    for (const c of items) {
      const slug = (c.toolkit && c.toolkit.slug) || ''
      const status = String(c.status || '').toUpperCase()
      // a newer connection for the same app supersedes an older dead one
      if (slug && seen.has(slug) && !PENDING.has(status)) continue
      if (slug) seen.set(slug, true)
      out.push({
        id: c.id,
        app: slug,
        status,
        reason: c.status_reason || '',
        createdAt: c.created_at || '',
        active: status === ACTIVE,
      })
    }
    return { ok: true, connections: out }
  }

  /** The id of the live connection for an app, or an honest reason there is not one. */
  async function activeAccountFor(slug) {
    const all = await connections()
    if (!all.ok) return all
    const mine = all.connections.filter((c) => c.app === slug)
    const active = mine.find((c) => c.active)
    if (active) return { ok: true, id: active.id }
    const pending = mine.find((c) => PENDING.has(c.status))
    if (pending) {
      return {
        ok: false,
        error: `${slug} is not connected yet — the sign-in was started but not finished. Finish it in Settings → Connected apps, then ask again.`,
      }
    }
    return {
      ok: false,
      error: `${slug} is not connected. Connect it in Settings → Connected apps, then ask again.`,
    }
  }

  /* ----------------------------------------------------------------- tools */

  /** The tools a connected app offers, with the input schema the model has to fill in. */
  async function toolsFor(slug, query, limit = 30) {
    const r = await call('/tools', {
      query: { toolkit_slug: slug, query, limit, toolkit_versions: 'latest' },
    })
    if (!r.ok) return r
    const items = (r.data && r.data.items) || []
    return {
      ok: true,
      tools: items.map((t) => ({
        slug: t.slug,
        name: t.name || t.slug,
        description: t.description || t.human_description || '',
        input: t.input_parameters || null,
        deprecated: !!t.is_deprecated,
      })),
    }
  }

  /**
   * Run a tool. The account and user are filled in here, so the model never sees — and can never
   * invent — a connected account id.
   *
   * A 200 is not success: the docs put the verdict in `successful` and the payload in `data`.
   */
  async function runTool(slug, args) {
    const app = String(slug || '').split('_')[0].toLowerCase()
    const account = await activeAccountFor(app)
    if (!account.ok) return account

    const r = await call(`/tools/execute/${encodeURIComponent(slug)}`, {
      method: 'POST',
      body: {
        user_id: uid(),
        connected_account_id: account.id,
        version: 'latest',
        arguments: args && typeof args === 'object' ? args : {},
      },
    })
    if (!r.ok) return r
    const d = r.data || {}
    if (d.successful === false) {
      return { ok: false, error: String(d.error || 'The app refused that action.') }
    }
    return { ok: true, data: d.data, logId: d.log_id || '' }
  }

  return { listApps, authConfigFor, startConnection, accountStatus, connections, activeAccountFor, toolsFor, runTool }
}

module.exports = { makeClient, BASE, ACTIVE, PENDING }
