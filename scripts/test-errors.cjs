/* Every body in this file is one a real provider actually sent. The first is the reason the file
   exists: OpenRouter described the failure in error.metadata.raw while the headline said only
   "Provider returned error", so the user had nothing to act on. */
const { upstreamDetail, embeddedError } = require('../electron/errors.cjs')

let passed = 0
const failures = []
function check (label, fn) {
  try {
    fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failures.push(`${label}: ${err.message}`)
    console.log(`  FAIL  ${label}: ${err.message}`)
  }
}
const eq = (got, want, what) => {
  if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)
}
const ok = (cond, what) => { if (!cond) throw new Error(what) }

// the exact body OpenRouter returned for poolside/laguna-s-2.1:free
const rateLimited = {
  error: {
    message: 'Provider returned error',
    code: 429,
    metadata: {
      raw: 'poolside/laguna-s-2.1:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations',
      provider_name: 'Poolside',
      is_byok: false,
      limit_source: 'upstream_provider_shared_pool',
      remedy_hint: 'Retry shortly, add your own provider key, or route to another provider',
    },
  },
}

check('1. a generic headline is replaced by the upstream sentence', () => {
  const d = upstreamDetail(rateLimited.error)
  ok(/temporarily rate-limited upstream/.test(d.message), `message was ${JSON.stringify(d.message)}`)
  ok(!/^provider returned error$/i.test(d.message), 'the generic headline survived')
})
check('2. the provider and the limit source survive, so the error can name who failed', () => {
  const d = upstreamDetail(rateLimited.error)
  eq(d.provider, 'Poolside', 'provider')
  eq(d.limitSource, 'upstream_provider_shared_pool', 'limit source')
  eq(d.code, '429', 'code')
})
check('3. a message that already says something useful is not replaced', () => {
  eq(upstreamDetail({ message: 'Invalid API key provided', code: 401 }).message, 'Invalid API key provided', 'message')
  eq(upstreamDetail({ message: 'No endpoints found for this model', metadata: { provider_name: 'OpenRouter' } }).provider, 'OpenRouter', 'provider')
})
check('4. an error with nothing but a headline, or nothing at all, still says something', () => {
  eq(upstreamDetail({ message: 'Bad Gateway' }).message, 'Bad Gateway', 'headline')
  eq(upstreamDetail({}).message, '', 'empty error')
})
check('5. a 200 carrying an error instead of choices is an error, not an empty reply', () => {
  const body = {
    id: 'gen-1790677861-dhzyFHtdiXK3bXsJZgX9',
    error: { message: 'Upstream error from Nvidia: Service temporarily overloaded', code: 503, metadata: { error_type: 'provider_overloaded' } },
  }
  ok(embeddedError(body), 'a 200 with an error in the body was taken as success')
  eq(upstreamDetail(body.error).message, 'Upstream error from Nvidia: Service temporarily overloaded', 'message')
})
check('6. a normal answer is not mistaken for an error', () => {
  eq(embeddedError({ choices: [{ message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' }] }), null, 'embedded error')
  eq(embeddedError({ output: [{ type: 'message' }] }), null, 'embedded error, responses protocol')
  eq(embeddedError(null), null, 'a null body')
  eq(embeddedError({}), null, 'an empty body')
})
check('7. a stream event carrying an error is explained the same way', () => {
  eq(upstreamDetail({ message: 'Provider returned error', metadata: { raw: 'the upstream went away' } }).message, 'the upstream went away', 'message')
})

console.log(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length) process.exitCode = 1
