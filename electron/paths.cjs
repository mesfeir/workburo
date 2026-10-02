// Which files this app will open, and what the agent should be told about pictures. Pure, so the
// rules can be tested without Electron or a filesystem.

const path = require('node:path')

/**
 * Turn a path into an absolute one. The agent reports files the way it named them, often relative
 * to the folder it was given, so a bare "welcome.html" means "in the workspace" and not "wherever
 * the app happens to be running".
 */
function resolveOpenable (p, workspace) {
  const raw = String(p || '').trim()
  if (!raw) return ''
  if (path.isAbsolute(raw)) return path.resolve(raw)
  return path.normalize(path.join(workspace ? String(workspace) : process.cwd(), raw))
}

/** Is the target inside one of these folders, or one of them exactly? */
function withinAny (target, bases) {
  if (!target) return false
  const t = path.resolve(target)
  return (bases || []).filter(Boolean).some((b) => {
    const base = path.resolve(String(b))
    return t === base || t.startsWith(base + path.sep)
  })
}

/**
 * What to tell the agent about pictures made in this app. They are saved outside the agent's own
 * folder, which is exactly why "use the image from before" came back as not found: the agent had
 * no reason to look there. Naming the newest few gives it something concrete to reach for.
 */
function pictureNote (dir, files) {
  const list = (files || []).filter(Boolean)
  if (!dir || !list.length) return ''
  return [
    `Pictures generated in this app are saved in ${dir}. The most recent are:`,
    ...list.map((f) => `- ${path.join(dir, f)}`),
    'If you are asked to use a picture from earlier, read it from there. Do not look for it in your own folder.',
  ].join('\n')
}

/**
 * What to tell the agent about the files someone attached to their message.
 *
 * The chat path hands a document to the model as text. Agent mode does not: Pi runs in a folder of
 * its own and reads files with its own tools, so what it needs is a real file and the path to it.
 * Without this, the turn reached Pi with the prompt alone and an attached .md file was invisible:
 * the agent answered as though nothing had been attached at all.
 *
 * `copied` maps an original path to the copy made inside the agent's folder, for documents that had
 * to be copied in. A path the agent can certainly open is worth more than a tidy one.
 */
function attachmentNote (documents, images, copied) {
  const docs = (documents || []).filter((d) => d && d.path)
  const pics = (images || []).filter((i) => i && i.path)
  if (!docs.length && !pics.length) return ''
  const lines = []
  if (docs.length) {
    lines.push(
      'The user attached these files to their message. They are real files on disk, so read them with ' +
        'your file tools and answer from what they contain rather than guessing:',
    )
    for (const d of docs) {
      const at = (copied && copied[d.path]) || d.path
      const where = at !== d.path ? `${at} (a copy of ${d.path})` : at
      lines.push(`- ${d.name || path.basename(String(at || ''))}: ${where}`)
    }
  }
  if (pics.length) {
    lines.push(
      'They also attached these pictures, which are files on disk. Look at them with your file ' +
        'tools and answer from what is actually in them, never from the name:',
    )
    for (const i of pics) lines.push(`- ${i.name || path.basename(String(i.path))}: ${i.path}`)
  }
  return lines.join('\n')
}

/**
 * Where each attached document has to end up for the agent to be able to open it.
 *
 * A document already inside the workspace is somewhere the agent can read, so it is left alone. One
 * from anywhere else is placed in an `attachments` folder in the workspace, which is the one place
 * the agent is certain to be able to read from.
 */
function attachmentCopies (documents, workspace) {
  const ws = String(workspace || '')
  if (!ws) return []
  const out = []
  for (const d of (documents || []).filter((x) => x && x.path)) {
    if (withinAny(d.path, [ws])) continue
    out.push({ from: d.path, to: path.join(ws, 'attachments', path.basename(d.path)) })
  }
  return out
}

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i

/**
 * A file to hand the agent for a picture attached to the message, and a name that is safe to use.
 *
 * A picture pasted into the composer exists only as a data URL, so there is no file for the agent to
 * open until one is written. One that already has a path inside the workspace is left where it is.
 * Names are basenames only: a caller that supplies a path must not be able to choose a folder.
 */
