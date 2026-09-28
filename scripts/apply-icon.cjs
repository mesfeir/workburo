#!/usr/bin/env node
/**
 * electron-builder's winCodeSign bundle can't be extracted without Windows
 * Developer Mode (it contains macOS symlinks, and creating symlinks needs
 * SeCreateSymbolicLinkPrivilege). That makes electron-builder fail before it
 * can stamp our icon/version info into the app exe.
 *
 * This script does that stamping afterwards with the rcedit.exe that *was*
 * extracted into electron-builder's cache, so `npm run dist` stays one command
 * on machines without Developer Mode.
 *
 * If the cache has no rcedit (e.g. a machine where Developer Mode is on and
 * electron-builder already did the job), it exits cleanly and changes nothing.
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const projectRoot = path.join(__dirname, '..')
const exe = path.join(projectRoot, 'release', 'win-unpacked', 'Zen Chat.exe')
const icon = path.join(projectRoot, 'build', 'icon.ico')

function findRcedit() {
  const cacheRoot =
    process.env.ELECTRON_BUILDER_CACHE ||
    path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache')

  const candidates = [
    path.join(cacheRoot, 'winCodeSign'),
  ]
  for (const dir of candidates) {
    let entries = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const p = path.join(dir, entry, 'rcedit-x64.exe')
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

function main() {
  if (!fs.existsSync(exe)) {
    console.log('[apply-icon] no packaged exe yet — nothing to do')
    return
  }
  if (!fs.existsSync(icon)) {
    console.log('[apply-icon] build/icon.ico missing — skipping')
    return
  }

  const rcedit = findRcedit()
  if (!rcedit) {
    console.log('[apply-icon] rcedit not found in the electron-builder cache;')
    console.log('             the app exe keeps Electron\'s default icon.')
    console.log('             (Turn on Windows Developer Mode to let electron-builder do this itself.)')
    return
  }

  const before = fs.statSync(exe)
  const args = [
    exe,
    '--set-icon', icon,
    '--set-version-string', 'ProductName', 'Zen Chat',
    '--set-version-string', 'FileDescription', 'Zen Chat — bring-your-own-API AI chat client',
    '--set-version-string', 'CompanyName', 'Clearest Lab',
    '--set-version-string', 'LegalCopyright', 'Clearest Lab',
    '--set-file-version', '1.0.0',
    '--set-product-version', '1.0.0',
  ]

  try {
    execFileSync(rcedit, args, { stdio: 'pipe' })
  } catch (err) {
    console.log(`[apply-icon] rcedit failed: ${err.message}`)
    return
  }

  const after = fs.statSync(exe)
  console.log(
    `[apply-icon] stamped icon + version info via ${path.basename(rcedit)} (exe ${before.size} -> ${after.size} bytes)`,
  )
}

main()
