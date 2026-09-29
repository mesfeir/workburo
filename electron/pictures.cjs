/**
 * What pictures a conversation contains, and which one the image tool may be pointed at.
 *
 * This lives in its own file, like ./messages.cjs, because these rules are the difference between
 * "change my picture" and "draw something vaguely related": they are tested directly rather than
 * assumed. Nothing here talks to fal or to the window — the caller passes a reader for files on
 * disk, so a test can run with no filesystem at all.
 */

/**
 * Every picture in the conversation, oldest first. A drawn picture is kept on disk with its URL
 * stripped from the store, so it carries a `path` and no `url`; an attached one carries its data
 * URL directly.
 */
function picturesIn(messages) {
  const out = []
  for (const m of messages || []) {
    for (const img of m?.images || []) {
      if (!img) continue
      out.push({
        url: String(img.url || ''),
        path: String(img.path || ''),
        name: String(img.name || 'image'),
        from: m.role === 'user' ? 'the user attached it' : 'you drew it',
      })
    }
  }
  return out
}

/** The URL to hand fal for a picture: already in hand, or read back off disk. */
function pictureUrl(pic, readFile) {
  if (!pic) return ''
  if (pic.url) return pic.url
  if (pic.path && typeof readFile === 'function') {
    try {
      return readFile(pic.path)
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * The two pictures the image tool may be pointed at: the most recent one in the conversation
 * ("last"), and the one attached to the user's current message ("attached").
 *
 * The model only ever *names* one of these. main resolves the actual image here, so a model with
 * no vision can still change a picture it cannot see, and a model can never invent an image out of
 * nowhere. A picture whose file cannot be read is resolved to null rather than to a broken URL —
 * the tool then says so plainly instead of drawing something unrelated.
 */
function referencesFor(messages, readFile) {
  const pics = picturesIn(messages)
  const lastUser = [...(messages || [])]
    .reverse()
    .find((m) => m.role === 'user' && (m.images || []).length)
  const resolve = (pic) => {
    const url = pictureUrl(pic, readFile)
    return url ? { url, name: pic.name } : null
  }
  return {
    last: pics.length ? resolve(pics[pics.length - 1]) : null,
    attached: lastUser ? resolve(picturesIn([lastUser])[0]) : null,
    // The model is told about the pictures *by name* — pictureNote writes "2. shot.png — drawn (the
    // most recent)" — so it will naturally name one back. Only "last" and "attached" used to be
    // accepted, so every such request was refused with "no picture in this conversation", and the
    // model, having failed, drew the instruction from scratch instead. The failures and the
    // irrelevant pictures were one bug seen twice.
    named: Object.fromEntries(
      pics
        .map((p) => [String(p.name || '').trim().toLowerCase(), resolve(p)])
        .filter(([k, v]) => k && v),
    ),
    // and by position, for "the second one"
    list: pics.map((p) => resolve(p)),
  }
}

/**
 * What pictures exist in this conversation, said out loud to the model. Without this, "add a hat to
 * it" reads as a request to draw something new — which is how a generated picture came back
 * recreated from scratch instead of edited.
 */
function pictureNote(messages) {
  const pics = picturesIn(messages)
  if (!pics.length) return ''
  const list = pics
    .map((p, i) => `${i + 1}. ${p.name} — ${p.from}${i === pics.length - 1 ? ' (the most recent)' : ''}`)
    .join('; ')
  return (
    `Pictures already in this conversation, oldest first: ${list}. When the user asks for one of ` +
    'them to be changed — "add …", "make it …", "change the …", "put … on it", "make it bigger" — ' +
    'call generate_image with reference: "last" for the most recent one, or reference: "attached" ' +
    'for the picture in their current message, and write the prompt as the instruction for the ' +
    'change. Without a reference you draw a brand new picture instead of changing theirs.'
  )
}

module.exports = { picturesIn, pictureUrl, referencesFor, pictureNote }
