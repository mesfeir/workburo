/**
 * Setting up SearXNG in one click: a container, the one settings file that turns its JSON API on,
 * and a wait until it is actually answering.
 *
 * Two things had to be right for search to work, and both are easy to get wrong:
 *
 *   * the image ships with the JSON API OFF, so a container started without a mounted settings file
 *     answers 403 to every query and search looks broken;
 *   * a container that has "started" is not yet serving, so a query sent too early fails on a
 *     perfectly good install.
 *
 * The Docker arguments and the settings file are built by pure functions so they can be checked
 * without a daemon, and the runner is injectable so a test can see exactly what would be run.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const IMAGE = 'searxng/searxng:latest'
const CONTAINER = 'workburo-searxng'
const DEFAULT_PORT = 8888

/**
 * The settings file, and the only reason it exists: `formats` includes json.
 *
 * SearXNG reads its defaults from the image and this file only overrides, so a secret key and the
 * JSON format are the whole of it. The secret is generated per install because the image's own is
 * shared by every copy of it.
 */
function settingsYml (port, secret) {
  return [
    '# Written by WorkBuro when it set search up. SearXNG inherits everything else from the image.',
    'use_default_settings: true',
    '',
    'server:',
    `  secret_key: "${secret}"`,
    `  base_url: "http://localhost:${port}/"`,
    '  limiter: false',
    '  public_instance: false',
    '  image_proxy: true',
    '',
    'search:',
    '  # The JSON API is OFF in the image defaults and search needs it. Without this every query',
    '  # comes back 403 and a working install looks broken.',
    '  formats:',
    '    - html',
    '    - json',
    '  safe_search: 0',
    '  autocomplete: ""',
    '  default_lang: "auto"',
    '',
  ].join('\n')
}

/** The exact docker arguments. Kept pure because a wrong one here is a silent, total failure. */
function runArgs ({ dir, port, name }) {
  return [
    'run', '-d',
    '--name', name,
    '--restart', 'unless-stopped',
    '-p', `${port}:8080`,
    // Forward slashes: this is a native argument, and Docker Desktop reads C:/... reliably.
    '-v', `${String(dir).replace(/\\/g, '/')}:/etc/searxng:rw`,
    '-e', `SEARXNG_BASE_URL=http://localhost:${port}/`,
    '-e', 'SEARXNG_LIMITER=false',
    IMAGE,
  ]
}

/** Where the settings file goes, and the folder that gets mounted. */
function settingsDir (base) {
  return path.join(base, 'searxng', 'searxng')
}

/** Run docker and hand back what it said. Never rejects: docker being absent is an answer. */
function dockerRunner (cmd = 'docker') {
  return (args, { timeout = 60000 } = {}) =>
    new Promise((resolve) => {
      let child
      try {
        child = spawn(cmd, args, { windowsHide: true })
      } catch (err) {
        resolve({ code: -1, stdout: '', stderr: err.message })
        return
      }
      let stdout = ''
      let stderr = ''
      let timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        resolve({ code: -1, stdout, stderr: `${stderr}\ndocker timed out after ${timeout}ms` })
      }, timeout)
      child.stdout.on('data', (b) => {
        stdout += String(b)
      })
      child.stderr.on('data', (b) => {
        stderr += String(b)
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code === null ? -1 : code, stdout, stderr })
      })
    })
}

/** Is docker installed, and is its daemon awake? Two separate questions: on Windows they differ. */
async function dockerStatus (opts = {}) {
  const run = opts.run || dockerRunner()
  const version = await run(['--version'], { timeout: 15000 })
  if (version.code !== 0) {
    return { docker: false, daemon: false, version: null, error: (version.stderr || '').trim() || 'docker was not found' }
  }
  const info = await run(['info', '--format', '{{.ServerVersion}}'], { timeout: 30000 })
  // `docker --version` answers with a whole sentence ("Docker version 29.3.1, build c2be9cc"), and
  // that reads as nonsense the moment it is put inside a sentence of our own.
  const raw = (version.stdout || '').trim()
  const just = (raw.match(/version\s+([0-9][0-9.]*)/i) || [])[1] || raw
  return {
    docker: true,
    daemon: info.code === 0,
    version: just,
    error: info.code === 0 ? null : (info.stderr || '').trim() || 'the Docker daemon is not running',
  }
}

