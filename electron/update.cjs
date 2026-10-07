/**
 * Updating this app from its own releases.
 *
 * Why hand-rolled rather than electron-updater: electron-updater will not install an update on macOS
 * unless the running app and the update both carry a real Developer ID signature. Ours is signed
 * ad-hoc, so it would download the release, then fail at the last step, which is worse than not
 * offering the button. There is also a portable build that no installer can replace. So the work is
 * split: the same checked download on every platform, and an ending that differs and says why.
 *
 * The rules that decide what happens are pure functions at the top, so they are tested directly in
 * scripts/test-update.cjs rather than by clicking around.
 *
 * Two things this deliberately does NOT do:
 *   - install anything whose checksum has not been checked against the published SHA256SUMS file
 *   - pretend an install is possible where it is not (portable build, macOS without a signature)
 *
 * Nothing identifying is sent to GitHub: one GET of the public releases endpoint, no app id, no
 * machine id, no version header. The automatic check can be switched off in About.
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const OWNER = 'mesfeir'
const REPO = 'workburo'
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases`

/* ------------------------------------------------------------------ rules */

/**
 * A version as numbers, so 1.0.9 and 1.0.10 compare the way a person expects.
 * Anything unparseable sorts as 0.0.0 rather than throwing: a malformed tag must not break a release
 * check.
 */
function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(text || '').trim())
  if (!m) return { major: 0, minor: 0, patch: 0, pre: '' }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || '' }
}

/** -1 when a is older, 0 when the same, 1 when a is newer. A pre-release sorts before its release. */
function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

function isNewer(candidate, current) {
  return compareVersions(candidate, current) > 0
}

/**
 * Which file, of the ones published for this platform, is the one to fetch.
 *
 * Windows gets the installer because it can replace an installed app. A portable build gets the
 * portable file, because there is no installed app for an installer to replace. macOS gets the dmg.
 */
function pickAsset(release, { platform, portable = false } = {}) {
  const assets = (release && release.assets) || []
  const find = (re) => assets.find((a) => re.test(a.name))
  const version = String((release && release.tag_name) || '').replace(/^v/, '')

  if (platform === 'win32') {
    return portable
      ? find(new RegExp(`^WorkBuro-${version.replace(/\./g, '\\.')}-portable\\.exe$`)) || null
      : find(/^WorkBuro-Setup-.*\.exe$/i) || null
  }
  if (platform === 'darwin') {
    return find(/\.dmg$/i) || find(/-mac\.zip$/i) || null
  }
  return null
}

/** The published checksum file for a release, which is what a download is checked against. */
function sumsAssetName(version, platform) {
  const v = String(version || '').replace(/^v/, '')
  return platform === 'darwin' ? `SHA256SUMS-${v}-mac.txt` : `SHA256SUMS-${v}.txt`
}

function sumsUrl(version, platform) {
  return `${RELEASES_PAGE}/download/v${String(version || '').replace(/^v/, '')}/${sumsAssetName(version, platform)}`
}

/** The sha256 for one file out of a `sha256sum` style file, or '' when it is not listed. */
function checksumFor(sumsText, assetName) {
  for (const line of String(sumsText || '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line)
    if (m && m[2] === assetName) return m[1].toLowerCase()
  }
  return ''
}

/**
 * What should happen once a file has been downloaded and checked.
 *
 * The honest endings. Every branch that cannot install says what the person should do instead, so the
 * window can show a real instruction rather than a dead button.
 */
function installPlan({ platform, portable = false, checksumOk = false, hasChecksum = false, file }) {
  if (!file) return { action: 'none', why: 'Nothing has been downloaded yet.' }
  if (!hasChecksum) {
    return {
      action: 'open-release',
      why: 'No checksum was published for this file, so it cannot be verified. Open the download page instead.',
    }
  }
  if (!checksumOk) {
    return { action: 'none', why: 'That file does not match the published checksum. It will not be run.' }
  }
  if (platform === 'win32') {
    if (portable) {
      return {
        action: 'open-folder',
        why: 'This is the portable build, so there is nothing to replace. The new file has been downloaded for you.',
      }
    }
    return { action: 'run-installer', why: 'The installer will run, and the app will restart itself.' }
  }
  if (platform === 'darwin') {
    return {
      action: 'open-dmg',
      why: 'The app cannot replace itself on macOS without a Developer ID signature, so the disk image will be opened: drag WorkBuro to Applications, then choose Replace.',
    }
  }
  return { action: 'open-release', why: 'There is no installer for this platform.' }
}

/* ------------------------------------------------------------------ io */

async function getJson(url, signal) {
  const res = await fetch(url, {
    signal,
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `${REPO}-updater` },
  })
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  return res.json()
}

