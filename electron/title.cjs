/**
 * Chat titles.
 *
 * A conversation should be named by what it turned out to be about, not by the first few
 * words of the opening message. This module owns the rules for that: the instruction sent
 * to the model, the transcript it is shown, and the parser that reads the reply back.
 *
 * Pure on purpose — no electron, no network, nothing to stub — so the rules can be tested
 * in plain Node (scripts/test-titles.cjs) and the parser can never drift from the prompt
 * that feeds it.
 */

'use strict'

/** The reply is 3 or 4 words. A fifth word is the model starting to explain itself. */
const MAX_WORDS = 4

/** The same ceiling the opening-words fallback uses, so a sidebar never has two shapes. */
const MAX_CHARS = 42

/** How much of each message the model sees. A title needs the gist, not the essay. */
const PER_MESSAGE = 700

/** How long the title call may take before it is abandoned and the fallback title stays. */
const TIMEOUT_MS = 15000

const INSTRUCTIONS = [
  'You name chat threads.',
  'Reply with 3 or 4 words describing what the conversation is about.',
  'A title, not a sentence: no quotes, no trailing punctuation, no explanation.',
  'Never repeat the user\'s own words back as the title — name the subject instead.',
  'Asked to turn a report into a spreadsheet, reply: report data spreadsheet',
].join('\n')

/**
 * The transcript handed to the model: the first thing the assistant answered, then the first
 * thing the user asked. The reply comes first on purpose: it is usually more topical than the
 * request, and a model shown the request first tends to echo it back as the title — which the
 * usable() check then refuses, leaving the chat named by its opening words anyway.
 */
function transcript(messages, opts = {}) {
  const take = (m) => String((m && m.content) || '').trim().replace(/\s+/g, ' ').slice(0, PER_MESSAGE)
  const first = (role) => (messages || []).find((m) => m && m.role === role)
  const user = take(first('user'))
  const assistant = take(first('assistant'))
  if (!user && !assistant) return ''
  // A second framing exists because a model that has just answered a message will sometimes hand
  // that request straight back as the title. Showing the request on its own asks for a subject for
  // it; showing the reply first asks for the subject of the answer. Neither is better in general,
  // and between them a model that echoes one way usually summarises the other.
  if (opts.only === 'user') return user ? `User asked: ${user}` : ''
  if (opts.only === 'assistant') return assistant ? `Assistant: ${assistant}` : ''
  return [
    assistant ? `Assistant: ${assistant}` : '',
    user ? `User asked: ${user}` : '',
  ].filter(Boolean).join('\n')
}

/**
 * Turn whatever came back into a title, or '' when there is nothing usable. One word is
 * accepted, because some subjects are one word. Anything longer than four is cut rather than
 * rejected: the first four words are usually the title and the rest is the model talking.
 */
function clean(raw) {
  let t = String(raw == null ? '' : raw)
  if (!t.trim()) return ''
  // only the first non-empty line: a model that ignores the instruction writes a sentence
  const firstLine = t.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
  t = firstLine || ''
  t = t.replace(/^\s*(?:title|chat title|summary)\s*[:\-–]\s*/i, '')
  t = t.replace(/^["'“”‘’`*\s]+/, '').replace(/["'“”‘’`*.\s!?,;:]+$/, '')
  t = t.replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const words = t.split(' ')
  if (words.length > MAX_WORDS) t = words.slice(0, MAX_WORDS).join(' ')
  if (t.length > MAX_CHARS) t = t.slice(0, MAX_CHARS).trimEnd()
  return t
}

/**
 * Is this worth replacing the opening words with?
 *
 * The point of the feature is that a title says something the message did not already say in
 * its first line, so a reply that just echoes the opening is refused and the fallback stays.
 */
function usable(candidate, firstUserText, firstAssistantText) {
  const t = String(candidate || '').trim()
  if (!t) return false
  if (t.split(' ').filter(Boolean).length > MAX_WORDS) return false
  const opening = String(firstUserText || '').trim().replace(/\s+/g, ' ')
  const reply = String(firstAssistantText || '').trim().replace(/\s+/g, ' ')
  // Only a reply that IS the opening words is refused: that is the one case where the title says
  // nothing the message did not already say. A summary that reuses the nouns from the opening is
  // not refused, because that is usually exactly what a good title looks like —
  // "supplier prices spreadsheet" for a message about turning supplier prices into one.
  if (opening && opening.toLowerCase().startsWith(t.toLowerCase())) return false
  // The assistant's opening line is checked too. It is often a greeting ("Hello! How can I
  // help?") and a model shown it first will happily hand that back as the title, which is a
  // worse name than the opening words it replaced.
  if (reply && reply.toLowerCase().startsWith(t.toLowerCase())) return false
  return true
}

module.exports = { INSTRUCTIONS, transcript, clean, usable, MAX_WORDS, MAX_CHARS, PER_MESSAGE, TIMEOUT_MS }
