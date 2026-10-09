/* Gemini, tested the way the hosted-API rule says to: the offline half always runs and replays the
 * documented response shapes (submit → reply → bytes), so the request building, the fallback between
 * the two image endpoints, and the file write are exercised with no key and no network. The live half
 * runs only when ZEN_GEMINI_KEY is set — from the environment, never from the command line, so a key
 * cannot end up in a process list or a log.
 */

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const gemini = require('../electron/gemini.cjs')

let passed = 0
let failed = 0
const results = []

function test(name, fn) {
  try {
    fn()
    results.push(`  ok   ${name}`)
    passed += 1
  } catch (e) {
    results.push(`  FAIL ${name}\n         ${(e && e.message) || e}`)
    failed += 1
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    results.push(`  ok   ${name}`)
    passed += 1
  } catch (e) {
    results.push(`  FAIL ${name}\n         ${(e && e.message) || e}`)
    failed += 1
  }
}

const KEY = 'test-key-not-a-credential'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-test-'))

/* A fetch that records what was sent and answers with a canned reply. Nothing here reaches the
 * network, and no test replaces the client inside the shipping module — the stub is the global. */
function stubFetch(handlers) {
  const calls = []
  const original = global.fetch
  global.fetch = async (url, init = {}) => {
    const entry = { url: String(url), headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null }
    calls.push(entry)
    const reply = handlers(entry)
    if (!reply) throw new Error(`no stub for ${entry.url}`)
    return {
      ok: reply.status ? reply.status < 400 : true,
      status: reply.status || 200,
      text: async () => JSON.stringify(reply.json === undefined ? {} : reply.json),
    }
  }
  return { calls, restore: () => { global.fetch = original } }
}

function imageReply(data, mimeType = 'image/png') {
  return { json: { candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] } }] } }
}

