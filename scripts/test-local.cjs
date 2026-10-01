'use strict'

/**
 * Tests for the local model path.
 *
 * The offline half runs anywhere: it checks the pinning, the honesty of what is reported, and the
 * download rules (wrong size and wrong checksum are refused, and a refused download leaves nothing
 * behind). Those are the parts that decide whether a first run is trustworthy, and they need no
 * network.
 *
 * The live half is gated on having a real installation to point at, because a stub cannot prove
 * that a model loads and answers. Set ZEN_LOCAL_SEED to a directory holding the extracted runtime
 * in a "bin" folder plus a .gguf model, and this will lay out a real installation with hard links
 * (instant, no copying), start the server, ask it something, and time the first token.
 *
 *   ZEN_LOCAL_SEED=".../w4-spike" node scripts/test-local.cjs
 */

const assert = require('node:assert')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const local = require('../electron/local.cjs')

let passed = 0
const failures = []

function check (name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') throw new Error('use checkAsync for promises')
    if (r === false) throw new Error('returned false')
    passed++
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.log(`  FAIL  ${name} — ${err && err.message}`)
  }
}

async function checkAsync (name, fn) {
  try {
    const r = await fn()
    if (r === false) throw new Error('returned false')
    passed++
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.log(`  FAIL  ${name} — ${err && err.message}`)
  }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-local-test-'))

/** A fetch stand-in that returns whatever bytes we say, so the download rules can be tested. */
function stubFetch (body, { status = 200, headers = {} } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    body: new ReadableStream({
      start (controller) {
        controller.enqueue(new Uint8Array(body))
        controller.close()
      },
    }),
  })
}

