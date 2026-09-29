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

// "Unified" has to be checkable, not just claimed. main hands the image tool the very runner the
// Image switch uses; before this the tool ran its own weakened copy — no reference validation, no
// shrinking, no window guard — which is how an edit asked for in words could fail for no stated
// reason, or come back as an unrelated fresh picture.
const calls = []
const PIC = { url: 'data:image/png;base64,AAAA', name: 'shot.png' }
const refs = (over = {}) => ({
  last: PIC,
  attached: null,
  named: { 'shot.png': PIC },
  list: [PIC],
  ...over,
})
const drawOpts = (over = {}) => ({
  images: {
    key: 'k',
    model: 'fal-ai/flux-2/klein/4b/base',
    editModel: 'fal-ai/flux-2/klein/4b/base/edit',
    // the shape main really passes: a map, not a list
    references: refs(),
    imagesDir: 'X:/none',
    generate: async (a) => {
      calls.push(a)
      return { ok: true, images: [{ path: 'X:/none/one.png', url: '', name: 'one.png' }], tookMs: 5 }
    },
    ...over,
  },
  toolsEnabled: true,
})

;(async () => {
  await REGISTRY.generate_image.run({ prompt: 'a small blue duck' }, drawOpts())
  check('the drawing tool runs through the runner it is handed, not a private path', () => {
    assert.strictEqual(calls.length, 1, 'the injected runner should have been used')
    assert.strictEqual(calls[0].prompt, 'a small blue duck')
    assert.ok(!calls[0].imageUrl, 'a fresh draw carries no reference')
  })

  for (const named of ['last', 'attached', 'shot.png', '1']) {
    calls.length = 0
    const opts = drawOpts(
      named === 'attached'
        ? { references: refs({ attached: PIC }) }
        : {},
    )
    await REGISTRY.generate_image.run({ prompt: 'make it green', reference: named }, opts)
    check(`"${named}" finds the picture, so an edit reaches an edit endpoint`, () => {
      assert.strictEqual(calls.length, 1, 'the runner should have been used')
      assert.strictEqual(calls[0].imageUrl, PIC.url, 'the reference should travel')
      assert.match(
        String(calls[0].model),
        /edit$/,
        `an edit should run on the edit endpoint, got "${calls[0].model}"`,
      )
    })
  }

  calls.length = 0
  const miss = await REGISTRY.generate_image.run(
    { prompt: 'make it green', reference: 'nope.png' },
    drawOpts(),
  )
  check('a reference that cannot be found says what is there, so the next try can name it', () => {
    assert.strictEqual(calls.length, 0, 'nothing should have been drawn')
    assert.match(String(miss.error), /shot\.png/, `should list what exists, said "${miss.error}"`)
  })

  const noKey = await REGISTRY.generate_image.run(
    { prompt: 'x' },
    { images: { generate: async () => { calls.push('drew'); return { ok: true } } } },
  )
  check('with no key it says where to fix it instead of drawing anything', () => {
    assert.strictEqual(noKey && noKey.ok, false, 'should refuse')
    assert.match(String(noKey.error), /Settings/i, 'the refusal should name the place to fix it')
  })

  console.log(`\n${passed}/${passed + failed} checks passed`)
  process.exit(failed ? 1 : 0)
})()
