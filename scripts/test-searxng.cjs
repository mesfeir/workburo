/**
 * The one-click SearXNG install.
 *
 * Two failures here are silent and total, which is why they get tests rather than trust:
 *
 *   * the image ships with the JSON API off, so a container started without the mounted settings
 *     file answers 403 to every query, and search looks broken on an install that "succeeded";
 *   * `docker run` returns as soon as the container exists, which is well before it serves, so
 *     reporting success at that moment reports a working install that does not work yet.
 *
 * Offline: no daemon, no network. The runner is injected, which is also how the exact docker
 * arguments get checked.
 */
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const searxng = require('../electron/searxng.cjs')

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
async function checkAsync(name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') await r
    console.log(`PASS  ${name}`)
    passed += 1
  } catch (err) {
    console.log(`FAIL  ${name}\n        ${err.message}`)
    failed += 1
  }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wb-searxng-'))

/** A docker that says whatever this test needs it to say, and remembers the arguments. */
function fakeDocker({ present = true, daemon = true, inspect = null, runCode = 0, onRun = null } = {}) {
  const calls = []
  const run = async (args) => {
    calls.push(args.join(' '))
    if (args[0] === '--version') {
      return present
        ? { code: 0, stdout: 'Docker version 29.3.1, build c2be9cc\n', stderr: '' }
        : { code: -1, stdout: '', stderr: 'docker: command not found' }
    }
    if (args[0] === 'info') {
      return daemon
        ? { code: 0, stdout: '29.3.1\n', stderr: '' }
        : { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }
    }
    if (args[0] === 'inspect') {
      return inspect
        ? { code: 0, stdout: `${inspect}\n`, stderr: '' }
        : { code: 1, stdout: '', stderr: 'No such object' }
    }
    if (onRun) onRun(args)
    return { code: runCode, stdout: runCode === 0 ? 'containerid\n' : '', stderr: runCode === 0 ? '' : 'docker said no' }
  }
  run.calls = calls
  return run
}

/** A fetch that fails the first few times and then answers, like a real instance coming up. */
function fakeFetch({ failUntil = 0, status = 200, results = ['a', 'b'] } = {}) {
  let n = 0
  const f = async () => {
    n += 1
    if (n <= failUntil) throw new Error('connection refused')
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ results }),
    }
  }
  f.count = () => n
  return f
}

