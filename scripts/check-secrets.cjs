#!/usr/bin/env node
// Guards the repo against committing credentials.
//
//   node scripts/check-secrets.cjs                 scan the working tree
//   node scripts/check-secrets.cjs --install-hook   install as .git/hooks/pre-commit
//   node scripts/check-secrets.cjs --staged         scan only what is staged
//
// Exits 1 if anything key-shaped is found. Values are never printed in full.

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'release', '.vite', '.probe', 'build'])
const TEXT_EXT = new Set([
  '.cjs', '.mjs', '.js', '.ts', '.tsx', '.jsx', '.json', '.md', '.html', '.css',
  '.yml', '.yaml', '.toml', '.txt', '.log', '.sh', '.ps1', '.env',
])

const PATTERNS = [
  ['opencode key', /oc_sk_[A-Za-z0-9_-]{8,}/],
  ['api key (sk-)', /sk-[A-Za-z0-9_-]{16,}/],
  ['github token', /github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}/],
  ['fal key', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{16,}/],
  ['aws key id', /AKIA[0-9A-Z]{16}/],
  ['bearer literal', /[Bb]earer\s+[A-Za-z0-9._-]{20,}/],
  // a real assignment, as opposed to a name, a placeholder, or an empty default
  ['assigned secret', /(?:api[_-]?key|apikey|token|secret|password)\s*[:=]\s*['"]([^'"\n]{12,})['"]/i],
]

const PLACEHOLDER = /^(?:|…+|\.+|\*+|[x·•\s-]+|your[-_ ].*|<.*|\.{3}.*|sk-….*|oc_sk_….*|.*(?:placeholder|example|demo|dummy|xxxx).*)$/i

function shouldScan(file) {
  return TEXT_EXT.has(path.extname(file).toLowerCase())
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
    } else if (shouldScan(entry.name)) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

function scanLines(file, lines, findings, label) {
  lines.forEach((line, i) => {
    for (const [name, rx] of PATTERNS) {
      const m = rx.exec(line)
      if (!m) continue
      const value = m[1] !== undefined ? m[1] : m[0]
      if (PLACEHOLDER.test(value)) continue
      const masked = value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-2)}` : '(short)'
      findings.push({ label, file, line: i + 1, name, len: value.length, masked })
      break
    }
  })
}

const args = process.argv.slice(2)
const findings = []
const skipSelf = (p) => p.endsWith(path.join('scripts', 'check-secrets.cjs'))

if (args.includes('--install-hook')) {
  const hookDir = path.join(ROOT, '.git', 'hooks')
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    console.error('not a git repository — run git init first')
    process.exit(1)
  }
  fs.mkdirSync(hookDir, { recursive: true })
  const hook = path.join(hookDir, 'pre-commit')
  fs.writeFileSync(hook, '#!/bin/sh\nnode scripts/check-secrets.cjs --staged\n', 'utf8')
  fs.chmodSync(hook, 0o755)
  console.log(`installed pre-commit hook: ${hook}`)
  process.exit(0)
}

if (args.includes('--staged')) {
  const files = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    cwd: ROOT, encoding: 'utf8',
  })
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => shouldScan(f) && !skipSelf(f) && !f.startsWith('node_modules/'))
  for (const rel of files) {
    const abs = path.join(ROOT, rel)
    if (!fs.existsSync(abs)) continue
    scanLines(abs, fs.readFileSync(abs, 'utf8').split('\n'), findings, rel)
  }
  console.log(`staged files scanned: ${files.length}`)
} else {
  const files = walk(ROOT).filter((f) => !skipSelf(f))
  for (const abs of files) {
    scanLines(abs, fs.readFileSync(abs, 'utf8').split('\n'), findings, path.relative(ROOT, abs))
  }
  console.log(`files scanned: ${files.length}`)
}

if (findings.length) {
  console.error(`\nFOUND ${findings.length} possible secret(s):\n`)
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.name}]  len=${f.len}  ${f.masked}`)
  }
  console.error('\nRemove the value (move it to %APPDATA%\\zen-chat\\ or an env var) and retry.')
  process.exit(1)
}

console.log('no key-shaped literals found')
