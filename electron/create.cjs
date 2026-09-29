/**
 * Making documents, not just reading them.
 *
 * The reading side (files.cjs / documents.cjs) answers "what does this file say"; this answers
 * "give me the file". The model writes text — CSV, markdown, plain lines — and each kind is turned
 * into a real file the user can open:
 *
 *   · xlsx  — SheetJS, which is already here for reading, reads the text as a table and writes a
 *             real workbook. Text that is not comma-separated still lands as one value per row
 *             rather than an error, because a spreadsheet with the lines in column A is still what
 *             the user asked for.
 *   · docx  — the `docx` package; `#`/`##` lines become real headings, everything else a paragraph.
 *   · pdf   — pdfkit, with a title if one was given.
 *   · csv/md/txt/json — written as they are (CSV normalised to CRLF, which is what spreadsheets
 *             expect on Windows).
 *
 * The one safety rule that matters: the model chooses a *name*, never a place. Every path is joined
 * to the output folder and then checked to be inside it, so a name like `../../.ssh/authorized_keys`
 * cannot escape. Everything is written into a folder the user owns, and the app tells them where.
 */
const fs = require('node:fs')
const path = require('node:path')

/** What can be made, and the extension that goes with it. */
const KINDS = {
  xlsx: '.xlsx',
  csv: '.csv',
  docx: '.docx',
  pdf: '.pdf',
  md: '.md',
  txt: '.txt',
  json: '.json',
}

const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  csv: 'text/csv',
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
}

/** Characters Windows refuses in a filename. */
function safeName(raw, kind) {
  let name = String(raw || '')
    .trim()
    .replace(/[<>:"|?*\u0000-\u001f]/g, '')
    .trim()
  const ext = KINDS[kind]
  if (!name) name = `untitled${ext}`
  // an extension the user typed that does not match the kind would be a lie about the contents
  const hasExt = /\.[a-z0-9]{1,5}$/i.test(name)
  if (hasExt) {
    const given = path.extname(name)
    if (given.toLowerCase() !== ext) name = name.slice(0, -given.length)
  }
  if (!name.toLowerCase().endsWith(ext)) name += ext
  // keep it usable on every filesystem
  if (name.length > 120) name = name.slice(0, 120 - ext.length) + ext
  return name
}

/**
 * The absolute path for a name, guaranteed to sit directly inside `dir`.
 *
 * A name that contains a path — `..\\..\\evil.txt`, `/etc/passwd`, `C:\\Windows\\x` — is refused
 * outright rather than quietly turned into something else: a caller that asked for a path should be
 * told it cannot have one, not handed a file somewhere unexpected. The model picks a name; the app
 * picks the folder.
 */
function resolveIn(dir, rawName, kind) {
  const raw = String(rawName || '').trim()
  if (/[\\/]/.test(raw) || raw.includes('..')) {
    return {
      ok: false,
      error: 'A file name, not a path — the file is saved in the app’s own folder. Try something like "report.xlsx".',
    }
  }
  const base = path.resolve(dir)
  const name = safeName(raw, kind)
  const abs = path.join(base, name)
  if (path.dirname(abs) !== base) {
    return { ok: false, error: 'That file name is not allowed — it has to be a plain name, not a path.' }
  }
  return { ok: true, abs, name }
}

function writeCsv(abs, text) {
  const body = String(text == null ? '' : text).replace(/\r?\n/g, '\r\n')
  fs.writeFileSync(abs, body.endsWith('\r\n') ? body : `${body}\r\n`, 'utf8')
}

function writeXlsx(abs, text) {
  const XLSX = require('xlsx')
  const body = String(text == null ? '' : text)
  // SheetJS reads the text as a table when it is CSV/TSV, and as one value per line otherwise.
  const wb = XLSX.read(body, { type: 'string', raw: false })
  XLSX.writeFile(wb, abs)
}

async function writeDocx(abs, text, title) {
  const { Document, Packer, Paragraph, HeadingLevel } = require('docx')
  const children = []
  if (title) children.push(new Paragraph({ text: String(title), heading: HeadingLevel.HEADING_1 }))
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1].length === 1 ? HeadingLevel.HEADING_1 : h[1].length === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3
      children.push(new Paragraph({ text: h[2], heading: level }))
    } else if (/^[-*]\s+/.test(line)) {
      children.push(new Paragraph({ text: line.replace(/^[-*]\s+/, ''), bullet: { level: 0 } }))
    } else {
      children.push(new Paragraph({ text: line }))
    }
  }
  const doc = new Document({ sections: [{ children: children.length ? children : [new Paragraph({ text: '' })] }] })
  fs.writeFileSync(abs, await Packer.toBuffer(doc))
}

function writePdf(abs, text, title) {
  const PDFDocument = require('pdfkit')
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 56, size: 'A4' })
      const out = fs.createWriteStream(abs)
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      out.on('finish', done)
      out.on('error', (err) => {
        if (settled) return
        settled = true
        reject(err)
      })
      doc.pipe(out)
      if (title) {
        doc.fontSize(20).text(String(title))
        doc.moveDown()
      }
      doc.fontSize(11).text(String(text == null ? '' : text))
      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * Make a document.
 *
 * @param {{kind:string, filename?:string, title?:string, content?:string}} args
 * @param {{dir:string}} opts where the file goes — chosen by the app, never by the model
 */
async function create(args = {}, opts = {}) {
  const kind = String(args.kind || '').trim().toLowerCase()
  const list = Object.keys(KINDS).join(', ')
  if (!KINDS[kind]) {
    return { ok: false, error: `I can make ${list} — "${args.kind || ''}" is not one of them.` }
  }
  const dir = opts.dir
  if (!dir) return { ok: false, error: 'There is nowhere to save it — the app did not say which folder to use.' }

  const where = resolveIn(dir, args.filename, kind)
  if (!where.ok) return { ok: false, error: where.error }

  const content = args.content == null ? '' : String(args.content)
  const title = args.title ? String(args.title) : ''

  try {
    fs.mkdirSync(path.resolve(dir), { recursive: true })
  } catch (err) {
    return { ok: false, error: `Could not make the folder ${dir}: ${err.message}` }
  }

  try {
    if (kind === 'csv') writeCsv(where.abs, content)
    else if (kind === 'xlsx') writeXlsx(where.abs, content)
    else if (kind === 'docx') await writeDocx(where.abs, content, title)
    else if (kind === 'pdf') await writePdf(where.abs, content, title)
    else if (kind === 'json') {
      // if it parses, store it tidily; if it does not, save exactly what was asked for rather than
      // refusing — the user may well want the text they wrote
      let body = content
      try {
        body = JSON.stringify(JSON.parse(content), null, 2)
      } catch {
        /* keep it as written */
      }
      fs.writeFileSync(where.abs, `${body}\n`, 'utf8')
    } else fs.writeFileSync(where.abs, content, 'utf8')
  } catch (err) {
    return { ok: false, error: `Could not write ${where.name}: ${err.message}` }
  }

  let bytes = 0
  try {
    bytes = fs.statSync(where.abs).size
  } catch {
    /* reported as 0 below */
  }
  return {
    ok: true,
    file: { path: where.abs, name: where.name, kind, bytes, mime: MIME[kind] },
    text: `Saved ${where.name} (${bytes} bytes) in ${path.resolve(dir)}.`,
  }
}

module.exports = { create, safeName, resolveIn, KINDS, MIME }
