/**
 * Reading the files people actually attach.
 *
 * Everything here runs in the main process, for the same reason the network calls do: the readers
 * are Node libraries, and the renderer should never see a path or a credential.
 *
 * Two rules this file exists to keep:
 *
 *  1. **Never silently degrade.** A document that cannot be read says so in plain words — a scanned
 *     PDF with no text layer is reported as exactly that rather than arriving at the model as an
 *     empty string, which would look like the model ignoring the file.
 *  2. **Never hand a model an unbounded amount of text.** Documents are capped, and the result says
 *     it was capped, so a 700-page report cannot quietly blow the context budget.
 *
 * Extensions are routed by what can genuinely read them:
 *
 *   text    — anything utf8 (code, config, markup, csv-free formats...)
 *   sheet   — SheetJS: xlsx, xlsm, xls, ods, and csv/tsv (real quoting, not split on commas)
 *   docx    — mammoth, which extracts the text and ignores the styling
 *   pdf     — pdf.js. The modern package is ESM-only (`legacy/build/pdf.mjs`, no CJS entry at all),
 *             so it is loaded with a dynamic import(), which a CommonJS main process may do. Its
 *             `exports` map is empty, so path resolution cannot block that.
 *   .doc    — the old binary Word format. Nothing here reads it; we say to save as .docx.
 */
const fs = require('fs')
const path = require('path')

/** How much text is reasonable to put in one request. Past this, the result says it was cut. */
const MAX_CHARS = 200000
/** A PDF beyond this is truncated by pages; the note says how many were read. */
const MAX_PDF_PAGES = 200
/** A PDF with *no* extractable text at all is a scan; anything else is just a short document. */
const MIN_PDF_TEXT = 1

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.mdx', '.log', '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml',
  '.ini', '.cfg', '.conf', '.env', '.properties', '.xml', '.html', '.htm', '.svg', '.css', '.scss',
  '.less', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.sql', '.r',
  '.swift', '.kt', '.lua', '.dart', '.vue', '.svelte', '.gradle', '.dockerfile', '.gitignore',
])
const SHEET_EXT = new Set(['.xlsx', '.xlsm', '.xls', '.xlsb', '.ods', '.csv', '.tsv'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.tif', '.tiff'])

/** What a filename is, as far as we can tell from its extension alone. */
function kindFor(name = '') {
  const base = String(name).toLowerCase()
  const ext = path.extname(base)
  if (IMAGE_EXT.has(ext)) return 'image'
  if (ext === '.pdf') return 'pdf'
  if (ext === '.docx') return 'docx'
  if (ext === '.doc') return 'doc' // old binary Word — recognised so we can explain, not read
  if (SHEET_EXT.has(ext)) return 'sheet'
  if (TEXT_EXT.has(ext)) return 'text'
  // extension-less files that are usually text
  if (/^(dockerfile|makefile|license|readme|changelog)$/i.test(path.basename(base))) return 'text'
  return 'unknown'
}

/** The groups the file dialog shows. Kept here so the picker and the drop handler cannot drift. */
function acceptGroups() {
  const docs = ['pdf', 'docx', 'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'xml', 'html', 'log']
  const sheets = ['xlsx', 'xlsm', 'xls', 'ods', 'csv', 'tsv']
  const images = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']
  return [
    { name: 'Documents', extensions: docs },
    { name: 'Spreadsheets', extensions: sheets },
    { name: 'Images', extensions: images },
    { name: 'Text and code', extensions: [...TEXT_EXT].map((e) => e.replace(/^\./, '')) },
    { name: 'All files', extensions: ['*'] },
  ]
}

/** Every extension we admit, for quick membership tests in the renderer and the drop path. */
function acceptedExtensions() {
  return [...new Set([...TEXT_EXT, ...SHEET_EXT, ...IMAGE_EXT, '.pdf', '.docx', '.doc'])]
    .map((e) => e.replace(/^\./, ''))
    .sort()
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Cut text to the cap, saying so rather than pretending the document ended there. */
function cap(text, what, extra = {}) {
  const all = String(text || '')
  if (all.length <= MAX_CHARS) return { text: all, truncated: false, note: '', ...extra }
  return {
    text: all.slice(0, MAX_CHARS),
    truncated: true,
    note: `${what} is longer than one request can hold — the first ${MAX_CHARS.toLocaleString()} characters of ${all.length.toLocaleString()} were sent.`,
    ...extra,
  }
}

let pdfjsPromise = null
/**
 * pdf.js, loaded once. Its package ships only ESM, so `require` cannot see it — but a CommonJS
 * process may `await import()` an ESM file, which is how this works at all.
 *
 * Inside a packaged app the module lives in the asar archive, and the ESM loader does not read asar.
 * main.cjs unpacks this package (see build.asarUnpack), so the path is rewritten to the unpacked
 * copy on disk before importing, which is the documented way around it.
 */
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const entry = require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
      const onDisk = entry.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
      const url = 'file:///' + onDisk.replace(/\\/g, '/').replace(/^\//, '')
      return import(url)
    })().catch((e) => {
      pdfjsPromise = null // let a later attempt retry rather than caching the failure
      throw e
    })
  }
  return pdfjsPromise
}

async function readPdf(abs, size) {
  const pdfjs = await loadPdfjs()
  const data = new Uint8Array(fs.readFileSync(abs))
  // No worker and no rendering: this only walks the text layer, so none of pdf.js's rendering
  // machinery is needed. `verbosity: 0` keeps its advisory messages out of the app's logs — they
  // concern glyphs and canvases, which this never touches. (Pointing `standardFontDataUrl` at the
  // package's own standard_fonts directory was tried and removed: pdf.js asks for a
  // LiberationSans-Regular.ttf that the published package does not contain — the folder ships .pfb
  // files only — so it replaced a harmless advisory with a missing-file error.)
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise
  const pages = Math.min(doc.numPages, MAX_PDF_PAGES)
  const parts = []
  let chars = 0
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    let line = ''
    for (const item of content.items) {
      line += item.str
      if (item.hasEOL) line += '\n'
    }
    const chunk = line.trim()
    if (chunk) parts.push(chunk)
    chars += chunk.length
    if (chars > MAX_CHARS) break // the cap below trims to the exact figure
  }
  const joined = parts.join('\n\n')
  if (joined.replace(/\s/g, '').length < MIN_PDF_TEXT) {
    return {
      ok: false,
      kind: 'pdf',
      error:
        'This PDF has no text layer, so there is nothing to read — it is almost certainly a scan or a picture of a page. Ask for the text, or try a PDF that was exported rather than scanned.',
    }
  }
  const cut = cap(joined, 'This PDF')
  return {
    ok: true,
    kind: 'pdf',
    text: cut.text,
    pages: doc.numPages,
    readPages: pages,
    truncated: cut.truncated || pages < doc.numPages,
    note: cut.note || (pages < doc.numPages ? `Only the first ${pages} of ${doc.numPages} pages were read.` : ''),
    size,
  }
}

