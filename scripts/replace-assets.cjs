'use strict'
/*
 * Replace the Windows assets on an already-published release.
 *
 * The 1.1.1 Windows build was packaged on a machine whose electron-builder cache had no rcedit, so
 * the exe kept Electron's own icon and identity. The stamps are fixed and the binaries rebuilt; this
 * swaps them on the existing release without touching the tag, the notes or the Mac assets.
 *
 * The token comes from the git credential store and is never printed.
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const REPO = 'mesfeir/workburo'
const TAG = process.argv[2] || 'v1.1.1'
const RELEASE_DIR = path.join(__dirname, '..', 'release')

const REPLACE = [
  'WorkBuro-Setup-1.1.1.exe',
  'WorkBuro-1.1.1-portable.exe',
  'SHA256SUMS-1.1.1.txt'
]

const token = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8'
}).split('\n').find((l) => l.startsWith('password='))
if (!token) { console.log('no github credential available'); process.exit(1) }
const AUTH = token.replace(/^password=/, '').trim()

const api = (url, init = {}) =>
  fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${AUTH}`, 'User-Agent': 'workburo-release', ...(init.headers || {}) }
  })

;(async () => {
  const rel = await (await api(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`)).json()
  if (!rel.id) { console.log('no release', TAG); process.exit(1) }
  console.log(`release ${rel.tag_name} (id ${rel.id}) has ${rel.assets.length} assets`)

  for (const name of REPLACE) {
    const existing = rel.assets.find((a) => a.name === name)
    if (!existing) { console.log(`  ${name}: not on the release, nothing to delete`); continue }
    const r = await api(`https://api.github.com/repos/${REPO}/releases/assets/${existing.id}`, { method: 'DELETE' })
    console.log(`  deleted ${name}: HTTP ${r.status}`)
  }

  for (const name of REPLACE) {
    const file = path.join(RELEASE_DIR, name)
    if (!fs.existsSync(file)) { console.log(`  MISSING LOCALLY: ${file}`); continue }
    const body = fs.readFileSync(file)
    const r = await api(
      `https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body }
    )
    const j = await r.json()
    console.log(`  uploaded ${name} (${body.length} bytes): HTTP ${r.status} ${j.state || j.message || ''}`)
  }

  const after = await (await api(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`)).json()
  console.log('\n=== the release now ===')
  console.log(`  tag: ${after.tag_name}   draft: ${after.draft}   assets: ${after.assets.length}`)
  for (const a of after.assets) console.log(`  ${a.name}  ${a.size} bytes  ${a.state}`)
})().catch((e) => { console.log('failed:', e.message); process.exit(1) })
