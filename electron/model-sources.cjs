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
  const localUrl = localPort ? normalize(`http://127.0.0.1:${localPort}/v1`) : ''
  // A model list you cannot use is not a choice. A provider appears only once it has a key of its
  // own: OpenRouter and the OpenCode relay both hand out a catalogue to anyone who asks, so
  // listing them before a key exists filled the picker with models that could only ever fail. A
  // server on this machine is the exception, because it has no key to give and needs none.
  const onThisMachine = (url) => {
    const n = normalize(url)
    if (!n) return false
    if (localUrl && n === localUrl) return true
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(n)
  }
  const add = (provider, baseUrl, key) => {
    const norm = normalize(baseUrl)
    if (!norm || seen.has(norm)) return
    seen.add(norm)
    out.push({ provider: String(provider || '').trim() || 'Endpoint', baseUrl: norm, key: key || '' })
  }
  // The endpoint in use is always worth asking, whatever its profile says. It used to be listed
  // only when NO profile matched it, so the provider a person was actually using disappeared from
  // the list as soon as it had a saved profile carrying no key of its own: this branch was skipped
  // for having a match, and the loop below skipped the profile for having no key. Pressing Test
  // wrote a key into the profile, which is why the models only appeared after that. keyFor already
  // prefers the profile's key and falls back to the app's, and a local endpoint needs neither.
  if (current) {
    const key = keyFor(cfg)
    if (key || onThisMachine(current)) add((match && match.name) || host, cfg && cfg.baseUrl, key)
  }
  // Each provider is asked with its own key, and only when it has one. A second paid provider
  // cannot list its models off someone else's key, so the app's own key is not a substitute.
  for (const p of profiles) {
    const key = String((p && p.apiKey) || '').trim()
    if (key || onThisMachine(p && p.baseUrl)) add(p && p.name, p && p.baseUrl, key)
  }
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
