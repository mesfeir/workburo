/**
 * "Change my picture" must change my picture.
 *
 * Two faults made an edit come back as a fresh drawing:
 *   1. the tool path never carried a reference at all, so the model could only ever draw anew;
 *   2. FLUX-style image-to-image runners were sent no `strength`, so fal used its default (0.95)
 *      and re-drew from the prompt, using the picture as a hint.
 *
 * This checks the mapping (offline, with a stand-in generator) and then the bodies that actually
 * go to fal, against the endpoints' real published schemas. Schemas cost nothing and need no
 * credits, so this still runs on an account with no balance. The key is never printed.
 *
 *   node scripts/test-edit.cjs            offline + live schema checks
 *   node scripts/test-edit.cjs --offline  no network at all
 */
const path = require('node:path')
const fs = require('node:fs')

const pictures = require('../electron/pictures.cjs')
const tools = require('../electron/tools.cjs')
const images = require('../electron/images.cjs')

const OFFLINE = process.argv.includes('--offline')
let pass = 0
let fail = 0

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ------------------------------------------------------------------ the stored shapes */

const DATA_URL = `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`

// what a conversation actually looks like: an attached picture carries its data URL, a drawn one
// carries a path with the URL stripped out of the store
const conversation = [
  { role: 'user', content: 'here is my logo', images: [{ name: 'logo.png', url: DATA_URL }] },
  { role: 'assistant', content: 'Nice.', images: [] },
  { role: 'user', content: 'make a poster of it' },
  {
    role: 'assistant',
    content: '[made: an image (zen-1-1.png)]',
    images: [{ name: 'zen-1-1.png', path: 'Z:\\pictures\\zen-1-1.png', url: '' }],
  },
]

const readFile = (file) => (file.endsWith('zen-1-1.png') ? DATA_URL : '')

/* ------------------------------------------------------------------ 1. picture rules */

check(
  'every picture in the conversation is found, attached and drawn alike',
  pictures.picturesIn(conversation).length === 2,
  `${pictures.picturesIn(conversation).length} found`,
)

const refs = pictures.referencesFor(conversation, readFile)
check(
  '"last" is the most recent picture — the one just drawn',
  refs.last?.name === 'zen-1-1.png',
  refs.last ? `resolved ${refs.last.name} (${refs.last.url.slice(0, 22)}…)` : 'nothing resolved',
)
check(
  'a drawn picture is read back off disk, because the store keeps no URL for it',
  refs.last?.url === DATA_URL,
  refs.last?.url ? 'same bytes, from disk' : 'NOT RESOLVED — a drawn picture could never be edited',
)
check(
  '"attached" is the picture in the user\'s own message',
  refs.attached?.name === 'logo.png' && refs.attached?.url === DATA_URL,
  refs.attached ? `${refs.attached.name}` : 'nothing resolved',
)

const unreadable = pictures.referencesFor(
  [{ role: 'assistant', content: '', images: [{ name: 'gone.png', path: 'Z:\\nope\\gone.png' }] }],
  () => {
    throw new Error('ENOENT')
  },
)
check(
  'a picture whose file has gone is resolved to nothing, never to a broken URL',
  unreadable.last === null,
  'null rather than a data URL full of nothing',
)

check('a conversation with no pictures produces no note', pictures.pictureNote([{ role: 'user', content: 'hi' }]) === '', 'empty')
const note = pictures.pictureNote(conversation)
check(
  'the model is told which pictures it can change, and how',
  /logo\.png/.test(note) && /zen-1-1\.png/.test(note) && /reference: "last"/.test(note) && /most recent/.test(note),
  note.slice(0, 96).replace(/\s+/g, ' ') + '…',
)

/* ------------------------------------------------------------------ 2. the tool path */

const imageTool = tools.REGISTRY.generate_image.schema.function
check(
  'the tool tells the model that it can change a picture already in the conversation',
  /change/i.test(imageTool.description) && /reference/.test(imageTool.description),
  'description mentions changing and reference',
)
check(
  'the model may name a picture, but only one that is really there',
  // This used to assert enum === ["last","attached"]. The app tells the model about the pictures by
  // name ("2. shot.png — drawn"), so the model names them back, and a strict enum made the natural
  // answer impossible. What matters is not the shape of the answer but that it cannot invent one:
  // an unknown name resolves to nothing and the tool refuses, listing what does exist. The behaviour
  // is pinned in scripts/test-tools.cjs ("a reference that cannot be found says what is there").
  !Array.isArray(imageTool.parameters.properties.reference?.enum),
  `enum=${JSON.stringify(imageTool.parameters.properties.reference?.enum)}`,
)

/** run the tool with a stand-in generator, so this part needs no key and no network */
async function runTool(args, refsForTool, cfg = {}) {
  const calls = []
  const res = await tools.executeTool('generate_image', JSON.stringify(args), {
    images: {
      key: 'test-key-not-real',
      model: 'fal-ai/flux/schnell',
      editModel: 'fal-ai/nano-banana/edit',
      references: refsForTool,
      imagesDir: 'Z:\\scratch',
      generate: async (req) => {
        calls.push(req)
        return { ok: true, images: [{ name: 'out.png', url: DATA_URL }], tookMs: 1200 }
      },
      ...cfg,
    },
  })
  return { res, calls }
}

