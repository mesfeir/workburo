// Which places are worth asking for a model list. Pure and dependency-free, so the ranking and
// de-duplication can be tested without Electron or a network: the fetching lives in main.cjs.
//
// The order matters, because it is the order a person would look in: the endpoint they are using
// right now, then the profiles they saved, then the model server on this machine.

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
  const add = (provider, baseUrl, key) => {
    const norm = normalize(baseUrl)
    if (!norm || seen.has(norm)) return
    seen.add(norm)
    out.push({ provider: String(provider || '').trim() || 'Endpoint', baseUrl: norm, key: key || '' })
  }
  add('In use', cfg && cfg.baseUrl, cfg && cfg.apiKey)
  for (const p of (cfg && cfg.profiles) || []) add(p && p.name, p && p.baseUrl, cfg && cfg.apiKey)
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

module.exports = { sourcesFor, normalize, parseModels, tidyError }
