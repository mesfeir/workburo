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
    lines.push('They also attached these pictures, which are files on disk:')
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

module.exports = { resolveOpenable, withinAny, pictureNote, attachmentNote, attachmentCopies }