;(async () => {
  const edit = await runTool({ prompt: 'add a red hat', reference: 'last' }, refs)
  check(
    'an edit hands the picture to fal, with the user\'s words as the prompt',
    edit.calls.length === 1 && edit.calls[0].imageUrl === DATA_URL && edit.calls[0].prompt === 'add a red hat',
    edit.calls[0] ? `imageUrl=${edit.calls[0].imageUrl ? 'the picture' : 'MISSING'}, prompt="${edit.calls[0].prompt}"` : 'no call',
  )
  check(
    'an edit runs on the edit endpoint, not the drawing one',
    edit.calls[0]?.model === 'fal-ai/nano-banana/edit',
    `model used: ${edit.calls[0]?.model || 'none'}`,
  )
  check(
    'the report back to the model says the picture was changed, not drawn',
    /Changed the picture/i.test(edit.res.text || '') && !/^Drew/.test(String(edit.res.text || '')),
    String(edit.res.text || '').slice(0, 88).replace(/\s+/g, ' ') + '…',
  )

  const draw = await runTool({ prompt: 'a cat astronaut' }, refs)
  check(
    'no reference means a new picture, on the drawing endpoint, with no reference attached',
    draw.calls[0] && !draw.calls[0].imageUrl && draw.calls[0].model === 'fal-ai/flux/schnell' && /^Drew/.test(draw.res.text || ''),
    `model=${draw.calls[0]?.model}, imageUrl=${draw.calls[0]?.imageUrl ? 'present' : 'none'}`,
  )

  const nothing = await runTool({ prompt: 'add a hat', reference: 'last' }, { last: null, attached: null })
  check(
    'asking to change a picture when there is none fails loudly instead of drawing something else',
    nothing.res.ok === false && /no picture/i.test(nothing.res.error || '') && nothing.calls.length === 0,
    String(nothing.res.error || '').slice(0, 96),
  )

  const asksAttached = await runTool({ prompt: 'tidy this up', reference: 'attached' }, refs)
  check(
    '"attached" edits the picture in the user\'s own message',
    asksAttached.calls[0]?.imageUrl === DATA_URL && asksAttached.calls[0]?.model === 'fal-ai/nano-banana/edit',
    asksAttached.calls[0] ? `model=${asksAttached.calls[0].model}` : 'no call',
  )

  /* ---------------------------------------------------------------- 3. the real bodies */

  if (OFFLINE) {
    console.log('\n(offline: skipping the checks against fal\'s published schemas)')
    report()
    return
  }

  const square = images.SIZE_PRESETS.find((p) => p.id === 'square_hd')

  try {
    const flux = await images.buildBody('fal-ai/flux/dev/image-to-image', {
      prompt: 'add a red hat',
      count: 1,
      size: square?.id,
      imageUrl: DATA_URL,
    })
    check(
      'FLUX image-to-image is sent a strength that keeps the picture (was: fal\'s default 0.95, which re-draws)',
      flux.body.strength === 0.85 && /strength=0\.85/.test(flux.applied.join(' | ')),
      `strength=${flux.body.strength} — ${flux.applied.filter((a) => /strength/.test(a)).join('')}`,
    )
    check(
      'and it is sent the picture itself',
      flux.body.image_url === DATA_URL,
      `image_url=${String(flux.body.image_url).slice(0, 20)}…`,
    )
    check(
      'the prompt is the user\'s instruction, unchanged',
      flux.body.prompt === 'add a red hat',
      `"${flux.body.prompt}"`,
    )
  } catch (err) {
    check('FLUX image-to-image body', false, `could not build: ${err.message}`)
  }

  try {
    const banana = await images.buildBody('fal-ai/nano-banana/edit', {
      prompt: 'add a red hat',
      count: 1,
      size: square?.id,
      imageUrl: DATA_URL,
    })
    check(
      'an instruction editor gets the picture as an image_urls list (what its schema declares)',
      Array.isArray(banana.body.image_urls) && banana.body.image_urls[0] === DATA_URL,
      `image_urls=${Array.isArray(banana.body.image_urls) ? `[${banana.body.image_urls.length}]` : String(banana.body.image_urls).slice(0, 24)}`,
    )
    check(
      'and is not sent a strength it does not have',
      banana.body.strength === undefined,
      `strength=${String(banana.body.strength)} (absent, as it should be)`,
    )
    check(
      'the editor keeps the original shape by default (aspect_ratio auto, no forced size)',
      banana.body.image_size === undefined,
      `image_size=${String(banana.body.image_size)}`,
    )
  } catch (err) {
    check('nano-banana/edit body', false, `could not build: ${err.message}`)
  }

  // the catalogue the edit picker reads: real editors, and nothing that returns a video
  let key = process.env.ZEN_FAL_KEY || ''
  if (!key) {
    try {
      const store = JSON.parse(
        fs.readFileSync(path.join(process.env.APPDATA || '', 'zen-chat', 'zen-chat-store.json'), 'utf8'),
      )
      key = (store.config?.imageGen?.falKey) || ''
    } catch {}
  }
  if (!key) {
    console.log('SKIP  the live catalogue list (no fal key available)')
  } else {
    const list = await images.listModels(key, { categories: 'image-to-image', pages: 1 })
    const ids = (list.models || []).map((m) => m.id)
    check(
      'the edit picker can reach the real instruction editors',
      ids.some((id) => /nano-banana/.test(id)) && ids.some((id) => /\/edit$/.test(id)),
      ids.filter((id) => /nano-banana|\/edit/.test(id)).slice(0, 3).join(', ') || ids.slice(0, 3).join(', '),
    )
    check(
      'and never offers something that returns a video instead of a picture',
      !ids.some((id) => /video|tts|audio|upscale|background/i.test(id)),
      `${ids.length} endpoints, none of them video/audio`,
    )
  }

  report()
})()

function report() {
  console.log(`\n${pass}/${pass + fail} checks passed`)
  process.exit(fail ? 1 : 0)
}
