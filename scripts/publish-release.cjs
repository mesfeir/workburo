'use strict'

// Publish a release: create it, upload the assets, then read it back and say what is really there.
// The token comes from the git credential store through a child process and is never printed.

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const REPO = 'mesfeir/workburo'
const TAG = process.argv[2] || 'v1.0.9'
const VERSION = TAG.replace(/^v/, '')

/** Delete releases by tag. Their git tags go with them, so a mistake is re-publishable. */
async function remove (tags) {
  for (const tag of tags) {
    const found = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, {
      headers: { Authorization: `Bearer ${AUTH}`, Accept: 'application/vnd.github+json' }
    })
    if (found.status === 404) {
      console.log(`   ${tag}: not published, nothing to remove`)
      continue
    }
    const rel = await found.json()
    const del = await fetch(`https://api.github.com/repos/${REPO}/releases/${rel.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${AUTH}`, Accept: 'application/vnd.github+json' }
    })
    console.log(`   ${tag}: HTTP ${del.status}${del.status === 204 ? ' removed' : ` ${(await del.text()).slice(0, 120)}`}`)

    // the tag itself is separate, and leaving it behind blocks re-publishing the same version
    const tagDel = await fetch(`https://api.github.com/repos/${REPO}/git/refs/tags/${tag}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${AUTH}`, Accept: 'application/vnd.github+json' }
    })
    if (tagDel.status === 204) console.log(`   ${tag}: tag removed too`)
    else if (tagDel.status !== 404) console.log(`   ${tag}: tag left behind (HTTP ${tagDel.status})`)
  }
  const left = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
    headers: { Authorization: `Bearer ${AUTH}`, Accept: 'application/vnd.github+json' }
  })
  const all = await left.json()
  console.log(`=== published now (${all.length}) ===`)
  for (const r of all) console.log(`   ${r.tag_name}  ${(r.assets || []).length} assets  ${r.published_at || ''}`)
}

const token = execFileSync(
  'git',
  ['credential', 'fill'],
  { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' }
)
  .split('\n')
  .find((l) => l.startsWith('password='))
if (!token) {
  console.log('no github credential available')
  process.exit(1)
}
const AUTH = token.replace(/^password=/, '').trim()

// Notes live in release/notes-<version>.md: a release must not inherit the last one's prose.
const notesFile = path.join(__dirname, '..', 'release', `notes-${VERSION}.md`)
const notes = fs.existsSync(notesFile)
  ? fs.readFileSync(notesFile, 'utf8')
  : `WorkBuro ${VERSION}.\n\nSee the release assets for this build.`
console.log(notesFile && fs.existsSync(notesFile) ? `notes: release/notes-${VERSION}.md` : 'notes: none found, using a placeholder')

async function main () {
  const rel = path.join(__dirname, '..', 'release')
  const assets = [
    `WorkBuro-Setup-${VERSION}.exe`,
    `WorkBuro-${VERSION}-portable.exe`,
    `WorkBuro-${VERSION}.dmg`,
    `WorkBuro-${VERSION}-arm64-mac.zip`,
    `SHA256SUMS-${VERSION}.txt`,
    `SHA256SUMS-${VERSION}-mac.txt`
  ]
  // Build the list from what is actually there. A release with no Mac build is a legitimate
  // release, and the notes say so; an asset silently swapped for an older file would be worse than
  // a shorter list, so anything absent is reported and left out.
  const present = assets.filter((a) => fs.existsSync(path.join(rel, a)))
  for (const a of assets) if (!present.includes(a)) console.log(`   not built, left out: ${a}`)

  console.log('=== create the release ===')
  const created = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AUTH}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      tag_name: TAG,
      name: `WorkBuro ${VERSION}`,
      target_commitish: 'main',
      draft: false,
      prerelease: false,
      body: notes
    })
  })
  const release = await created.json()
  if (!release.id) {
    console.log(`   failed: HTTP ${created.status} ${release.message || JSON.stringify(release).slice(0, 300)}`)
    process.exit(1)
  }
  console.log(`   id ${release.id}   ${release.html_url}`)

  for (const name of present) {
    const bytes = fs.readFileSync(path.join(rel, name))
    console.log(`=== upload ${name} (${bytes.length} bytes) ===`)
    const up = await fetch(
      `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${AUTH}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.length)
        },
        body: bytes
      }
    )
    const done = await up.json()
    console.log(done.id ? `   uploaded, ${done.size} bytes` : `   FAILED: HTTP ${up.status} ${done.message}`)
  }

  // read it back, because a successful upload call is not a successful release
  console.log('=== what is actually published ===')
  const check = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, {
    headers: { Authorization: `Bearer ${AUTH}`, Accept: 'application/vnd.github+json' }
  })
  const final = await check.json()
  console.log(`   tag: ${final.tag_name}   published: ${!final.draft}   url: ${final.html_url}`)
  for (const a of final.assets || []) {
    console.log(`   asset: ${a.name}  ${a.size} bytes  downloads: ${a.download_count}`)
  }
  console.log(`   assets: ${(final.assets || []).length} of ${present.length} expected`)
}

// Publish by default; --delete removes releases and their tags instead, so a mistake is fixable.
if (process.argv[2] === '--delete') {
  remove(process.argv.slice(3)).catch((e) => {
    console.error(`failed: ${e && e.message ? e.message : e}`)
    process.exit(1)
  })
} else {
  main().catch((e) => {
    console.error(`failed: ${e && e.message ? e.message : e}`)
    process.exit(1)
  })
}
