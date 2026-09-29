/**
 * Documents people attach, read into the conversation.
 *
 * A picture can be sent to a vision model as pixels. A PDF, a spreadsheet or a Word file cannot —
 * the model needs the *text* inside it, and there is no endpoint here that accepts a file. So a
 * document is read in main, where the readers live (pdf.js, mammoth, SheetJS), and travels as text
 * on the turn it was attached to. The renderer only ever holds a preview.
 *
 * Why this is its own module rather than tucked into main.cjs: the rules are the interesting part —
 * what counts as a document, what the model is told about it, how much of it fits in a request, and
 * what is said when it does not — and those have to be testable without a window. See
 * scripts/test-documents.cjs.
 *
 * Attachments on a message look like:
 *   { name: 'report.pdf', path: 'C:\\…\\report.pdf', kind: 'document', bytes: 918273 }
 * and, once hydrated:
 *   m.docText = [{ name, docKind: 'pdf', ok: true, text, chars, truncated, note }]
 */
const fs = require('node:fs')
const path = require('node:path')

const files = require('./files.cjs')

/** How much of one turn's documents may travel. Bigger than one file's cap, because a turn can
 *  carry several — and still small enough that the request stays sane. */
const TURN_MAX = 300000

/**
 * Read one document, remembering the result.
 *
 * The same file is read again on every turn it is part of (a conversation with an attached
 * spreadsheet re-sends its text each time), and a 200-page PDF is not cheap to parse. The key
 * includes the file's size and modification time, so editing the file and re-sending picks up the
 * new text rather than the cached old text.
 */
const cache = new Map()

function statKey(abs) {
  try {
    const s = fs.statSync(abs)
    return `${abs}|${s.size}|${s.mtimeMs}`
  } catch {
    return `${abs}|missing`
  }
}

/**
 * The file's text, or an honest reason there is none. Never throws: a document that cannot be read
 * comes back as `ok: false` with something the user can act on.
 */
async function readDocument(abs, displayName) {
  const name = displayName || path.basename(String(abs || ''))
  if (!abs) return { ok: false, name, error: `${name} has no path on disk, so it cannot be read.` }

  const key = statKey(abs)
  if (cache.has(key)) return cache.get(key)

  let result
  try {
    const r = await files.extract(abs, name)
    result = r.ok
      ? {
          ok: true,
          name,
          docKind: r.kind || files.kindFor(name),
          text: String(r.text || ''),
          chars: String(r.text || '').length,
          truncated: !!r.truncated,
          note: r.note || '',
          bytes: r.size || 0,
        }
      : { ok: false, name, docKind: r.kind || files.kindFor(name), error: r.error || `${name} could not be read.` }
  } catch (err) {
    result = { ok: false, name, docKind: files.kindFor(name), error: (err && err.message) || `${name} could not be read.` }
  }
  cache.set(key, result)
  return result
}

function forget(abs) {
  for (const key of [...cache.keys()]) if (key.startsWith(`${abs}|`)) cache.delete(key)
}

/**
 * Fill in `docText` for every message that carries documents. main runs this before building a
 * request, because the request builder itself is synchronous and reading a file is not.
 */
async function hydrate(messages) {
  for (const m of messages || []) {
    const docs = Array.isArray(m.documents) ? m.documents.filter(Boolean) : []
    if (!docs.length) continue
    const out = []
    let budget = TURN_MAX
    for (const d of docs) {
      const read = await readDocument(d.path, d.name)
      if (!read.ok) {
        out.push({ ...read, attachedName: d.name || read.name })
        continue
      }
      // what fits, and the truth about what did not
      const text = budget > 0 ? read.text.slice(0, budget) : ''
      budget -= text.length
      out.push({
        ...read,
        attachedName: d.name || read.name,
        text,
        truncated: read.truncated || text.length < read.text.length,
        note:
          text.length < read.text.length
            ? `${read.name} is longer than this turn can carry — the first ${text.length.toLocaleString()} of ${read.chars.toLocaleString()} characters were sent.`
            : read.note,
      })
    }
    m.docText = out
    // the finished block, so the (synchronous) message builder never has to read a file
    m.docBlock = blocksFor(m)
  }
  return messages
}

/**
 * The text of the documents on one message, as it goes into the request. Read from `docText`, so
 * this stays synchronous and pure — which is what the message builder needs.
 */
function blocksFor(m) {
  const docs = (m && m.docText) || []
  const parts = []
  for (const d of docs) {
    if (!d.ok) {
      parts.push(
        `[The user attached ${d.attachedName || d.name}, which could not be read: ${d.error}]`,
      )
      continue
    }
    if (!d.text) continue
    parts.push(
      `--- ${d.docKind} attached by the user: ${d.attachedName || d.name}` +
        `${d.truncated ? ` (truncated — ${d.note || 'only part of it was sent'})` : ''} ---\n${d.text}\n--- end of ${d.attachedName || d.name} ---`,
    )
  }
  return parts.join('\n\n')
}

/** Every document named anywhere in the conversation, oldest first. */
function attachedIn(messages) {
  const out = []
  for (const m of messages || []) {
    for (const d of m.documents || []) if (d && d.name) out.push(d)
  }
  return out
}

/**
 * What documents exist in this conversation, said out loud to the model.
 *
 * Same job as pictureNote: without it, "summarise the report" reads as a request about nothing, or
 * worse, gets answered from imagination. With it, the model knows a document is there and that the
 * text it was given belongs to it.
 */
function note(messages) {
  const docs = attachedIn(messages)
  if (!docs.length) return ''
  const list = docs
    .map((d, i) => {
      const bits = [d.kind === 'image' ? 'picture' : 'document']
      if (d.chars) bits.push(`${d.chars.toLocaleString()} characters`)
      if (d.truncated) bits.push('only partly sent')
      if (d.error) bits.push('could not be read')
      return `${i + 1}. ${d.name} (${bits.join(', ')})`
    })
    .join('; ')
  return (
    `The user attached ${docs.length === 1 ? 'a file' : `${docs.length} files`} in this conversation: ${list}. ` +
    'The text of each is included with the message it was attached to. Work from that text — quote it, ' +
    'summarise it, calculate from it — and when the answer is not in it, say so plainly instead of ' +
    'guessing or describing what a file like that usually contains.'
  )
}

/** Which of these filenames are documents this can read, and which are pictures. */
function classify(name) {
  const kind = files.kindFor(String(name || ''))
  if (kind === 'image') return 'image'
  return 'document'
}

module.exports = {
  readDocument,
  hydrate,
  blocksFor,
  note,
  attachedIn,
  classify,
  forget,
  TURN_MAX,
  MAX_CHARS: files.MAX_CHARS,
  acceptGroups: files.acceptGroups,
  acceptedExtensions: files.acceptedExtensions,
  humanSize: files.humanSize,
  kindFor: files.kindFor,
}
