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

const notes = [
  '## What is new',
  '',
  'Pictures the agent makes now appear in the chat, with the drawing state shown while it works.',
  '',
  '**Ask for more than one.** Set a count and a single call returns several pictures.',
  '',
  '**Change a picture you already have.** Give the agent a picture from before and it edits that one,',
  'rather than drawing a new one from your words. Edits use the image-to-image model in Settings under Images.',
  '',
  '**A real image tool for the agent.** The agent has an image tool of its own, so it can act instead of',
  'describing what it would have drawn.',
  '',
  '**Files the agent writes can be opened.** Open and Reveal work on anything the agent produced, and the',
  'agent is told where your pictures are kept.',
  '',
  '**One key per provider.** Every provider has its own key field with a Test that tells you whether it works.',
  '',
  '**Hundreds of models across every provider you have a key for**, searchable, grouped by provider, and',
  'labelled with the provider they come from.',
  '',
  '## Install',
  '',
  `Run \`WorkBuro-Setup-${VERSION}.exe\`, or take \`WorkBuro-${VERSION}-portable.exe\` if you would rather not`,
  'install anything.',
  '',
  `Check your download against \`SHA256SUMS-${VERSION}.txt\`.`,
  '',
  'Windows only for now. The builds are unsigned, so SmartScreen will ask.'
].join('\n')

async function main () {
  const rel = path.join(__dirname, '..', 'release')
  const assets = [
    `WorkBuro-Setup-${VERSION}.exe`,
    `WorkBuro-${VERSION}-portable.exe`,
    `SHA256SUMS-${VERSION}.txt`
  ]
  for (const a of assets) {
    if (!fs.existsSync(path.join(rel, a))) {
      console.log(`missing asset: ${a}`)
      process.exit(1)
    }
  }

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

  for (const name of assets) {
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
  console.log(`   assets: ${(final.assets || []).length} of ${assets.length}`)
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
