/**
 * Ship-gate: does the file-reading layer work in the *packaged* app?
 *
 * The dev suite (npm run test:files) proves the readers work. Two things are only true once
 * packaged, and both have broken before:
 *
 *   - `require` must reach electron/files.cjs from inside app.asar. build.files did not list
 *     node_modules, so every reader was present in dev and absent from the built app.
 *   - pdfjs is ESM-only, and an ESM import cannot read from inside an asar. It works only because
 *     files.cjs rewrites the path to app.asar.unpacked, which asarUnpack has to have created.
 *
 * Run:  npm run check:packaged
 * Or point it at an install:  node scripts/check-packaged-files.cjs "C:/…/Programs/Zen Chat/Zen Chat.exe"
 *
 * It launches the packaged binary as plain Node (ELECTRON_RUN_AS_NODE), so no window appears and
 * nothing is written anywhere.
 */
const path = require('path')
const { spawnSync } = require('child_process')

const DEFAULT_EXE = path.join(__dirname, '..', 'release', 'win-unpacked', 'Zen Chat.exe')
const FIX = path.join(__dirname, 'fixtures')

/** The half that runs inside the packaged app. */
async function runInner() {
  const files = require(path.join(process.resourcesPath, 'app.asar', 'electron', 'files.cjs'))
  console.log(`inside the packaged app: electron ${process.versions.electron}, node ${process.versions.node}`)

  const expect = [
    { name: 'sample.pdf', want: /Hello from a PDF 4729/ },
    { name: 'sample.docx', want: /Hello from a DOCX 4729/ },
    { name: 'sample.csv', want: /"has, a comma"/ },
    { name: 'notes.md', want: /quick brown fox/ },
    { name: 'empty.pdf', refuse: /no text layer|scan/i },
  ]

  let bad = 0
  for (const c of expect) {
    let r
    try {
      r = await files.extract(path.join(FIX, c.name))
    } catch (e) {
      console.log(`FAIL  ${c.name} — threw: ${String(e && e.message).slice(0, 80)}`)
      bad++
      continue
    }
    if (c.refuse) {
      const ok = r.ok === false && c.refuse.test(r.error)
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name} is refused with a usable reason — ${String(r.error).slice(0, 60)}`)
      if (!ok) bad++
    } else {
      const ok = r.ok === true && c.want.test(String(r.text || ''))
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name} reads as its text — ${JSON.stringify(String(r.text || '').slice(0, 40))}`)
      if (!ok) bad++
    }
  }
  console.log(bad ? `\n${bad} check(s) failed` : `\n${expect.length}/${expect.length} checks passed`)
  process.exit(bad ? 1 : 0)
}

if (process.versions.electron) {
  runInner().catch((e) => {
    console.error('the packaged probe itself failed:', e)
    process.exit(1)
  })
} else {
  const exe = process.argv[2] || DEFAULT_EXE
  const r = spawnSync(exe, [__filename], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  })
  process.stdout.write(r.stdout || '')
  process.stderr.write(r.stderr || '')
  if (r.error) {
    console.error(
      `could not launch ${exe}: ${r.error.message}\nBuild one first with npm run dist:dir, or pass the path to an installed Zen Chat.exe.`,
    )
    process.exit(1)
  }
  process.exit(r.status === null ? 1 : r.status)
}