function readSheet(abs, name, size) {
  const xlsx = require('xlsx')
  const wb = xlsx.readFile(abs, { cellDates: true, raw: false })
  const chunks = []
  for (const sheetName of wb.SheetNames) {
    const csv = xlsx.utils.sheet_to_csv(wb.Sheets[sheetName], { blankrows: false })
    if (!csv.trim()) continue
    chunks.push(wb.SheetNames.length > 1 ? `### ${sheetName}\n${csv.trim()}` : csv.trim())
  }
  if (!chunks.length) {
    return { ok: false, kind: 'sheet', error: 'This spreadsheet has no filled cells to read.' }
  }
  const cut = cap(chunks.join('\n\n'), 'This spreadsheet')
  return {
    ok: true,
    kind: 'sheet',
    text: cut.text,
    sheets: wb.SheetNames,
    truncated: cut.truncated,
    note: cut.note,
    size,
  }
}

async function readDocx(abs, size) {
  const mammoth = require('mammoth')
  const r = await mammoth.extractRawText({ path: abs })
  const text = String(r.value || '').trim()
  if (!text) {
    return { ok: false, kind: 'docx', error: 'This document has no text in it — it may be empty or images only.' }
  }
  const cut = cap(text, 'This document')
  return { ok: true, kind: 'docx', text: cut.text, truncated: cut.truncated, note: cut.note, size }
}

/**
 * Read one file. Never throws: a failure is a result, because the caller has to put *something* in
 * front of the user either way, and "why it did not work" is the useful part.
 */
async function extract(abs, displayName) {
  const name = displayName || path.basename(String(abs))
  const kind = kindFor(name)
  let size = 0
  try {
    size = fs.statSync(abs).size
  } catch {
    return { ok: false, kind, error: `${name} is no longer where it was — it may have been moved or deleted.` }
  }
  if (size === 0) return { ok: false, kind, error: `${name} is empty.` }

  try {
    if (kind === 'text') {
      const raw = fs.readFileSync(abs, 'utf8')
      const cut = cap(raw, name)
      return { ok: true, kind, text: cut.text, truncated: cut.truncated, note: cut.note, size }
    }
    if (kind === 'pdf') return await readPdf(abs, size)
    if (kind === 'sheet') return readSheet(abs, name, size)
    if (kind === 'docx') return await readDocx(abs, size)
    if (kind === 'doc') {
      return {
        ok: false,
        kind,
        error:
          'That is the old Word format (.doc), which nothing here can read. Open it in Word and save as .docx, then attach that.',
      }
    }
    if (kind === 'image') return { ok: false, kind, error: 'images are attached, not extracted' }
    return {
      ok: false,
      kind,
      error: `${path.extname(name) || name} is not a file type this can read yet. Text, PDF, Word (.docx), Excel and CSV all work.`,
    }
  } catch (e) {
    const msg = String((e && e.message) || e)
    const friendly =
      /password|encrypted/i.test(msg)
        ? 'This file is password-protected, so it cannot be read.'
        : /corrupt|invalid|Unexpected end/i.test(msg)
          ? 'This file looks damaged or incomplete.'
          : `Could not read this file: ${msg.slice(0, 200)}`
    return { ok: false, kind, error: friendly }
  }
}

module.exports = {
  kindFor,
  extract,
  acceptGroups,
  acceptedExtensions,
  humanSize,
  MAX_CHARS,
  MAX_PDF_PAGES,
  TEXT_EXT,
  SHEET_EXT,
  IMAGE_EXT,
}