/** Does this container already exist, and is it running? */
async function containerState (name, opts = {}) {
  const run = opts.run || dockerRunner()
  const r = await run(['inspect', name, '--format', '{{.State.Status}}'], { timeout: 20000 })
  if (r.code !== 0) return { exists: false, running: false }
  const status = (r.stdout || '').trim()
  return { exists: true, running: status === 'running', status }
}

/**
 * One click: write the settings file, start the container, then wait until search actually answers.
 *
 * The wait is the part that matters. `docker run` returns as soon as the container is created, and
 * the instance is not serving yet; treating that as done is how an install gets reported as working
 * while every query still fails.
 */
async function installSearxng (opts = {}) {
  const port = Number(opts.port) || DEFAULT_PORT
  const name = opts.name || CONTAINER
  const run = opts.run || dockerRunner(opts.docker)
  const say = typeof opts.onProgress === 'function' ? opts.onProgress : () => {}
  const call = opts.fetchImpl || fetch
  const probeUrl = `http://localhost:${port}/search?q=workburo&format=json`
  const deadline = Date.now() + (Number(opts.waitMs) || 180000)

  const status = await dockerStatus({ run })
  if (!status.docker) {
    return {
      ok: false,
      error:
        'Docker is not installed on this machine, so SearXNG cannot be set up in one click. ' +
        'Search still works: the reference sources need nothing at all. Install Docker Desktop to ' +
        'run your own instance.',
    }
  }
  if (!status.daemon) {
    return { ok: false, error: `Docker is installed but its daemon is not running. Start Docker Desktop and try again. (${status.error})` }
  }

  // The settings file first: a container started before it exists answers 403 for every query.
  const dir = opts.dir ? String(opts.dir) : settingsDir(opts.dataDir || process.cwd())
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'settings.yml')
  fs.writeFileSync(file, settingsYml(port, crypto.randomBytes(32).toString('hex')), 'utf8')
  say({ phase: 'settings', message: `wrote ${file}` })

  const state = await containerState(name, { run })
  let started
  if (state.exists) {
    say({ phase: 'start', message: `container ${name} already exists (${state.status})` })
    started = state.running ? { code: 0, stdout: name, stderr: '' } : await run(['start', name], { timeout: 120000 })
  } else {
    say({ phase: 'pull', message: 'starting the container, which downloads the image the first time' })
    started = await run(runArgs({ dir, port, name }), { timeout: Number(opts.pullMs) || 900000 })
  }
  if (started.code !== 0) {
    return { ok: false, error: `Docker could not start the container: ${(started.stderr || started.stdout || '').trim().slice(0, 400)}` }
  }

  // Now wait for it to serve, rather than assuming that starting means serving.
  say({ phase: 'wait', message: 'waiting for it to answer' })
  let last = ''
  while (Date.now() < deadline) {
    try {
      const res = await call(probeUrl, { signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        const json = await res.json()
        if (Array.isArray(json.results)) {
          say({ phase: 'ready', message: `answering at http://localhost:${port}` })
          return { ok: true, url: `http://localhost:${port}`, port, name, results: json.results.length }
        }
        last = 'it answered but not with the JSON API'
      } else {
        // 403 here is the JSON format being off, which the mounted settings file prevents.
        last = `HTTP ${res.status}`
      }
    } catch (err) {
      last = err.message
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return {
    ok: false,
    error:
      `The container started but search is still not answering at http://localhost:${port} after ` +
      `${Math.round((Number(opts.waitMs) || 180000) / 1000)}s (last answer: ${last}). The container is ` +
      `left running so it can be looked at: docker logs ${name}`,
  }
}

module.exports = {
  IMAGE,
  CONTAINER,
  DEFAULT_PORT,
  settingsYml,
  runArgs,
  settingsDir,
  dockerRunner,
  dockerStatus,
  containerState,
  installSearxng,
}