function attachmentImageTargets (images, workspace) {
  const ws = String(workspace || '')
  if (!ws) return []
  const used = new Set()
  const out = []
  ;(images || []).forEach((im, i) => {
    if (!im) return
    const hasFile = typeof im.path === 'string' && im.path.trim() !== ''
    const dataUrl = typeof im.url === 'string' && /^data:image\//i.test(im.url) ? im.url : ''
    if (!hasFile && !dataUrl) return
    let base = path.basename(String(im.name || '').trim() || `attached-${i + 1}.png`).replace(/[^\w.\- ]+/g, '_')
    if (!IMAGE_EXT_RE.test(base)) base += '.png'
    let name = base
    let n = 1
    while (used.has(name.toLowerCase())) {
      n += 1
      name = base.replace(IMAGE_EXT_RE, `-${n}$1`)
    }
    used.add(name.toLowerCase())
    out.push({
      name,
      to: path.join(ws, 'attachments', name),
      from: hasFile ? im.path : '',
      dataUrl,
      alreadyInside: hasFile ? withinAny(im.path, [ws]) : false,
    })
  })
  return out
}

/**
 * The bytes inside an image data URL, or null.
 *
 * A picture pasted into the composer is a data URL and nothing else, so there is no file for the
 * agent to open until one is written. This is the rule that decides what counts as a picture worth
 * writing out, and it is pure so it can be tested without a filesystem.
 */
function dataUrlBytes (url) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(url || '').trim())
  if (!m) return null
  return { mime: m[1].toLowerCase(), base64: m[2] }
}

/** The id of the newest message, which is how far the agent has been shown the conversation. */
function lastMessageId (messages) {
  const list = (messages || []).filter((m) => m && typeof m.id === 'string' && m.id)
  return list.length ? list[list.length - 1].id : ''
}

/** One line of text, for comparing a prompt with what was said. */
function flatten (t) {
  return String(t == null ? '' : t).trim().replace(/\s+/g, ' ')
}

const CONTEXT_HEAD_FIRST =
  'Earlier in this conversation, before agent mode was switched on, this was said. Treat it as ' +
  'context for what comes next; do not repeat it back.'
const CONTEXT_HEAD_SINCE =
  'Agent mode was off while this conversation carried on, so you were not handling it. Here is what ' +
  'was said since your last turn. Treat it as context and continue from it rather than starting the ' +
  'subject again; do not repeat it back.'

/**
 * What the agent should know about the conversation it is joining.
 *
 * Pi keeps its own session, so it remembers the turns it handled. It does not know about anything
 * said while agent mode was off, which is why switching agent mode on mid-conversation left it
 * answering as though the discussion had never happened.
 *
 * The anchor is the last thing the agent was shown, given either as a message id or as the text of
 * its previous prompt. The text form matters: the message list is read from the store, which can lag
 * behind the window by a moment, so an id taken at the wrong instant would re-tell one message. A
 * prompt's own words are already in the conversation by the time the next turn starts. Everything
 * after the anchor is carried; nothing before it is repeated.
 */
function agentContextNote (messages, opts) {
  const o = opts || {}
  const since = String(o.sinceId || '')
  const sinceText = flatten(o.sinceText)
  const limit = Number(o.limit) > 0 ? Number(o.limit) : 20
  const chars = Number(o.chars) > 0 ? Number(o.chars) : 600
  const now = flatten(o.currentPrompt)
  const list = (messages || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
  let start = 0
  // Whether this is a join rather than a first meeting decides which sentence explains it.
  let joining = false
  if (list.length) {
    // The prompt's own words are the better anchor, and are tried first: the message list comes from
    // the store, which can lag the window by a moment, so an id read at the wrong instant names a
    // message one short of the truth and would re-tell one turn. An id is the fallback.
    if (sinceText) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (flatten(list[i].content) === sinceText) {
          start = i + 1
          joining = true
          break
        }
      }
    }
    if (!joining && since) {
      const at = list.findIndex((m) => m && m.id === since)
      if (at >= 0) {
        start = at + 1
        joining = true
      }
    }
    // An anchor that is nowhere in the conversation (an old chat, a trimmed history) falls back to
    // the recent stretch rather than either repeating everything or saying nothing.
    if (!joining && (since || sinceText)) start = Math.max(0, list.length - limit)
  }
  const lines = []
  for (const m of list.slice(start)) {
    const text = flatten(m.content)
    if (!text) continue
    if (now && text === now) continue
    lines.push(`${m.role === 'user' ? 'user' : 'assistant'}: ${text.slice(0, chars)}`)
  }
  const recent = lines.slice(-limit)
  if (!recent.length) return ''
  return [joining ? CONTEXT_HEAD_SINCE : CONTEXT_HEAD_FIRST, '', ...recent].join('\n')
}

module.exports = {
  resolveOpenable,
  withinAny,
  pictureNote,
  attachmentNote,
  attachmentCopies,
  attachmentImageTargets,
  dataUrlBytes,
  lastMessageId,
  agentContextNote,
}
