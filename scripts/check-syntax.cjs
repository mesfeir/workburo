/**
 * Every CommonJS file has to parse before anything is packaged.
 *
 * This exists because it did not: a duplicated destructured name in main.cjs built cleanly, packed
 * cleanly, installed cleanly — and left the app unable to start, with a crash dialog on the user's
 * screen. electron-builder does not read the JavaScript it ships, and tsc only covers the renderer,
 * so nothing else in the pipeline would have caught it.
 *
 * Runs as `predist`, so `npm run dist` cannot ship a main process that does not parse.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

function walk(dir) {
  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.cjs') || e.name.endsWith('.js')) out.push(p)
  }
  return out
}

const files = [...walk(path.join(ROOT, 'electron')), ...walk(path.join(ROOT, 'scripts'))]
const bad = []

for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
  } catch (err) {
    const msg = String((err.stderr || err.stdout || err.message || '').toString())
    bad.push({ file: path.relative(ROOT, f), msg: msg.split('\n').slice(0, 5).join('\n') })
  }
}

if (bad.length) {
  console.log(`${bad.length} file(s) do not parse:\n`)
  for (const b of bad) console.log(`  ${b.file}\n${b.msg}\n`)
  process.exit(1)
}

console.log(`${files.length} CommonJS files parse`)
