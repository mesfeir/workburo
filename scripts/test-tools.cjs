/**
 * The toggles have to mean something.
 *
 * "Turning tools off stops tool calls" was the one check that failed on every run, and it was
 * right: chatToolDefs filtered only by the per-tool toggles, so the master switch advertised
 * every tool anyway. Settings greys the per-tool switches out when the master is off, so the
 * app was contradicting itself in the one place it must not — the model's actual tool list.
 *
 * Offline: no network, no key, no credits.
 */
const assert = require('node:assert')

const { chatToolDefs, responsesToolDefs, ALL_TOOLS, REGISTRY } = require('../electron/tools.cjs')

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`PASS  ${name}`)
    passed += 1
  } catch (err) {
    console.log(`FAIL  ${name}\n        ${err.message}`)
    failed += 1
  }
}

const names = (cfg) => chatToolDefs(cfg).map((t) => t.function && t.function.name)

check('every tool is advertised by default', () => {
  const got = names({})
  assert.deepStrictEqual(got.sort(), [...ALL_TOOLS].sort(), `got ${got.join(', ')}`)
})

check('turning tools off advertises nothing at all', () => {
  const got = names({ toolsEnabled: false })
  assert.deepStrictEqual(got, [], `still advertised ${got.join(', ')}`)
})

check('and the Responses-API shape agrees', () => {
  assert.deepStrictEqual(responsesToolDefs({ toolsEnabled: false }), [])
  assert.ok(responsesToolDefs({}).length > 0, 'default should offer tools')
})

check('turning tools off beats a per-tool switch that is on', () => {
  const got = names({ toolsEnabled: false, toolToggles: { web_search: true, generate_image: true } })
  assert.deepStrictEqual(got, [], `still advertised ${got.join(', ')}`)
})

check('an individual tool can be switched off on its own', () => {
  const got = names({ toolToggles: { generate_image: false } })
  assert.ok(got.length > 0, 'other tools should survive')
  assert.ok(!got.includes('generate_image'), 'generate_image should be gone')
})

check('the drawing tool is the one the Image switch names, and it exists', () => {
  assert.ok(ALL_TOOLS.includes('generate_image'), `known tools: ${ALL_TOOLS.join(', ')}`)
  const schema = REGISTRY.generate_image.schema
  assert.strictEqual(schema.function.name, 'generate_image')
})

check('the drawing tool can be pointed at a picture', () => {
  const params = REGISTRY.generate_image.schema.function.parameters
  assert.ok(params.properties.reference, 'generate_image should take a reference')
  // a reference is how "change the last picture" is expressed to the model
  assert.match(
    String(params.properties.reference.description),
    /attached|last/i,
    `reference must explain how to name a picture, said: ${params.properties.reference.description}`,
  )
  assert.ok(
    /change|edit/i.test(String(REGISTRY.generate_image.schema.function.description)),
    'the tool description should say it can change a picture, not only draw one',
  )
})

check('toolsEnabled is the only master switch — an unset one means on', () => {
  assert.ok(names({ toolsEnabled: true }).length > 0)
  assert.strictEqual(names({ toolsEnabled: undefined }).length, ALL_TOOLS.length)
})

console.log(`\n${passed}/${passed + failed} checks passed`)
process.exit(failed ? 1 : 0)
