/**
 * What pictures a conversation contains, and which one the image tool may be pointed at.
 *
 * This lives in its own file, like ./messages.cjs, because these rules are the difference between
 * "change my picture" and "draw something vaguely related": they are tested directly rather than
 * assumed. Nothing here talks to fal or to the window — the caller passes a reader for files on
 * disk, so a test can run with no filesystem at all.
 */

/**
 * One picture, in either of the two shapes it really arrives in.
 *
 * The store keeps `{ name, path, url }`: a drawn picture is on disk with its URL stripped, so it
 * carries a `path`. The renderer sends the same conversation to main as plain `url` strings,
 * because that is what a provider request needs — a string goes straight into `image_url`.
 *
 * Reading only the object shape made every picture resolve to nothing on the tool path. The note
 * that tells the model pictures exist was empty, so it never thought to reference one and answered
 * by describing the image instead of using it; and a reference, when the model did try one, came
 * back as "nothing has been attached or drawn here yet". The Image switch uses the store's shape
 * and worked, which is why the same request sometimes worked and sometimes did not.
 */
function asPicture(img, role, name = '') {
  if (typeof img === 'string') {
    const url = img.trim()
    if (!url) return null
    return { url, path: '', name: String(name || ''), from: role === 'user' ? 'the user attached it' : 'you drew it' }
  }
  if (!img) return null
  return {
    url: String(img.url || ''),
    path: String(img.path || ''),
    name: String(img.name || name || ''),
    from: role === 'user' ? 'the user attached it' : 'you drew it',
  }
}

/**
 * Every picture in the conversation, oldest first.
 *
 * `imageNames` travels beside the renderer's url strings, one name per picture in the same order, so
 * a picture the user attached keeps the name they know it by.
 */
function picturesIn(messages) {
  const out = []
  for (const m of messages || []) {
    const names = Array.isArray(m?.imageNames) ? m.imageNames : []
    const list = m?.images || []
    list.forEach((img, i) => {
      const pic = asPicture(img, m?.role, names[i])
      if (pic) out.push(pic)
    })
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
  // A picture with no name of its own — everything the renderer sends is a bare data URL — is still
  // a picture the model can name by position, so it gets one rather than an empty label.
  const resolve = (pic, i) => {
    const url = pictureUrl(pic, readFile)
    return url ? { url, name: pic.name || `picture ${(i ?? 0) + 1}` } : null
  }
  return {
    // How many pictures are in the conversation at all. A picture whose file cannot be read
    // resolves to null, and the tool must not then claim nothing was ever attached.
    present: pics.length,
    last: pics.length ? resolve(pics[pics.length - 1], pics.length - 1) : null,
    attached: lastUser ? resolve(picturesIn([lastUser])[0], pics.length - 1) : null,
    // The model is told about the pictures *by name* — pictureNote writes "2. shot.png — drawn (the
    // most recent)" — so it will naturally name one back. Only "last" and "attached" used to be
    // accepted, so every such request was refused with "no picture in this conversation", and the
    // model, having failed, drew the instruction from scratch instead. The failures and the
    // irrelevant pictures were one bug seen twice.
    named: Object.fromEntries(
      pics
        .map((p, i) => [String(p.name || '').trim().toLowerCase(), resolve(p, i)])
        .filter(([k, v]) => k && v),
    ),
    // and by position, for "the second one"
    list: pics.map((p, i) => resolve(p, i)),
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
    .map(
      (p, i) =>
        `${i + 1}. ${p.name || `picture ${i + 1}`} — ${p.from}${i === pics.length - 1 ? ' (the most recent)' : ''}`,
    )
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