async function getText(url, signal) {
  const res = await fetch(url, { signal, redirect: 'follow', headers: { 'User-Agent': `${REPO}-updater` } })
  if (!res.ok) throw new Error(`checksum file answered ${res.status}`)
  return res.text()
}

/**
 * Ask GitHub for the newest release and decide whether it is worth telling anyone about.
 * Never throws: a failed check is a state the window shows, not an error that interrupts.
 */
async function checkForUpdate({ currentVersion, platform, portable = false, signal } = {}) {
  try {
    const release = await getJson(API, signal)
    const latest = String(release.tag_name || '').replace(/^v/, '')
    const asset = pickAsset(release, { platform, portable })
    return {
      ok: true,
      current: currentVersion,
      latest,
      newer: isNewer(latest, currentVersion),
      published: release.published_at || '',
      notesUrl: release.html_url || RELEASES_PAGE,
      notes: String(release.body || '').slice(0, 4000),
      asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
      sumsUrl: sumsUrl(latest, platform),
      sumsName: sumsAssetName(latest, platform),
      error: '',
    }
  } catch (err) {
    return {
      ok: false,
      current: currentVersion,
      latest: '',
      newer: false,
      error: err && err.name === 'AbortError' ? 'The check was stopped.' : (err && err.message) || 'Could not reach GitHub.',
    }
  }
}

/**
 * Download to a file, hashing as it goes so the bytes are never read twice.
 * Progress is reported per chunk but throttled, because a 105 MB download would otherwise send
 * thousands of messages to the window.
 */
async function downloadAsset(url, dest, { onProgress, signal } = {}) {
  const res = await fetch(url, { signal, redirect: 'follow', headers: { 'User-Agent': `${REPO}-updater` } })
  if (!res.ok) throw new Error(`download answered ${res.status}`)

  const total = Number(res.headers.get('content-length')) || 0
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const out = fs.createWriteStream(dest)
  const hash = crypto.createHash('sha256')
  let received = 0
  let lastSent = 0

  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      received += value.length
      if (!out.write(Buffer.from(value))) {
        await new Promise((resolve) => out.once('drain', resolve))
      }
      const now = Date.now()
      if (onProgress && now - lastSent > 120) {
        lastSent = now
        onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : 0 })
      }
    }
  } finally {
    await new Promise((resolve) => out.end(resolve))
  }

  if (onProgress) onProgress({ received, total, percent: 100 })
  return { path: dest, bytes: received, sha256: hash.digest('hex') }
}

/** Check a finished download against the published checksum file. */
async function verifyDownload({ file, assetName, version, platform, signal }) {
  try {
    const text = await getText(sumsUrl(version, platform), signal)
    const want = checksumFor(text, assetName)
    if (!want) return { hasChecksum: false, ok: false, want: '', got: file.sha256 }
    return { hasChecksum: true, ok: want === file.sha256.toLowerCase(), want, got: file.sha256 }
  } catch {
    return { hasChecksum: false, ok: false, want: '', got: file.sha256, error: 'The checksum file could not be read.' }
  }
}

/** Windows: hand the verified installer to the system and quit so it can replace these files. */
function runWindowsInstaller(installerPath) {
  const child = spawn(installerPath, ['/S'], { detached: true, stdio: 'ignore' })
  child.unref()
}

module.exports = {
  OWNER,
  REPO,
  RELEASES_PAGE,
  parseVersion,
  compareVersions,
  isNewer,
  pickAsset,
  sumsAssetName,
  sumsUrl,
  checksumFor,
  installPlan,
  checkForUpdate,
  downloadAsset,
  verifyDownload,
  runWindowsInstaller,
}
