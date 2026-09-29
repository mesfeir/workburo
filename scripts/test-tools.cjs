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
const fs = require('node:fs')
const path = require('node:path')

const { chatToolDefs, responsesToolDefs, executeTool, ALL_TOOLS, REGISTRY } = require('../electron/tools.cjs')
const create = require('../electron/create.cjs')

/** The three that reach into someone's real accounts; hidden unless switched on. */
const APP_TOOLS = new Set(['list_connected_apps', 'search_app_tools', 'run_app_tool'])

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

check('connected-app tools stay hidden until the user turns them on', () => {
  const off = names({})
  for (const t of ['list_connected_apps', 'search_app_tools', 'run_app_tool']) {
    assert.ok(!off.includes(t), `${t} was advertised with connected apps switched off`)
  }
  const on = names({ apps: { enabled: true } })
  for (const t of ['list_connected_apps', 'search_app_tools', 'run_app_tool']) {
    assert.ok(on.includes(t), `${t} was not advertised with connected apps switched on`)
  }
})

check('and the master switch still beats them', () => {
  assert.deepStrictEqual(names({ toolsEnabled: false, apps: { enabled: true } }), [])
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

check('the drawing tool cannot choose its own endpoint either', () => {
  const params = REGISTRY.generate_image.schema.function.parameters
  // the picture is drawn with whatever the user picked in the bar; a model that could name its own
  // would make the same request produce a different-looking picture depending on which door it came in
  assert.ok(!params.properties.model, 'there should be no model argument')
})

check('toolsEnabled is the only master switch — an unset one means on', () => {
  assert.ok(names({ toolsEnabled: true }).length > 0)
  // the connected-app tools are deliberately absent until switched on, so they are not part of
  // what an unset master switch turns on
  assert.strictEqual(names({ toolsEnabled: undefined }).length, ALL_TOOLS.length - APP_TOOLS.size)
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

  calls.length = 0
  await REGISTRY.generate_image.run({ prompt: 'a duck', model: 'fal-ai/something-else' }, drawOpts())
  check('and the model cannot swap the endpoint out from under the user’s pick', () => {
    assert.strictEqual(
      calls[0].model,
      'fal-ai/flux-2/klein/4b/base',
      `the picked model should win, got "${calls[0].model}"`,
    )
  })

  calls.length = 0
  await REGISTRY.generate_image.run({ prompt: 'a duck' }, drawOpts({ size: 'landscape_16_9' }))
  check('and the shape picked in Settings is used when the model does not ask for one', () => {
    assert.strictEqual(calls[0].size, 'landscape_16_9', `got "${calls[0].size}"`)
  })

  const noKey = await REGISTRY.generate_image.run(
    { prompt: 'x' },
    { images: { generate: async () => { calls.push('drew'); return { ok: true } } } },
  )
  check('with no key it says where to fix it instead of drawing anything', () => {
    assert.strictEqual(noKey && noKey.ok, false, 'should refuse')
    assert.match(String(noKey.error), /Settings/i, 'the refusal should name the place to fix it')
  })

  /* ---------------------------------------- making a document, through the tool itself */
  // main injects `docs.create` the same way it injects `images.generate`, so the wrapper can be
  // checked with no key and no network. What matters is the contract: the writer is reached with
  // what the model asked for, and the file comes back out of executeTool — a shape it drops is a
  // spreadsheet the user never sees, which is exactly how the image tool once failed silently.
  const madeCalls = []
  const made = await executeTool(
    'create_document',
    JSON.stringify({ kind: 'csv', filename: 'fruits.csv', content: 'fruit,qty\napple,3\n' }),
    {
      docs: {
        create: async (a) => {
          madeCalls.push(a)
          return {
            ok: true,
            file: { path: 'X:/out/fruits.csv', name: 'fruits.csv', kind: 'csv', bytes: 22 },
            text: 'Saved fruits.csv',
          }
        },
      },
    },
  )
  check('create_document reaches the writer main injects, with what the model asked for', () => {
    assert.strictEqual(made.ok, true, made.error)
    assert.strictEqual(madeCalls.length, 1)
    assert.strictEqual(madeCalls[0].kind, 'csv')
    assert.strictEqual(madeCalls[0].filename, 'fruits.csv')
    assert.match(String(madeCalls[0].content), /apple,3/)
  })
  check('and the file comes back out of executeTool, so the reply can show it', () => {
    assert.ok(Array.isArray(made.files) && made.files.length === 1, JSON.stringify(made))
    assert.strictEqual(made.files[0].name, 'fruits.csv')
  })

  const noWriter = await executeTool('create_document', JSON.stringify({ kind: 'csv', content: 'a\n' }), {})
  check('with no writer wired in it refuses honestly rather than claiming a file', () => {
    assert.strictEqual(noWriter.ok, false)
    assert.ok(!noWriter.files || noWriter.files.length === 0, 'it must not invent a file')
  })

  const realDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'zen-tools-create-'))
  const real = await executeTool(
    'create_document',
    JSON.stringify({ kind: 'xlsx', filename: 'real.xlsx', content: 'a,b\n1,2\n' }),
    { docs: { create: (a) => create.create(a, { dir: realDir }) } },
  )
  check('and a real one is written where it says it was', () => {
    assert.strictEqual(real.ok, true, real.error)
    assert.ok(fs.existsSync(real.files[0].path), real.files[0].path)
    assert.ok(real.files[0].bytes > 0, 'a zero-byte file is not a file')
  })
  check('a kind it cannot make is refused with the list it can', async () => {
    const bad = await executeTool(
      'create_document',
      JSON.stringify({ kind: 'exe', filename: 'x.exe', content: 'MZ' }),
      { docs: { create: (a) => create.create(a, { dir: realDir }) } },
    )
    assert.strictEqual(bad.ok, false)
    assert.ok(/xlsx/.test(bad.error) && /pdf/.test(bad.error), bad.error)
  })

  console.log(`\n${passed}/${passed + failed} checks passed`)
  process.exit(failed ? 1 : 0)
})()