(async () => {
  console.log('=== the local model path ===\n')

  // ---------------------------------------------------------------- what is pinned

  check('1. the runtime is pinned to a version rather than following latest', () => {
    assert.match(local.LLAMA_VERSION, /^b\d+$/, `not a build tag: ${local.LLAMA_VERSION}`)
    assert.ok(!local.llamaUrl().includes('/latest/'), 'the url follows latest')
    assert.ok(local.llamaUrl().includes(local.LLAMA_VERSION), 'the url does not carry the pinned version')
    return true
  })

  check('2. the runtime carries a byte count and a real checksum, not a hope', () => {
    assert.ok(local.LLAMA_BYTES > 1e6, `implausible size: ${local.LLAMA_BYTES}`)
    assert.match(local.LLAMA_SHA256, /^[0-9a-f]{64}$/, 'the runtime digest is not a sha256')
    return true
  })

  check('2b. the archive each platform downloads is the one GitHub actually publishes', () => {
    // The macOS branch asked for `...macos-arm64.zip` and the real asset is `.tar.gz`, and the
    // digest pinned for it was the WINDOWS archive's. Neither could fail on Windows, because that
    // branch never runs there. Assert every platform's name and that no two share a digest.
    assert.match(local.llamaAsset('win32', 'x64'), /bin-win-cpu-x64\.zip$/, 'the Windows asset changed shape')
    assert.match(local.llamaAsset('darwin', 'arm64'), /bin-macos-arm64\.tar\.gz$/, 'the macOS asset is not the .tar.gz GitHub publishes')
    assert.match(local.llamaAsset('darwin', 'x64'), /bin-macos-x64\.tar\.gz$/, 'the Intel macOS asset is wrong')
    assert.equal(local.llamaPin('win32').bytes, 19197239, 'the Windows pin moved')
    assert.equal(local.llamaPin('darwin').bytes, 11797542, 'the macOS pin moved')
    assert.notEqual(
      local.llamaPin('darwin').sha256,
      local.llamaPin('win32').sha256,
      'the two platforms share a digest, so one of them is wrong'
    )
    for (const [platform, pin] of Object.entries(local.LLAMA_PINS)) {
      assert.match(pin.sha256, /^[0-9a-f]{64}$/, `${platform} has no usable digest`)
      assert.ok(pin.bytes > 1e6, `${platform} has an implausible size`)
    }
    return true
  })

  check('3. every model on offer is described honestly', () => {
    assert.ok(local.CATALOGUE.length >= 1, 'no models on offer')
    for (const m of local.CATALOGUE) {
      assert.ok(m.id && m.label, `a model has no name: ${JSON.stringify(m)}`)
      assert.match(m.sha256, /^[0-9a-f]{64}$/, `${m.id} has no usable digest`)
      assert.ok(m.bytes > 1e5, `${m.id} has no usable size`)
      assert.ok(/^https:\/\//.test(m.url), `${m.id} has no https url`)
      assert.ok(m.url.endsWith(m.file), `${m.id}'s url does not point at ${m.file}`)
      assert.ok(m.note && m.note.length > 30, `${m.id} does not say what it is good for`)
    }
    return true
  })

  check('4. the model on offer is small enough to be a first run', () => {
    for (const m of local.CATALOGUE) {
      assert.ok(m.bytes < 600e6, `${m.id} is ${local.humanSize(m.bytes)}, too large to offer as a first step`)
    }
    return true
  })

  check('5. the default model is the one the notes were measured on', () => {
    const entry = local.entryFor()
    assert.strictEqual(entry.id, local.DEFAULT_MODEL)
    assert.ok(local.status(scratch).model === local.DEFAULT_MODEL, 'status reports a different default')
    return true
  })

  // ---------------------------------------------------------------- what is reported

  check('6. an empty directory reports nothing installed and nothing ready', () => {
    const s = local.status(path.join(scratch, 'empty'))
    assert.strictEqual(s.installed, false)
    assert.strictEqual(s.ready, false)
    assert.strictEqual(s.modelReady, false)
    assert.strictEqual(s.modelPath, null, 'a model path was offered with no model on disk')
    return true
  })

  check('7. a model that is still downloading never reports itself ready', () => {
    const root = path.join(scratch, 'half')
    const L = local.layout(root)
    fs.mkdirSync(L.versionDir, { recursive: true })
    fs.writeFileSync(L.exe, 'not a real binary, but present')
    fs.mkdirSync(L.modelsDir, { recursive: true })
    const entry = local.entryFor()
    fs.writeFileSync(local.modelPath(root), Buffer.alloc(1024)) // a stub of a 429 MB file
    const s = local.status(root)
    assert.strictEqual(s.installed, true, 'the runtime should be seen as installed')
    assert.strictEqual(s.modelReady, false, 'a 1 KB file was mistaken for the model')
    assert.strictEqual(s.ready, false, 'half a model reported itself ready')
    assert.strictEqual(s.modelPath, null, 'a half-written model was offered as usable')
    return true
  })

  check('8. a model of exactly the right size is accepted, and a partial file is not', () => {
    const root = path.join(scratch, 'exact')
    const L = local.layout(root)
    fs.mkdirSync(L.versionDir, { recursive: true })
    fs.writeFileSync(L.exe, 'x')
    fs.mkdirSync(L.modelsDir, { recursive: true })
    const dest = local.modelPath(root)
    // A sparse file: instant, and its size is exactly what the download would produce.
    fs.writeFileSync(dest, '')
    fs.truncateSync(dest, local.entryFor().bytes)
    const s = local.status(root)
    assert.strictEqual(s.modelReady, true, 'a complete model was not recognised')
    assert.strictEqual(s.ready, true)
    // and the .partial naming means an interrupted download is not the model
    fs.writeFileSync(`${dest}.partial`, 'half')
    assert.strictEqual(local.status(root).ready, true, 'a stray partial file broke the real model')
    return true
  })

  check('9. the checksum helper agrees with a known digest', () => {
    const f = path.join(scratch, 'digest.txt')
    fs.writeFileSync(f, 'hello')
    const expected = crypto.createHash('sha256').update('hello').digest('hex')
    assert.strictEqual(local.sha256File(f), expected)
    assert.strictEqual(local.sha256File(f), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    return true
  })

  check('10. sizes are written the way a person reads them', () => {
    assert.strictEqual(local.humanSize(428970080), '429 MB')
    assert.strictEqual(local.humanSize(19197239), '19.2 MB')
    assert.strictEqual(local.humanSize(2e9), '2.0 GB')
    return true
  })

  // ---------------------------------------------------------------- the download rules

  await checkAsync('11. a good download is moved into place and leaves no partial behind', async () => {
    const dest = path.join(scratch, 'good.bin')
    const body = Buffer.from('a small file standing in for a runtime')
    const sha = crypto.createHash('sha256').update(body).digest('hex')
    const seen = []
    const out = await local.download({
      url: 'https://example.com/x.zip',
      dest,
      bytes: body.length,
      sha256: sha,
      fetchImpl: stubFetch(body, { headers: { 'content-length': String(body.length) } }),
      onProgress: (p) => seen.push(p.got),
    })
    assert.strictEqual(out, dest)
    assert.strictEqual(fs.readFileSync(dest).toString(), body.toString())
    assert.strictEqual(fs.existsSync(`${dest}.partial`), false, 'a .partial file was left behind')
    assert.ok(seen.length && seen[seen.length - 1] === body.length, 'progress was never reported')
    return true
  })

  await checkAsync('12. a download that does not match its checksum is refused and deleted', async () => {
    const dest = path.join(scratch, 'wrong-digest.bin')
    const body = Buffer.from('this is not what was promised')
    await assert.rejects(
      () => local.download({
        url: 'https://example.com/x.zip',
        dest,
        sha256: '0'.repeat(64),
        fetchImpl: stubFetch(body),
      }),
      /checksum/i,
    )
    assert.strictEqual(fs.existsSync(dest), false, 'a file that failed its checksum was kept')
    assert.strictEqual(fs.existsSync(`${dest}.partial`), false, 'the partial of a bad file was kept')
    return true
  })

  await checkAsync('13. a download of the wrong size is refused and deleted', async () => {
    const dest = path.join(scratch, 'wrong-size.bin')
    await assert.rejects(
      () => local.download({
        url: 'https://example.com/x.zip',
        dest,
        bytes: 999999,
        fetchImpl: stubFetch(Buffer.from('short')),
      }),
      /wrong size/i,
    )
    assert.strictEqual(fs.existsSync(dest), false, 'a wrongly sized file was kept')
    return true
  })

  await checkAsync('14. a refused download says so with its status rather than hanging', async () => {
    const dest = path.join(scratch, 'refused.bin')
    await assert.rejects(
      () => local.download({
        url: 'https://example.com/x.zip',
        dest,
        fetchImpl: stubFetch(Buffer.from(''), { status: 404 }),
      }),
      /404/,
    )
    return true
  })

  await checkAsync('15. installing with no directory says so instead of guessing one', async () => {
    const r = await local.install({})
    assert.strictEqual(r.ok, false)
    assert.match(String(r.error), /directory/i)
    return true
  })

  // ---------------------------------------------------------------- talking to it

  await checkAsync('16. waiting for a server that is not there gives up honestly', async () => {
    const port = await local.freePort()
    const started = Date.now()
    const up = await local.waitHealthy(port, 500)
    assert.strictEqual(up, false, 'a server that does not exist was reported as up')
    assert.ok(Date.now() - started < 3000, 'giving up took far longer than the timeout allowed')
    return true
  })

  await checkAsync('17. asking about local servers reports what it looked for', async () => {
    const r = await local.detect({ timeoutMs: 600 })
    assert.ok(Array.isArray(r.found), 'found is not a list')
    assert.ok(r.tried.some((u) => u.includes(':1234')), 'it did not look for LM Studio')
    assert.ok(r.tried.some((u) => u.includes(':11434')), 'it did not look for Ollama')
    for (const found of r.found) {
      assert.ok(found.baseUrl && found.label, 'a found server is missing its name or address')
      assert.ok(Array.isArray(found.models), 'a found server did not report its models')
    }
    return true
  })

  check('18. a file that is not a program does not claim to be a runtime', () => {
    const fake = path.join(scratch, 'not-a-program.exe')
    fs.writeFileSync(fake, 'just text')
    const bad = local.binaryVersion(fake)
    assert.strictEqual(bad.ok, false, 'a text file was accepted as the runtime')
    assert.ok(bad.why, 'the refusal did not say why it would not run')
    return true
  })

  check('18b. a saved model path becomes a name, and a normal id is left alone', () => {
    // What a real store held: the local server reported the path, and the app saved it.
    assert.strictEqual(
      local.tidyModelId('C:\\Users\\Mel\\AppData\\Roaming\\WorkBuro\\local\\models\\Qwen3-0.6B-Q4_0.gguf'),
      'Qwen3-0.6B-Q4_0',
    )
    assert.strictEqual(local.tidyModelId('C:/models/x.gguf'), 'x')
    assert.strictEqual(local.tidyModelId('\\\\server\\share\\m.gguf'), 'm')
    // These must not be touched: a slash is not a path, and an id is not a file.
    for (const id of [
      'meta-llama/Llama-3-8B',
      'deepseek-v4.1-flash',
      'fal-ai/flux-2/klein/9b',
      'Qwen3-0.6B-Q4_0',
      '',
      'nvidia/nemotron-3-super-120b-a12b:free',
    ]) {
      assert.strictEqual(local.tidyModelId(id), id, `${id} was changed and should not have been`)
    }
    return true
  })

  // ---------------------------------------------------------------- the real thing

  const seed = process.env.ZEN_LOCAL_SEED
  if (seed) {
    console.log('\n=== with a real installation (ZEN_LOCAL_SEED is set) ===\n')
    const root = path.join(scratch, 'live')
    const L = local.layout(root)
    fs.mkdirSync(L.versionDir, { recursive: true })
    fs.mkdirSync(L.modelsDir, { recursive: true })
    // Hard links: the same bytes on disk, no copying of 429 MB.
    for (const f of fs.readdirSync(path.join(seed, 'bin'))) {
      fs.linkSync(path.join(seed, 'bin', f), path.join(L.versionDir, f))
    }
    const gguf = fs.readdirSync(seed).find((f) => f.endsWith('.gguf') && f.includes('Qwen3'))
    fs.linkSync(path.join(seed, gguf), path.join(L.modelsDir, local.entryFor().file))

    check('19. the runtime reports the version it was pinned to', () => {
      const v = local.binaryVersion(L.exe)
      assert.ok(v.ok, `the pinned runtime would not run: ${v.why}`)
      assert.strictEqual(v.build, local.LLAMA_VERSION.replace(/^b/, ''), `build mismatch: ${JSON.stringify(v)}`)
      return true
    })

    await checkAsync('20. the model starts, answers, and says how long it took', async () => {
      const served = await local.serve({ root, timeoutMs: 60000 })
      assert.ok(served.ok, `the server did not start: ${served.error}`)
      try {
        const t0 = Date.now()
        const r = await fetch(`${served.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'local',
            stream: false,
            max_tokens: 24,
            messages: [{ role: 'user', content: 'Say hello in three words. /no_think' }],
          }),
        })
        assert.ok(r.ok, `the model answered with ${r.status}`)
        const j = await r.json()
        const text = String(j?.choices?.[0]?.message?.content || '').trim()
        const took = Date.now() - t0
        assert.ok(text, `the model returned no text: ${JSON.stringify(j).slice(0, 200)}`)
        console.log(`        it said "${text.replace(/\s+/g, ' ').slice(0, 60)}" in ${took} ms`)
        console.log(`        started and serving in ${served.tookMs} ms on ${served.baseUrl}`)
      } finally {
        served.stop()
      }
      return true
    })
  } else {
    console.log('\n=== the real thing was skipped (set ZEN_LOCAL_SEED to run it) ===')
  }

  console.log(`\n=== summary ===`)
  console.log(`  ${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED: ${f.name} — ${f.err && f.err.message}`)
    process.exit(1)
  }
  fs.rmSync(scratch, { recursive: true, force: true })
  process.exit(0)
})()
