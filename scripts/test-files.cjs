/**
 * Reading attached files: pdf, Word, Excel, CSV, and anything plain text.
 *
 * The point of these checks is that a document arrives at the model as its *contents*, and that a
 * document which cannot be read says so in words a person can act on. A scanned PDF reported as
 * "empty" would look like the model ignoring the file, so that case is asserted by name.
 *
 * Run: npm run test:files
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const files = require('../electron/files.cjs')

const FIX = path.join(__dirname, 'fixtures')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-files-'))

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main() {
  // ---- what a filename claims to be -------------------------------------------------------------
  const kinds = {
    'a.pdf': 'pdf',
    'b.docx': 'docx',
    'c.doc': 'doc',
    'd.xlsx': 'sheet',
    'e.csv': 'sheet',
    'f.tsv': 'sheet',
    'g.txt': 'text',
    'h.md': 'text',
    'i.json': 'text',
    'j.py': 'text',
    'Dockerfile': 'text',
    'k.png': 'image',
    'l.png': 'image',
    'm.zip': 'unknown',
    'n.exe': 'unknown',
  }
  const wrong = Object.entries(kinds).filter(([n, want]) => files.kindFor(n) !== want)
  check(
    'a filename is routed to the right reader',
    wrong.length === 0,
    wrong.length ? `wrong: ${wrong.map(([n, w]) => `${n}→${files.kindFor(n)} (wanted ${w})`).join(', ')}` : `${Object.keys(kinds).length} extensions`,
  )

  check(
    'the file dialog offers documents, sheets and images, and can show everything',
    (() => {
      const g = files.acceptGroups()
      const names = g.map((x) => x.name)
      const docs = g.find((x) => x.name === 'Documents')
      const sheets = g.find((x) => x.name === 'Spreadsheets')
      return (
        names.includes('Documents') &&
        names.includes('Spreadsheets') &&
        names.includes('Images') &&
        names.at(-1) === 'All files' &&
        docs.extensions.includes('pdf') &&
        docs.extensions.includes('docx') &&
        sheets.extensions.includes('csv') &&
        sheets.extensions.includes('xlsx')
      )
    })(),
  )

  check(
    'the accepted list and the router agree',
    (() => {
      const accepted = new Set(files.acceptedExtensions())
      const mismatched = [...files.TEXT_EXT, ...files.SHEET_EXT, ...files.IMAGE_EXT]
        .map((e) => e.replace(/^\./, ''))
        .filter((e) => !accepted.has(e))
      return mismatched.length === 0
    })(),
  )

  // ---- plain text ------------------------------------------------------------------------------
  const md = await files.extract(path.join(FIX, 'notes.md'))
  check(
    'a markdown file arrives as its text',
    md.ok && md.text.includes('The quick brown fox, 4729'),
    JSON.stringify(String(md.text || '').slice(0, 40)),
  )

  // ---- csv: quoted fields, which is why it is not split on commas ------------------------------
  const csv = await files.extract(path.join(FIX, 'sample.csv'))
  check(
    'a csv keeps quoted commas inside their field',
    csv.ok && csv.text.includes('"has, a comma"') && !/\n\s*,\s*$/.test(csv.text),
    JSON.stringify(String(csv.text || '').split('\n')[1]),
  )

  // ---- Word ------------------------------------------------------------------------------------
  const docx = await files.extract(path.join(FIX, 'sample.docx'))
  check(
    'a Word document arrives as its paragraphs',
    docx.ok && /Hello from a DOCX 4729/.test(docx.text) && /Second paragraph\./.test(docx.text),
    JSON.stringify(String(docx.text || '').slice(0, 50)),
  )

  const oldDocPath = path.join(TMP, 'old.doc')
  fs.copyFileSync(path.join(FIX, 'sample.docx'), oldDocPath)
  const oldDoc = await files.extract(oldDocPath)
  check(
    'an old binary .doc is explained, not silently treated as a .docx',
    !oldDoc.ok && /save as \.docx/i.test(oldDoc.error),
    oldDoc.error,
  )

  // ---- PDF -------------------------------------------------------------------------------------
  const pdf = await files.extract(path.join(FIX, 'sample.pdf'))
  check(
    'a PDF arrives as its text, not as bytes',
    pdf.ok && /Hello from a PDF 4729/.test(pdf.text),
    pdf.ok ? `${pdf.pages} page(s), ${JSON.stringify(pdf.text.trim().slice(0, 30))}` : pdf.error,
  )

  const emptyPdf = await files.extract(path.join(FIX, 'empty.pdf'))
  check(
    'a PDF with no text layer says so — it is not reported as an empty file',
    !emptyPdf.ok && /no text layer|scan/i.test(emptyPdf.error),
    emptyPdf.error ? emptyPdf.error.slice(0, 90) : '(reported ok)',
  )

  // ---- Excel, written by the reader's own writer so the fixture stays honest --------------------
  const xlsxPath = path.join(TMP, 'book.xlsx')
  {
    const xlsx = require('xlsx')
    const wb = xlsx.utils.book_new()
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([['name', 'qty'], ['widget', 3]]), 'Stock')
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([['city'], ['Lisbon']]), 'Cities')
    xlsx.writeFile(wb, xlsxPath)
  }
  const book = await files.extract(xlsxPath)
  check(
    'a spreadsheet arrives as its cells, with both sheets named',
    book.ok &&
      /widget,3/.test(book.text) &&
      /### Stock/.test(book.text) &&
      /### Cities/.test(book.text) &&
      /Lisbon/.test(book.text),
    book.ok ? JSON.stringify(book.text.replace(/\n/g, '|').slice(0, 70)) : book.error,
  )

  // ---- refusals that have to stay honest --------------------------------------------------------
  const zip = path.join(TMP, 'thing.zip')
  fs.writeFileSync(zip, 'PK\x03\x04 not really')
  const unknown = await files.extract(zip)
  check(
    'an unsupported type names what does work instead',
    !unknown.ok && /not a file type this can read/.test(unknown.error) && /Excel and CSV/.test(unknown.error),
    unknown.error ? unknown.error.slice(0, 80) : '(reported ok)',
  )

  const gone = await files.extract(path.join(TMP, 'never-existed.pdf'))
  check(
    'a file that moved is explained',
    !gone.ok && /no longer where it was/.test(gone.error),
    gone.error,
  )

  const zero = path.join(TMP, 'nothing.txt')
  fs.writeFileSync(zero, '')
  const emptyFile = await files.extract(zero)
  check('an empty file is explained', !emptyFile.ok && /is empty/.test(emptyFile.error), emptyFile.error)

  // ---- the cap ---------------------------------------------------------------------------------
  const big = path.join(TMP, 'big.txt')
  fs.writeFileSync(big, 'x'.repeat(files.MAX_CHARS + 5000))
  const capped = await files.extract(big)
  check(
    'a very long document is cut, and says it was cut',
    capped.ok &&
      capped.truncated === true &&
      capped.text.length === files.MAX_CHARS &&
      /longer than one request can hold/.test(capped.note),
    capped.ok ? `kept ${capped.text.length} of ${files.MAX_CHARS + 5000}` : capped.error,
  )

  const shortEnough = await files.extract(path.join(FIX, 'notes.md'))
  check(
    'a document that fits is not marked as cut',
    shortEnough.ok && shortEnough.truncated === false && shortEnough.note === '',
    `truncated=${shortEnough.truncated}`,
  )

  console.log(`\n${pass}/${pass + fail} checks passed`)
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('the suite itself failed:', e)
  process.exit(1)
})
