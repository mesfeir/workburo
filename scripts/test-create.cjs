/**
 * Documents the app makes, checked by reading them back with the code that reads files.
 *
 * A writer that "succeeds" is worth nothing on its own — the file has to open in the program the
 * user will open it with. So every kind here is written and then read back: the csv through the
 * same reader the app uses, the xlsx through SheetJS, the docx through mammoth, and the pdf through
 * pdfjs, which is the reader that matters because a PDF whose text is not extractable is a picture
 * of a document.
 *
 * The other half is the rule that a name is only a name: nothing may be written outside the folder.
 */
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { create, safeName, resolveIn } = require('../electron/create.cjs')
const files = require('../electron/files.cjs')
const documents = require('../electron/documents.cjs')
const XLSX = require('xlsx')

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-create-'))

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`PASS  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}`)
    console.log(`        ${err.message}`)
  }
}

const readBack = async (p, name) => documents.readDocument(p, name)

;(async () => {
  await check('a csv lands where it was asked for, ready for a spreadsheet', async () => {
    const r = await create({ kind: 'csv', filename: 'budget.csv', content: 'item,qty\nwidget,3\n' }, { dir: DIR })
    assert.ok(r.ok, r.error)
    assert.strictEqual(r.file.name, 'budget.csv')
    assert.strictEqual(path.dirname(r.file.path), path.resolve(DIR))
    const body = fs.readFileSync(r.file.path, 'utf8')
    assert.ok(/widget,3/.test(body), body)
    assert.ok(body.includes('\r\n'), 'expected CRLF line endings')
    assert.ok(r.file.bytes > 0, 'a zero-byte file is not a file')
  })

  await check('and the app’s own reader reads it back', async () => {
    const got = await readBack(path.join(DIR, 'budget.csv'), 'budget.csv')
    assert.ok(got.ok, got.error || 'read refused')
    assert.ok(/widget,3/.test(got.text), got.text)
  })

  await check('an xlsx is a real workbook, with the numbers still numbers', async () => {
    const r = await create(
      { kind: 'xlsx', filename: 'stock.xlsx', content: 'item,qty\nwidget,3\ngadget,17\n' },
      { dir: DIR },
    )
    assert.ok(r.ok, r.error)
    const wb = XLSX.readFile(r.file.path)
    const sheet = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 })
    assert.deepStrictEqual(rows[0], ['item', 'qty'], JSON.stringify(rows))
    assert.deepStrictEqual(rows[2], ['gadget', 17], `expected a number, got ${JSON.stringify(rows[2])}`)
  })

  await check('text that is not a table still makes a workbook, rather than an error', async () => {
    const r = await create({ kind: 'xlsx', filename: 'notes.xlsx', content: 'first line\nsecond line' }, { dir: DIR })
    assert.ok(r.ok, r.error)
    const wb = XLSX.readFile(r.file.path)
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })
    const flat = rows.flat().join(' ')
    assert.ok(/first line/.test(flat) && /second line/.test(flat), JSON.stringify(rows))
  })

  await check('a docx reads back through mammoth, headings and all', async () => {
    const r = await create(
      { kind: 'docx', filename: 'plan.docx', title: 'The Plan', content: '# Step one\nDo this.\n- a bullet\n## Step two\nDo that.' },
      { dir: DIR },
    )
    assert.ok(r.ok, r.error)
    const got = await readBack(r.file.path, 'plan.docx')
    assert.ok(got.ok, got.error || 'read refused')
    assert.ok(/The Plan/.test(got.text), got.text)
    assert.ok(/Step one/.test(got.text) && /Step two/.test(got.text), got.text)
    assert.ok(/a bullet/.test(got.text), got.text)
  })

  await check('a pdf is written, and its text can genuinely be extracted', async () => {
    const r = await create(
      { kind: 'pdf', filename: 'letter.pdf', title: 'Dear reader', content: 'The number is 4729 and this is the body.' },
      { dir: DIR },
    )
    assert.ok(r.ok, r.error)
    const head = fs.readFileSync(r.file.path).subarray(0, 5).toString('latin1')
    assert.strictEqual(head, '%PDF-', `not a PDF: ${JSON.stringify(head)}`)
    const got = await readBack(r.file.path, 'letter.pdf')
    assert.ok(got.ok, got.error || 'the reader refused the pdf we just wrote')
    assert.ok(/4729/.test(got.text), `text not extractable: ${JSON.stringify(got.text.slice(0, 120))}`)
  })

  await check('markdown, text and json are saved as written', async () => {
    const md = await create({ kind: 'md', filename: 'readme.md', content: '# Title\nbody\n' }, { dir: DIR })
    assert.ok(md.ok, md.error)
    assert.ok(/^# Title/.test(fs.readFileSync(md.file.path, 'utf8')))
    const json = await create({ kind: 'json', filename: 'data.json', content: '{"b":1,"a":[2,3]}' }, { dir: DIR })
    assert.ok(json.ok, json.error)
    const parsed = JSON.parse(fs.readFileSync(json.file.path, 'utf8'))
    assert.deepStrictEqual(parsed, { b: 1, a: [2, 3] })
  })

  await check('json that does not parse is still saved, not thrown away', async () => {
    const r = await create({ kind: 'json', filename: 'rough.json', content: '{not json at all' }, { dir: DIR })
    assert.ok(r.ok, r.error)
    assert.strictEqual(fs.readFileSync(r.file.path, 'utf8').trim(), '{not json at all')
  })

  await check('a name with no extension gets the right one', async () => {
    const r = await create({ kind: 'csv', filename: 'report', content: 'a,b\n' }, { dir: DIR })
    assert.ok(r.ok, r.error)
    assert.strictEqual(r.file.name, 'report.csv')
  })

  await check('a wrong extension is corrected rather than lying about the contents', async () => {
    const r = await create({ kind: 'xlsx', filename: 'sheet.csv', content: 'a,b\n1,2\n' }, { dir: DIR })
    assert.ok(r.ok, r.error)
    assert.strictEqual(r.file.name, 'sheet.xlsx')
  })

  await check('no name at all still makes a usable file', async () => {
    const r = await create({ kind: 'txt', content: 'hello' }, { dir: DIR })
    assert.ok(r.ok, r.error)
    assert.strictEqual(r.file.name, 'untitled.txt')
  })

  await check('a name that is really a path is refused, not quietly moved', async () => {
    const escapes = ['../../evil.txt', '..\\..\\evil.txt', '/etc/passwd', 'C:\\Windows\\evil.txt', 'sub/dir/file.txt']
    for (const name of escapes) {
      const r = await create({ kind: 'txt', filename: name, content: 'x' }, { dir: DIR })
      assert.ok(!r.ok, `"${name}" was accepted — it must be refused`)
      assert.ok(/name, not a path/i.test(r.error), r.error)
    }
    const outside = fs.readdirSync(path.resolve(DIR, '..')).filter((f) => f === 'evil.txt')
    assert.strictEqual(outside.length, 0, 'something was written outside the folder')
  })

  await check('and a plain name never escapes the folder either', () => {
    const inside = resolveIn(DIR, 'plain.txt', 'txt')
    assert.ok(inside.ok, inside.error)
    assert.strictEqual(path.dirname(inside.abs), path.resolve(DIR))
    assert.strictEqual(safeName('   ', 'txt'), 'untitled.txt')
    assert.strictEqual(safeName('a:b*c?.txt', 'txt'), 'abc.txt')
  })

  await check('an unknown kind is refused and says what is possible', async () => {
    const r = await create({ kind: 'exe', filename: 'x.exe', content: 'MZ' }, { dir: DIR })
    assert.ok(!r.ok)
    assert.ok(/xlsx/.test(r.error) && /pdf/.test(r.error), r.error)
  })

  await check('with no folder chosen it refuses rather than guessing one', async () => {
    const r = await create({ kind: 'txt', filename: 'x.txt', content: 'x' }, {})
    assert.ok(!r.ok)
    assert.ok(/nowhere to save/i.test(r.error), r.error)
  })

  console.log(`\n${passed}/${passed + failed} checks passed`)
  process.exit(failed ? 1 : 0)
})()