;(async () => {
  /* ------------------------------------------------------------------ offline half */

  await testAsync('a generation sends the prompt, asks for an image, and writes a real file', async () => {
    const s = stubFetch(() => imageReply(PNG))
    try {
      const out = await gemini.generate({
        key: KEY, model: 'gemini:gemini-3.1-flash-image', prompt: 'a red cube in the snow', imagesDir: tmp,
      })
      const call = s.calls[0]
      assert.match(call.url, /\/v1beta\/models\/gemini-3\.1-flash-image:generateContent$/, 'the model must reach the URL')
      assert.strictEqual(call.headers['x-goog-api-key'], KEY, 'the key must travel in Google\u2019s header')
      assert.strictEqual(call.body.contents[0].parts[0].text, 'a red cube in the snow', 'the prompt must be in the body')
      assert.deepStrictEqual(
        call.body.generationConfig.responseModalities, ['IMAGE'], 'it must ask for an image, not text')
      assert.ok(fs.existsSync(out.file), 'the picture must land on disk')
      assert.ok(fs.statSync(out.file).size > 0, 'the written picture must not be empty')
      assert.match(out.file, /\.png$/, 'the extension must follow the returned mime type')
    } finally {
      s.restore()
    }
  })

  await testAsync('a reference picture makes it an edit, and travels as inline bytes', async () => {
    const s = stubFetch(() => imageReply(PNG))
    try {
      await gemini.generate({
        key: KEY, model: 'gemini:gemini-3.1-flash-image', prompt: 'make the cube blue',
        reference: { mimeType: 'image/png', data: PNG }, imagesDir: tmp,
      })
      const parts = s.calls[0].body.contents[0].parts
      assert.strictEqual(parts.length, 2, 'an edit carries both the instruction and the picture')
      assert.strictEqual(parts[1].inline_data.mime_type, 'image/png', 'the reference must keep its type')
      assert.strictEqual(parts[1].inline_data.data, PNG, 'the reference must be sent as base64 bytes')
    } finally {
      s.restore()
    }
  })

  await testAsync('the newer interactions route is used when the old one is not there', async () => {
    const s = stubFetch((c) => {
      if (c.url.includes(':generateContent')) return { status: 404, json: { error: { message: 'not found' } } }
      if (c.url.endsWith('/interactions')) {
        return { json: { output_image: { data: PNG, mime_type: 'image/png' } } }
      }
      return null
    })
    try {
      const out = await gemini.generate({
        key: KEY, model: 'gemini:gemini-3-pro-image', prompt: 'a lighthouse at dusk', imagesDir: tmp,
      })
      assert.strictEqual(s.calls.length, 2, 'the fallback must be attempted exactly once')
      assert.match(s.calls[1].url, /\/v1beta\/interactions$/, 'the second attempt must use the newer route')
      assert.strictEqual(s.calls[1].body.model, 'gemini-3-pro-image', 'the fallback names the model in the body')
      assert.ok(fs.existsSync(out.file), 'the fallback must still produce a file')
    } finally {
      s.restore()
    }
  })

  await testAsync('a reply with no picture fails loudly and repeats what Google said', async () => {
    const s = stubFetch(() => ({ json: { candidates: [{ content: { parts: [{ text: 'I cannot draw that.' }] } }] } }))
    try {
      await assert.rejects(
        () => gemini.generate({ key: KEY, model: 'gemini:gemini-3.1-flash-image', prompt: 'nope', imagesDir: tmp }),
        (e) => /did not return a picture/.test(e.message) && /I cannot draw that/.test(e.message),
        'a text-only reply must be reported, not written out as an empty picture',
      )
    } finally {
      s.restore()
    }
  })

  await testAsync('a bad key is explained in a sentence, not a status code', async () => {
    const s = stubFetch(() => ({ status: 400, json: { error: { message: 'API key not valid. Please pass a valid API key.' } } }))
    try {
      await assert.rejects(
        () => gemini.generate({ key: 'wrong', model: 'gemini:gemini-3.1-flash-image', prompt: 'x', imagesDir: tmp }),
        (e) => /Gemini request failed/.test(e.message) && /not valid/.test(e.message),
      )
    } finally {
      s.restore()
    }
  })

  await testAsync('no key is refused before anything is sent', async () => {
    await assert.rejects(
      () => gemini.generate({ key: '', model: 'gemini:gemini-3.1-flash-image', prompt: 'x', imagesDir: tmp }),
      (e) => /No Gemini key/.test(e.message),
    )
  })

  test('the catalogue falls back to known models when there is no key to ask with', () => {
    return gemini.listImageModels('').then((r) => {
      assert.strictEqual(r.live, false)
      assert.ok(r.models.length >= 4, 'the fallback list must be usable')
      assert.ok(r.models.every((m) => /image/.test(m.id)), 'the fallback must only offer picture models')
    })
  })

  test('only Gemini ids are claimed, so fal and ComfyUI ids are left alone', () => {
    assert.strictEqual(gemini.isImageModel('gemini:gemini-3.1-flash-image'), true)
    assert.strictEqual(gemini.isImageModel('gemini:'), false)
    assert.strictEqual(gemini.isImageModel('fal-ai/nano-banana/edit'), false)
    assert.strictEqual(gemini.isImageModel('comfy:wf123'), false)
    assert.strictEqual(gemini.modelFromId('gemini:gemini-3-pro-image'), 'gemini-3-pro-image')
  })

  test('the reply parser accepts both documented shapes and refuses text', () => {
    const gen = gemini.findInlineImage({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'A'.repeat(600) } }] } }] })
    const inter = gemini.findInlineImage({ output_image: { data: 'B'.repeat(600), mime_type: 'image/jpeg' } })
    assert.ok(gen && inter, 'both shapes must be understood')
    assert.strictEqual(inter.mimeType, 'image/jpeg', 'the type must survive parsing')
    assert.strictEqual(gemini.findInlineImage({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] }), null)
    assert.strictEqual(gemini.findInlineImage({ error: { message: 'quota' } }), null)
    // A long run of prose must not be mistaken for picture bytes: it is the shape, not the length.
    const prose = { candidates: [{ content: { parts: [{ text: 'Sorry, I cannot help with that request. '.repeat(40) }] } }] }
    assert.strictEqual(gemini.findInlineImage(prose), null, 'prose must never be taken for an image')
    // A small-but-real picture is a valid answer and must survive.
    assert.ok(gemini.findInlineImage(imageReply(PNG).json), 'a 1x1 PNG is still a picture')
  })

  /* ------------------------------------------------------------------ live half */

  const liveKey = String(process.env.ZEN_GEMINI_KEY || '').trim()
  if (liveKey) {
    console.log(`(live half: a Gemini key is present, length ${liveKey.length} — running one real call)`)
    await testAsync('live: the key is accepted and the catalogue lists picture models', async () => {
      const check = await gemini.checkKey(liveKey)
      assert.ok(check.ok, `the key was refused: ${check.error}`)
      const cat = await gemini.listImageModels(liveKey)
      assert.strictEqual(cat.live, true, 'a working key must produce a live catalogue')
      assert.ok(cat.models.length > 0, 'the live catalogue must not be empty')
      console.log(`         live models: ${cat.models.map((m) => m.id).join(', ')}`)
    })
    await testAsync('live: one real picture, through the newer route if that is what answers', async () => {
      const out = await gemini.generate({
        key: liveKey, model: 'gemini:gemini-3.1-flash-image',
        prompt: 'A single ripe banana on a plain white background, product photo.',
        imagesDir: tmp,
      })
      assert.ok(fs.existsSync(out.file) && fs.statSync(out.file).size > 1000, 'a real picture must come back')
      console.log(`         wrote ${out.file} (${fs.statSync(out.file).size} bytes, model ${out.model})`)
    })
  } else {
    console.log('(live half skipped: set ZEN_GEMINI_KEY in the environment to run it)')
  }

  console.log(results.join('\n'))
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
