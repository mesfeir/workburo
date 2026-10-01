'use strict'

/**
 * Tests for the model list.
 *
 * The point of this file is the two rules the picker now lives by: nothing is chosen on your behalf,
 * and nothing is claimed that was not actually found. The list is built from the endpoints that
 * answer, kept grouped by whose they are, and whatever did not answer is reported as itself rather
 * than dropped or invented. All offline, no network.
 */

const assert = require('node:assert')

const sources = require('../electron/model-sources.cjs')

let passed = 0
const failures = []

function check (name, fn) {
  try {
    fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.log(`  FAIL  ${name} — ${err && err.message}`)
  }
}

const cfg = {
  baseUrl: 'https://opencode.ai/zen/go/v1',
  apiKey: 'placeholder-key',
  profiles: [
    { name: 'OpenCode Zen (Go)', baseUrl: 'https://opencode.ai/zen/go/v1' },
    { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
    { name: 'LM Studio (local)', baseUrl: 'http://127.0.0.1:1234/v1' },
  ],
}

check('1. the endpoint in use is headed with the provider it came from', () => {
  const s = sources.sourcesFor(cfg, 0)
  assert.strictEqual(s[0].provider, 'OpenCode Zen (Go)')
  assert.strictEqual(s[0].baseUrl, 'https://opencode.ai/zen/go/v1')
})

check('1b. an endpoint that matches no profile is still named, not left blank', () => {
  const s = sources.sourcesFor({ baseUrl: 'https://api.mystery.example/v1' }, 0)
  assert.strictEqual(s.length, 1)
  assert.strictEqual(s[0].provider, 'This endpoint')
})

check('2. a profile repeating the endpoint in use is not asked twice', () => {
  const s = sources.sourcesFor(cfg, 0)
  const same = s.filter((x) => x.baseUrl === 'https://opencode.ai/zen/go/v1')
  assert.strictEqual(same.length, 1, JSON.stringify(s.map((x) => x.provider)))
})

check('3. every other saved profile is asked', () => {
  const names = sources.sourcesFor(cfg, 0).map((x) => x.provider)
  assert.ok(names.includes('OpenRouter'), names.join(','))
  assert.ok(names.includes('LM Studio (local)'), names.join(','))
})

check('4. a trailing slash does not make a second entry for the same place', () => {
  const s = sources.sourcesFor(
    { baseUrl: 'https://openrouter.ai/api/v1', profiles: [{ name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1/' }] },
    0,
  )
  assert.strictEqual(s.length, 1, JSON.stringify(s))
})

check('5. the local server is asked when it is running, and not when it is not', () => {
  const off = sources.sourcesFor(cfg, 0)
  assert.ok(!off.some((x) => x.provider === 'On this machine'), 'asked a server that is not running')
  const local = sources.sourcesFor(cfg, 8080).find((x) => x.provider === 'On this machine')
  assert.ok(local, 'the running local server was not asked')
  assert.strictEqual(local.baseUrl, 'http://127.0.0.1:8080/v1')
})

check('5b. the same profile is not listed twice when it is the one in use', () => {
  const names = sources.sourcesFor(cfg, 0).map((x) => x.provider)
  assert.strictEqual(names.filter((n) => n === 'OpenCode Zen (Go)').length, 1, names.join(','))
})

check('6. the local server is asked with no key, because it has none', () => {
  const local = sources.sourcesFor(cfg, 8080).find((x) => x.provider === 'On this machine')
  assert.strictEqual(local.key, '')
})

check('7. an empty config asks nothing instead of throwing', () => {
  assert.deepStrictEqual(sources.sourcesFor(null, 0), [])
  assert.deepStrictEqual(sources.sourcesFor({}, 0), [])
  assert.deepStrictEqual(sources.sourcesFor({ profiles: [null, {}] }, 0), [])
})

check('8. a bare host gets https, and a local endpoint keeps its own scheme', () => {
  assert.strictEqual(sources.normalize('api.example.com/v1'), 'https://api.example.com/v1')
  assert.strictEqual(sources.normalize('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1')
  assert.strictEqual(sources.normalize('  '), '')
})

check('9. a model list is read from either shape, sorted, and junk is dropped', () => {
  const list = sources.parseModels({ data: [{ id: 'zeta' }, { id: 'alpha' }, { name: 'middle' }, { nope: 1 }, 'text', null] })
  assert.deepStrictEqual(list.map((m) => m.id), ['alpha', 'middle', 'zeta'])
  assert.deepStrictEqual(sources.parseModels({ models: [{ id: 'only' }] }).map((m) => m.id), ['only'])
  assert.deepStrictEqual(sources.parseModels(null), [])
  assert.deepStrictEqual(sources.parseModels({ data: 'nonsense' }), [])
})

check('10. nothing is invented when the list is empty', () => {
  assert.deepStrictEqual(sources.parseModels({ data: [] }), [])
  assert.deepStrictEqual(sources.parseModels({}), [])
})

check('11. a refusal is short, and a key problem says so', () => {
  assert.strictEqual(sources.tidyError(401, 'Unauthorized'), 'needs a key')
  assert.strictEqual(sources.tidyError(403, 'forbidden'), 'needs a key')
  assert.strictEqual(sources.tidyError(0, 'fetch failed'), 'not reachable')
  assert.strictEqual(sources.tidyError(0, 'connect ECONNREFUSED 127.0.0.1:11434'), 'not reachable')
  assert.strictEqual(sources.tidyError(500, 'boom'), 'boom')
})

console.log('')
if (failures.length) {
  for (const f of failures) console.log(`  ${f.name}\n     ${f.err && f.err.stack}`)
  console.log(`=== ${passed} passed, ${failures.length} failed ===`)
  process.exit(1)
}
console.log(`=== ${passed} passed, 0 failed ===`)
