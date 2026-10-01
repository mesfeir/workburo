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

module.exports = { resolveOpenable, withinAny, pictureNote }
