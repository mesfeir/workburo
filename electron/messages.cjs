/**
 * Turning the app's stored conversation into what the API will accept.
 *
 * This lives in its own file because getting it wrong is not cosmetic. An image on an assistant
 * turn is a hard 400 from the relay — "Image in assistant message is not supported" — and it
 * poisons every later message in that conversation, which is exactly what happened after a
 * generated or edited picture: the very next thing the user said failed.
 *
 * Two rules, both learned from that:
 *
 *   1. An assistant turn never carries an image. A picture the app made is recorded in words
 *      instead, so the conversation stays valid and the model still knows a picture exists.
 *   2. Image parts go only to a model that can read them. A model the app has marked text-only
 *      gets a note rather than a request that is certain to be rejected.
 *
 * Picture *paths* are hydrated into data URLs before this runs (see readStore), so `url` is
 * always what the endpoint expects.
 */

'use strict'

function fileNameOf (im) {
  const raw = im && (im.name || im.path)
  if (!raw) return ''
  return String(raw).split(/[\\/]/).pop()
}

/** How a picture is described back to the model when the picture itself cannot be sent. */
function imageNote (images, why) {
  const names = images.map(fileNameOf).filter(Boolean)
  const what = images.length === 1 ? 'an image' : `${images.length} images`
  return `[${why}: ${what}${names.length ? ` (${names.join(', ')})` : ''}]`
}

function withNote (text, note) {
  const body = String(text == null ? '' : text).trim()
  return body ? `${body} ${note}` : note
}

function toChatMessages (messages, systemPrompt, vision = 'unknown') {
  const out = []
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt })

  for (const m of messages) {
    // entries the tool loop appends internally
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.id, content: m.content || '' })
      continue
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments || '{}' },
        })),
      })
      continue
    }

    const imgs = (m.images || []).filter(Boolean)

    // Rule 1: the assistant never carries an image.
    if (m.role === 'assistant') {
      const text = String(m.content || '').trim()
      out.push({
        role: 'assistant',
        content: text || (imgs.length ? imageNote(imgs, 'made') : '[no text]'),
      })
      continue
    }

    if (!imgs.length) {
      // an attached document travels as text, after the user's own words
      out.push({ role: m.role, content: m.docBlock ? withNote(m.content, m.docBlock) : m.content || '' })
      continue
    }

    // Rule 2: only a model that can read images is sent images.
    if (vision === 'no') {
      out.push({
        role: m.role,
        content: withNote(
          m.content,
          m.docBlock
            ? withNote(m.docBlock, imageNote(imgs, 'attached but not sent, this model is marked text-only'))
            : imageNote(imgs, 'attached but not sent, this model is marked text-only'),
        ),
      })
      continue
    }

    const parts = []
    const text = m.docBlock ? withNote(m.content, m.docBlock) : m.content
    if (text) parts.push({ type: 'text', text })
    for (const url of imgs) parts.push({ type: 'image_url', image_url: { url } })
    out.push({ role: m.role, content: parts })
  }
  return out
}

function toResponsesInput (messages, vision = 'unknown') {
  const out = []
  for (const m of messages) {
    // the Responses API takes tool calls and their results as separate items
    if (m.role === 'tool') {
      out.push({ type: 'function_call_output', call_id: m.id, output: m.content || '' })
      continue
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      if (m.content) out.push({ role: 'assistant', content: m.content })
      for (const tc of m.tool_calls) {
        out.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments || '{}',
        })
      }
      continue
    }

    const imgs = (m.images || []).filter(Boolean)

    // Rule 1 again: a picture never goes out on an assistant turn.
    if (m.role === 'assistant') {
      const text = String(m.content || '').trim()
      out.push({ role: 'assistant', content: text || (imgs.length ? imageNote(imgs, 'made') : '[no text]') })
      continue
    }

    if (!imgs.length) {
      out.push({ role: m.role, content: m.content || '' })
      continue
    }

    if (vision === 'no') {
      out.push({ role: m.role, content: withNote(m.content, imageNote(imgs, 'attached but not sent, this model is marked text-only')) })
      continue
    }

    const parts = []
    if (m.content) parts.push({ type: 'input_text', text: m.content })
    for (const url of imgs) parts.push({ type: 'input_image', image_url: url })
    out.push({ role: m.role, content: parts })
  }
  return out
}

module.exports = { toChatMessages, toResponsesInput, imageNote }