;(async () => {
  /* ---- the settings file: the only reason JSON works ---- */

  check('the settings file turns the JSON API on, which the image leaves off', () => {
    const yml = searxng.settingsYml(8888, 'abc123')
    assert.match(yml, /formats:\s*\n\s+- html\s*\n\s+- json/, yml)
    assert.match(yml, /use_default_settings: true/, yml)
    assert.match(yml, /secret_key: "abc123"/, yml)
    assert.match(yml, /base_url: "http:\/\/localhost:8888\/"/, yml)
  })

  check('the settings file follows the port it was given, so a second instance does not lie', () => {
    assert.match(searxng.settingsYml(8889, 'k'), /localhost:8889/)
    assert.ok(!/localhost:8888/.test(searxng.settingsYml(8889, 'k')), 'it hardcoded the default port')
  })

  check('the settings folder is mounted where SearXNG reads it from', () => {
    const dir = searxng.settingsDir('C:/data')
    assert.strictEqual(dir, path.join('C:/data', 'searxng', 'searxng'))
  })

  /* ---- the docker arguments ---- */

  check('the container is given a port, the mount and a restart policy', () => {
    const args = searxng.runArgs({ dir: 'C:\\data\\x', port: 8889, name: 'thing' })
    assert.strictEqual(args[0], 'run')
    assert.ok(args.includes('-d'), 'it would run in the foreground')
    assert.strictEqual(args[args.indexOf('--name') + 1], 'thing')
    assert.strictEqual(args[args.indexOf('-p') + 1], '8889:8080')
    assert.strictEqual(args[args.indexOf('--restart') + 1], 'unless-stopped')
    assert.strictEqual(args[args.indexOf('-v') + 1], 'C:/data/x:/etc/searxng:rw')
    assert.strictEqual(args[args.length - 1], 'searxng/searxng:latest')
    // A backslash path is the one argument that silently breaks the mount on Docker Desktop.
    assert.ok(!args[args.indexOf('-v') + 1].includes('\\'), 'the mounted path kept its backslashes')
  })

  /* ---- reading docker ---- */

  await checkAsync('no docker is reported as no docker, not as a failure to explain', async () => {
    const s = await searxng.dockerStatus({ run: fakeDocker({ present: false }) })
    assert.strictEqual(s.docker, false)
    assert.strictEqual(s.daemon, false)
  })

  await checkAsync('docker installed with a dead daemon is told apart from docker missing', async () => {
    const s = await searxng.dockerStatus({ run: fakeDocker({ present: true, daemon: false }) })
    assert.strictEqual(s.docker, true)
    assert.strictEqual(s.daemon, false)
    assert.match(s.error, /daemon/)
  })

  await checkAsync('the version reads as a version, not as a sentence to paste into one', async () => {
    const s = await searxng.dockerStatus({ run: fakeDocker() })
    assert.strictEqual(s.version, '29.3.1', `it kept "${s.version}"`)
    // Which is exactly the bug: "Docker Docker version 29.3.1, build c2be9cc is here".
    assert.ok(!/^Docker|build/i.test(s.version), `it kept the whole line: ${s.version}`)
  })

  /* ---- the install itself ---- */

  await checkAsync('without docker it refuses honestly and points at what still works', async () => {
    const r = await searxng.installSearxng({ dir: searxng.settingsDir(tmp()), run: fakeDocker({ present: false }) })
    assert.strictEqual(r.ok, false)
    assert.match(r.error, /Docker is not installed/)
    assert.match(r.error, /reference sources need nothing/, 'it does not mention that search still works')
  })

  await checkAsync('with the daemon down it says to start Docker rather than failing obscurely', async () => {
    const r = await searxng.installSearxng({ dir: searxng.settingsDir(tmp()), run: fakeDocker({ daemon: false }) })
    assert.strictEqual(r.ok, false)
    assert.match(r.error, /daemon is not running/)
  })

  await checkAsync('a full install writes the settings, runs the right command, and waits until it answers', async () => {
    const base = tmp()
    const run = fakeDocker()
    const f = fakeFetch({ failUntil: 2 }) // the container exists but is not serving yet
    const phases = []
    const r = await searxng.installSearxng({
      port: 8889,
      name: 'wb-test',
      dir: searxng.settingsDir(base),
      run,
      fetchImpl: f,
      onProgress: (p) => phases.push(p.phase),
      waitMs: 30000,
    })
    assert.ok(r.ok, `it failed: ${r.error}`)
    assert.strictEqual(r.port, 8889)
    assert.strictEqual(r.results, 2)

    // The settings file has to be on disk BEFORE the container starts, or JSON stays off.
    const file = path.join(searxng.settingsDir(base), 'settings.yml')
    assert.ok(fs.existsSync(file), 'no settings file was written')
    assert.match(fs.readFileSync(file, 'utf8'), /- json/)

    const ran = run.calls.find((c) => c.startsWith('run '))
    assert.ok(ran, `it never ran the container: ${run.calls.join(' | ')}`)
    assert.ok(ran.includes('wb-test'), ran)
    assert.ok(ran.includes('8889:8080'), ran)
    assert.ok(ran.includes('searxng/searxng:latest'), ran)

    // Two refused connections before it answered: it really did wait.
    assert.ok(f.count() >= 3, `it asked ${f.count()} times, so it did not wait for the instance`)
    assert.deepStrictEqual(phases, ['settings', 'pull', 'wait', 'ready'])
  })

  await checkAsync('a container that starts but never answers is not reported as working', async () => {
    const r = await searxng.installSearxng({
      port: 8889,
      name: 'wb-test',
      dir: searxng.settingsDir(tmp()),
      run: fakeDocker(),
      fetchImpl: fakeFetch({ failUntil: 9999 }),
      waitMs: 300,
    })
    assert.strictEqual(r.ok, false)
    assert.match(r.error, /still not answering/)
    // The container is deliberately left running, so the error has to say how to look at it.
    assert.match(r.error, /docker logs wb-test/)
  })

  await checkAsync('a container answering 403 is named as such, not counted as ready', async () => {
    const r = await searxng.installSearxng({
      port: 8889,
      name: 'wb-test',
      dir: searxng.settingsDir(tmp()),
      run: fakeDocker(),
      fetchImpl: fakeFetch({ failUntil: 0, status: 403 }),
      waitMs: 300,
    })
    assert.strictEqual(r.ok, false)
    assert.match(r.error, /HTTP 403/)
  })

  await checkAsync('an existing running container is reused instead of a second one being made', async () => {
    const run = fakeDocker({ inspect: 'running' })
    const r = await searxng.installSearxng({
      port: 8888,
      name: 'workburo-searxng',
      dir: searxng.settingsDir(tmp()),
      run,
      fetchImpl: fakeFetch(),
      waitMs: 30000,
    })
    assert.ok(r.ok, r.error)
    assert.ok(!run.calls.some((c) => c.startsWith('run ')), `it made a second container: ${run.calls.join(' | ')}`)
  })

  await checkAsync('an existing stopped container is started, not duplicated', async () => {
    const run = fakeDocker({ inspect: 'exited' })
    const r = await searxng.installSearxng({
      port: 8888,
      name: 'workburo-searxng',
      dir: searxng.settingsDir(tmp()),
      run,
      fetchImpl: fakeFetch(),
      waitMs: 30000,
    })
    assert.ok(r.ok, r.error)
    assert.ok(run.calls.includes('start workburo-searxng'), run.calls.join(' | '))
    assert.ok(!run.calls.some((c) => c.startsWith('run ')), 'it made a duplicate container')
  })

  await checkAsync('docker refusing to start the container comes back as the reason it gave', async () => {
    const r = await searxng.installSearxng({
      port: 8889,
      name: 'wb-test',
      dir: searxng.settingsDir(tmp()),
      run: fakeDocker({ runCode: 1 }),
      fetchImpl: fakeFetch(),
      waitMs: 300,
    })
    assert.strictEqual(r.ok, false)
    assert.match(r.error, /docker said no/)
  })

  console.log(`\n${passed}/${passed + failed} checks passed`)
  process.exit(failed ? 1 : 0)
})()
