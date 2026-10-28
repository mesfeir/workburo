#!/usr/bin/env node
/* Make one release the latest, and delete every other release with its tag.
 *
 * GitHub does not promote `latest` when a pre-release is flipped back to a full release, so the
 * pointer has to be set explicitly with make_latest. Old releases are removed deliberately: their
 * installers are superseded and nothing on the site links to them by tag.
 *
 *   node scripts/prune-releases.cjs <keep-tag> [--dry-run]
 */
const https = require('https')
const { execFileSync } = require('child_process')

const KEEP = process.argv[2]
const DRY = process.argv.includes('--dry-run')
const REPO = 'mesfeir/workburo'
if (!KEEP) {
  console.log('usage: prune-releases.cjs <keep-tag> [--dry-run]')
  process.exit(1)
}

const token = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8'
}).split('\n').find((l) => l.startsWith('password=')).slice(9).trim()

function api (method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null
    const req = https.request({
      host: 'api.github.com',
      path,
      method,
      headers: {
        Authorization: `token ${token}`,
        'User-Agent': 'workburo-prune',
        Accept: 'application/vnd.github+json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
      }
    }, (res) => {
      let b = ''
      res.on('data', (d) => { b += d })
      res.on('end', () => {
        let parsed = null
        try { parsed = b ? JSON.parse(b) : null } catch { parsed = null }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function main () {
  const list = await api('GET', `/repos/${REPO}/releases?per_page=100`)
  if (!Array.isArray(list.body)) {
    console.log(`could not list releases: HTTP ${list.status}`)
    process.exit(1)
  }
  const keep = list.body.find((r) => r.tag_name === KEEP)
  if (!keep) {
    console.log(`no release tagged ${KEEP} — nothing will be deleted`)
    process.exit(1)
  }

  console.log(`=== ${KEEP} becomes latest ===`)
  const made = await api('PATCH', `/repos/${REPO}/releases/${keep.id}`, { make_latest: 'true', prerelease: false })
  console.log(`   HTTP ${made.status}  prerelease=${made.body && made.body.prerelease}`)

  const doomed = list.body.filter((r) => r.tag_name !== KEEP)
  console.log(`=== removing ${doomed.length} older releases${DRY ? ' (dry run)' : ''} ===`)
  for (const r of doomed) {
    if (DRY) {
      console.log(`   would delete ${r.tag_name}  (${r.assets.length} assets)`)
      continue
    }
    const del = await api('DELETE', `/repos/${REPO}/releases/${r.id}`)
    const ref = await api('DELETE', `/repos/${REPO}/git/refs/tags/${r.tag_name}`)
    console.log(`   ${r.tag_name.padEnd(9)} release:${del.status}  tag:${ref.status}`)
  }

  // Read back rather than trust the calls above.
  const after = await api('GET', `/repos/${REPO}/releases?per_page=100`)
  const latest = await api('GET', `/repos/${REPO}/releases/latest`)
  console.log('=== what is left ===')
  console.log(`   latest: ${latest.body.tag_name}   assets: ${(latest.body.assets || []).length}`)
  for (const r of after.body) console.log(`   ${r.tag_name}  ${r.assets.length} assets`)
  console.log(`   total releases: ${after.body.length}`)
}

main().catch((e) => {
  console.error(`failed: ${e && e.message ? e.message : e}`)
  process.exit(1)
})
