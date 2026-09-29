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
// Derived, not hardcoded. This was still pointing at "Zen Chat.exe" after the app was renamed,
// which made the whole script a silent no-op — it found no exe, printed "nothing to do", and the
// icon and version info were never stamped onto the build at all.
const unpackedDir = path.join(projectRoot, 'release', 'win-unpacked')
const packagedExe = fs.existsSync(unpackedDir)
  ? fs.readdirSync(unpackedDir).find((f) => f.endsWith('.exe') && !/^uninstall/i.test(f))
  : null
// Takes an optional path so an already-installed exe can be restamped without a full rebuild:
//   node scripts/apply-icon.cjs "C:/Users/Mel/AppData/Local/Programs/WorkBuro/WorkBuro.exe"
const exeArgument = process.argv[2]
const exe = exeArgument || (packagedExe ? path.join(unpackedDir, packagedExe) : '')
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

  // Read from package.json rather than hardcoding. These strings were literal "Zen Chat" text, so
  // the rename left the icon correct but the file properties still naming the old product — visible
  // in Task Manager, the file's Details tab and anywhere that lists a description.
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  // productName lives in the build block for electron-builder, not at the top level, so reading it
  // only from the top level silently fell back to "name" and stamped the lowercase package name.
  const productName = (pkg.build && pkg.build.productName) || pkg.productName || pkg.name || 'WorkBuro'
  const description = pkg.description || productName
  const version = pkg.version || '1.0.0'

  const before = fs.statSync(exe)
  const args = [
    exe,
    '--set-icon', icon,
    '--set-version-string', 'ProductName', productName,
    '--set-version-string', 'FileDescription', description,
    '--set-version-string', 'CompanyName', 'Clearest Lab',
    '--set-version-string', 'LegalCopyright', 'Clearest Lab',
    '--set-file-version', version,
    '--set-product-version', version,
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
