// Which places are worth asking for a model list. Pure and dependency-free, so the ranking and
// de-duplication can be tested without Electron or a network: the fetching lives in main.cjs.
//
// The order matters, because it is the order a person would look in: the endpoint they are using
// right now, then the profiles they saved, then the model server on this machine.

/**
 * The key a request should go out with. The provider in use wins, because a second paid provider
 * cannot work off someone else's key. This is the same rule the model list uses, applied to every
 * request, so a Test that passes and a chat that fails can no longer be two different keys.
 */
function keyFor (cfg) {
  const c = cfg || {}
  const current = normalize(c.baseUrl)
  const match = (c.profiles || []).find((p) => p && normalize(p.baseUrl) === current && current)
  return (match && match.apiKey) || c.apiKey || ''
}

const KEY_SHAPED = /\b(?:sk|oc_sk|ak|fal|nvapi|xai|r8)[-_][A-Za-z0-9_-]{10,}\b/g

/**
 * Errors are for the person reading them. A provider's "You can find your API key at <url>" is
 * advertising, not diagnosis, and a half-printed credential is not ours to show. Both go.
 */
function scrubMessage (msg) {
  return String(msg || '')
    .replace(/you can find your api key at\s*<?[^>.\s]*>?\.?/gi, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(KEY_SHAPED, '[key]')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;])/g, '$1')
    .trim()
}

/** Tidy an endpoint into something we can append /models to. Empty stays empty. */
function normalize (url) {
  const t = String(url || '').trim().replace(/\/+$/, '')
  if (!t) return ''
  return /^https?:\/\//i.test(t) ? t : `https://${t}`
}

/**
 * The list of sources to ask, de-duplicated by endpoint so a profile that matches the endpoint in
 * use does not appear twice. A source keeps the key it should be asked with: profiles share the
 * one key the app holds, while a local server needs none.
 */
function sourcesFor (cfg, localPort) {
  const out = []
  const seen = new Set()
  const profiles = (cfg && cfg.profiles) || []
  // The endpoint in use is headed with the profile it came from, so the list reads like the
  // providers a person recognises. If it matches no profile, name it by its host rather than
  // saying "This endpoint", which told you nothing about where the models came from.
  const current = normalize(cfg && cfg.baseUrl)
  const match = profiles.find((p) => p && normalize(p.baseUrl) === current && current)
  const host = current ? current.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') : ''
  const add = (provider, baseUrl, key) => {
    const norm = normalize(baseUrl)
    if (!norm || seen.has(norm)) return
    seen.add(norm)
    out.push({ provider: String(provider || '').trim() || 'Endpoint', baseUrl: norm, key: key || '' })
  }
  add(match ? match.name : host, cfg && cfg.baseUrl, keyFor(cfg))
  // Each provider is asked with its own key when it has one. That is the whole point of keeping a
  // key per profile: a second paid provider cannot list its models off someone else's key.
  for (const p of profiles) add(p && p.name, p && p.baseUrl, (p && p.apiKey) || (cfg && cfg.apiKey))
  if (localPort) add('On this machine', `http://127.0.0.1:${localPort}/v1`, '')
  return out
}

/** Read an OpenAI-shaped model list out of whatever an endpoint returned. */
function parseModels (json) {
  const raw = (json && (json.data || json.models)) || []
  const list = Array.isArray(raw) ? raw : []
  return list
    // An entry with neither a name nor an id is not a model. Some endpoints pad their list with
    // objects, and without this they arrived as "[object Object]" and looked like a real choice.
    .filter((m) => m && typeof m === 'object' && (typeof m.id === 'string' || typeof m.id === 'number' || typeof m.name === 'string'))
    .map((m) => ({
      id: String((m && (m.id || m.name)) || ''),
      created: (m && m.created) || 0,
      ownedBy: (m && (m.owned_by || m.ownedBy)) || '',
      contextLength: (m && (m.context_length || m.context_window)) || null,
    }))
    .filter((m) => m.id)
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** Turn a refusal into something short a person can read, and keep it honest. */
function tidyError (status, message) {
  if (status === 401 || status === 403) return 'needs a key'
  const text = String(message || '').trim()
  if (!text || /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(text)) return 'not reachable'
  return text.slice(0, 80)
}

module.exports = { sourcesFor, normalize, parseModels, tidyError, keyFor, scrubMessage }
