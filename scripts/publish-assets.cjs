#!/usr/bin/env node
/* Attach files to a release that already exists, and promote it out of pre-release.
 *
 * A release sometimes ships one platform first (the other machine is asleep, or the build is
 * still running). That build goes out as a pre-release so `latest` keeps pointing at a release
 * that carries every download the site links to. When the second platform is built, this adds its
 * assets to the same release and, with --promote, lets it become `latest`.
 *
 *   node scripts/publish-assets.cjs <version> [--promote]
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const REPO = 'mesfeir/workburo'
const VERSION = process.argv[2]
if (!VERSION) {
  console.log('usage: publish-assets.cjs <version> [--promote]')
  process.exit(1)
}
const TAG = `v${VERSION}`
const PROMOTE = process.argv.includes('--promote')
const REL = path.join(__dirname, '..', 'release')

// The token comes from the same credential store the publish script uses, and is never printed.
const raw = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8'
})
const token = (raw.split('\n').find((l) => l.startsWith('password=')) || '').replace(/^password=/, '').trim()
if (!token) {
  console.log('no github credential available')
  process.exit(1)
}
const H = { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' }

async function main () {
  const look = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers: H })
  const release = await look.json()
  if (!release.id) {
    console.log(`no release ${TAG}: HTTP ${look.status} ${release.message || ''}`)
    process.exit(1)
  }
  console.log(`   release ${release.id}   prerelease=${release.prerelease}   assets=${(release.assets || []).length}`)

  const files = fs.readdirSync(REL).filter((f) => f.includes(VERSION) && /\.(dmg|zip|txt)$/.test(f))
  const have = new Map((release.assets || []).map((a) => [a.name, a]))
  for (const name of files) {
    const bytes = fs.readFileSync(path.join(REL, name))
    const prior = have.get(name)
    if (prior && prior.size === bytes.length) {
      console.log(`   ${name}: already there (${prior.size} bytes)`)
      continue
    }
    if (prior) {
      console.log(`   ${name}: replacing ${prior.size} -> ${bytes.length} bytes`)
      await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${prior.id}`, { method: 'DELETE', headers: H })
    }
    const up = await fetch(
      `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      { method: 'POST', headers: { ...H, 'Content-Type': 'application/octet-stream' }, body: bytes }
    )
    const done = await up.json()
    console.log(done.id ? `   ${name}: uploaded, ${done.size} bytes` : `   ${name}: FAILED HTTP ${up.status} ${done.message}`)
  }

  if (PROMOTE) {
    const p = await fetch(`https://api.github.com/repos/${REPO}/releases/${release.id}`, {
      method: 'PATCH',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prerelease: false })
    })
    const out = await p.json()
    console.log(out.id ? `   promoted: prerelease=${out.prerelease}` : `   promote FAILED HTTP ${p.status}`)
  }

  // Read back rather than trust the calls above.
  const check = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers: H })
  const final = await check.json()
  console.log(`   tag ${final.tag_name}   prerelease=${final.prerelease}   assets=${(final.assets || []).length}`)
  for (const a of final.assets || []) console.log(`     ${a.name}  ${a.size}`)
}

main().catch((e) => {
  console.error(`failed: ${e && e.message ? e.message : e}`)
  process.exit(1)
})
