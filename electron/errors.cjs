/**
 * Turning a provider's error into something a person can act on.
 *
 * The rule this exists for: a generic sentence is not an explanation. OpenRouter and other
 * gateways answer with
 *   {"error":{"message":"Provider returned error",
 *             "metadata":{"raw":"<model> is temporarily rate-limited upstream...",
 *                         "provider_name":"Poolside","limit_source":"upstream_provider_shared_pool"}}}
 * where the sentence that says what actually went wrong is in metadata.raw. Showing only
 * error.message leaves the user staring at "Provider returned error" with nothing to act on.
 */

// the sentences that carry no information, so anything more specific is preferred over them
const GENERIC = /^(provider returned error|bad gateway|upstream error|error|internal server error)$/i

/** The best available explanation for one error object, and where it came from. */
function upstreamDetail (error) {
  const e = error && typeof error === 'object' ? error : {}
  const meta = e.metadata && typeof e.metadata === 'object' ? e.metadata : {}
  const raw = typeof meta.raw === 'string' ? meta.raw : typeof e.raw === 'string' ? e.raw : ''
  const base = String(e.message || e.type || '').trim()
  // prefer the upstream's own words when the top-level message is the generic one, and fall back to
  // it when there is no generic message to complain about
  const message = raw && (!base || GENERIC.test(base)) ? raw : (base || raw)
  return {
    message,
    provider: typeof meta.provider_name === 'string' ? meta.provider_name : '',
    code: e.code === undefined || e.code === null ? '' : String(e.code),
    limitSource: typeof meta.limit_source === 'string' ? meta.limit_source : '',
    raw: raw || '',
  }
}

/**
 * A gateway may answer HTTP 200 with an error object in the body and no choices at all. Treating
 * that as a success is how a turn ends up rendering an empty reply with no error shown.
 */
function embeddedError (json) {
  if (!json || typeof json !== 'object') return null
  if (!json.error) return null
  if (Array.isArray(json.choices) && json.choices.length) return null
  if (Array.isArray(json.output) && json.output.length) return null
  return json.error
}

module.exports = { upstreamDetail, embeddedError, GENERIC }
