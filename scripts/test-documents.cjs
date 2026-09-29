/**
 * Attached documents have to reach the model as text.
 *
 * The trap this guards against is a feature that looks finished and is not: a chip appears, the
 * message is sent, and the document's contents were never in the request at all. So these checks
 * follow the whole way — classify → read → hydrate → the actual messages that go to the endpoint.
 *
 * Offline: fixtures on disk, no network, no key.
 */
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const documents = require('../electron/documents.cjs')
const { toChatMessages } = require('../electron/messages.cjs')

const FIX = path.join(__dirname, 'fixtures')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-docs-'))

let passed = 0
let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
    passed += 1
  } catch (err) {
    console.log(`FAIL  ${name}\n        ${err.message}`)
    failed += 1
  }
}

;(async () => {
  /* ------------------------------------------------------------------ which files */

  await check('a PDF is a document, a photo is not', () => {
    assert.strictEqual(documents.classify('report.pdf'), 'document')
    assert.strictEqual(documents.classify('Book.xlsx'), 'document')
    assert.strictEqual(documents.classify('notes.md'), 'document')
    assert.strictEqual(documents.classify('shot.png'), 'image')
  })

  await check('the picker offers documents and spreadsheets, not just pictures', () => {
    const groups = documents.acceptGroups().map((g) => g.name)
    for (const need of ['Documents', 'Spreadsheets', 'Images']) {
      assert.ok(groups.includes(need), `the picker has no "${need}" group: ${groups.join(', ')}`)
    }
    const exts = documents.acceptedExtensions()
    for (const need of ['pdf', 'docx', 'xlsx', 'csv']) {
      assert.ok(exts.includes(need), `.${need} is not accepted: ${exts.join(', ')}`)
    }
  })

  /* ------------------------------------------------------------------ reading them */

  const pdf = await documents.readDocument(path.join(FIX, 'sample.pdf'), 'sample.pdf')
  await check('a PDF comes back as the text inside it', () => {
    assert.ok(pdf.ok, pdf.error)
    assert.match(pdf.text, /Hello from a PDF/, `got "${pdf.text.slice(0, 60)}"`)
  })

  const docx = await documents.readDocument(path.join(FIX, 'sample.docx'), 'sample.docx')
  await check('a Word file comes back as its text', () => {
    assert.ok(docx.ok, docx.error)
    assert.ok(docx.text.trim().length > 0, 'a docx read as nothing')
  })

  const csvPath = path.join(FIX, 'sample.csv')
  const csv = await documents.readDocument(csvPath, 'sample.csv')
  await check('a CSV comes back with its cells', () => {
    assert.ok(csv.ok, csv.error)
    assert.match(csv.text, /widget/)
  })

  // The user named xlsx specifically, and the fixture set had none — so build one here rather than
  // let the one format they asked for go untested.
  const xlsxPath = path.join(tmp, 'budget.xlsx')
  try {
    const XLSX = require('xlsx')
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['item', 'cost'],
        ['turntable', 2400],
        ['speaker', 875],
      ]),
      'Budget',
    )
    XLSX.writeFile(wb, xlsxPath)
  } catch (err) {
    console.log(`      (could not build the xlsx fixture: ${err.message})`)
  }
  const xlsx = await documents.readDocument(xlsxPath, 'budget.xlsx')
  await check('a spreadsheet comes back with its rows and numbers', () => {
    assert.ok(xlsx.ok, xlsx.error)
    assert.match(xlsx.text, /turntable/)
    assert.match(xlsx.text, /2400/)
  })

  const gone = await documents.readDocument(path.join(FIX, 'not-here.pdf'), 'not-here.pdf')
  await check('a file that is not there is refused with a reason, not an exception', () => {
    assert.strictEqual(gone.ok, false)
    assert.ok(gone.error && gone.error.length > 10, `said: ${gone.error}`)
  })

  const oldDoc = path.join(tmp, 'legacy.doc')
  fs.writeFileSync(oldDoc, 'not really a doc')
  const doc = await documents.readDocument(oldDoc, 'legacy.doc')
  await check('the old .doc format is explained, not silently mangled', () => {
    assert.strictEqual(doc.ok, false)
    assert.match(doc.error, /docx/i, `should point at .docx, said: ${doc.error}`)
  })

  /* ------------------------------------------------------- what the model receives */

  const msgs = [
    {
      role: 'user',
      content: 'summarise the attached file',
      documents: [{ name: 'sample.pdf', path: path.join(FIX, 'sample.pdf') }],
    },
  ]
  await documents.hydrate(msgs)

  await check('the model is told, by name, that a document is attached', () => {
    const note = documents.note(msgs)
    assert.match(note, /sample\.pdf/, `note said: ${note}`)
  })

  const wire = toChatMessages(msgs, 'you are helpful')
  const userTurn = wire.find((m) => m.role === 'user')
  await check('the document text is really in the request', () => {
    assert.ok(userTurn, 'no user turn was built')
    assert.match(String(userTurn.content), /Hello from a PDF/, `turn was: ${String(userTurn.content).slice(0, 120)}`)
  })

  await check('and the user’s own words still come first', () => {
    const text = String(userTurn.content)
    assert.ok(
      text.indexOf('summarise the attached file') < text.indexOf('Hello from a PDF'),
      'the document was put before the instruction',
    )
  })

  await check('a failing document still reaches the model as a reason, never as a blank', () => {
    const bad = [
      {
        role: 'user',
        content: 'what does this say',
        documents: [{ name: 'gone.pdf', path: path.join(FIX, 'not-here.pdf') }],
      },
    ]
    return documents.hydrate(bad).then(() => {
      const turn = toChatMessages(bad, '').find((m) => m.role === 'user')
      assert.match(String(turn.content), /could not be read/i, `turn was: ${String(turn.content).slice(0, 120)}`)
    })
  })

  await check('a document keeps its place and its text on later turns', () => {
    const later = [
      { role: 'user', content: 'summarise the attached file', documents: [{ name: 'sample.pdf', path: path.join(FIX, 'sample.pdf') }] },
      { role: 'assistant', content: 'It says hello.' },
      { role: 'user', content: 'and again, in French' },
    ]
    return documents.hydrate(later).then(() => {
      const turns = toChatMessages(later, '')
      const first = turns.find((m) => m.role === 'user')
      assert.match(String(first.content), /Hello from a PDF/, 'the attachment was lost on a later turn')
    })
  })

  /* ------------------------------------------------------------------ the size cap */

  await check('a document too long for one request says so instead of being cut in silence', async () => {
    const big = path.join(tmp, 'big.txt')
    fs.writeFileSync(big, 'x'.repeat(documents.MAX_CHARS + 5000))
    const r = await documents.readDocument(big, 'big.txt')
    assert.ok(r.ok, r.error)
    assert.strictEqual(r.truncated, true, 'a capped document was not marked truncated')
    assert.match(String(r.note), /characters were sent|longer than/i, `note said: ${r.note}`)
  })

  console.log(`\n${passed}/${passed + failed} checks passed`)
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* a temp dir left behind is not worth failing over */
  }
  process.exit(failed ? 1 : 0)
})()
