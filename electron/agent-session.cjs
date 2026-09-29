/**
 * Which folder an agent session works in, and what the window shows while it runs.
 *
 * These live in a module rather than inline in main so the rules can be tested directly. The rule
 * that matters: a session's own folder is what lets several sessions run at the same time without
 * trampling each other's files.
 */

/** The folder for this session: the request wins, then the chat's own folder, then the default. */
function pickWorkspace ({ request, conversation, global } = {}) {
  for (const candidate of [request, conversation, global]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

/** One running session, in the shape the window draws. */
function sessionSummary (meta, now = Date.now()) {
  const m = meta && typeof meta === 'object' ? meta : {}
  const startedAt = Number(m.startedAt) || now
  return {
    requestId: String(m.requestId || ''),
    conversationId: String(m.conversationId || ''),
    title: String(m.title || 'New chat'),
    workspace: String(m.workspace || ''),
    model: String(m.model || ''),
    startedAt,
    seconds: Math.max(0, Math.round((now - startedAt) / 1000)),
  }
}

module.exports = { pickWorkspace, sessionSummary }
