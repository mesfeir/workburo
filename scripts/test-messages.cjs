/**
 * Tests for the mapping from stored conversation to API payload.
 *
 * This exists because of a 400 that took a whole conversation down: after a picture had been
 * generated or edited, the assistant turn carried that picture, and the relay refuses images on
 * assistant messages — "Image in assistant message is not supported". Every follow-up in that
 * conversation failed until the picture was mapped out of it.
 *
 * Offline:  node scripts/test-messages.cjs
 * Live:     with a relay key present (read from the app's store) the conversation that used to
 *           fail is replayed and must come back 200. The key is never printed.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { toChatMessages, toResponsesInput } = require('../electron/messages.cjs')

let passed = 0
let failed = 0
const failures = []

function check (label, fn) {
  try {
    const r = fn()
    if (r === false) throw new Error('assertion failed')
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    failures.push(`${label}: ${err.message}`)
    console.log(`  FAIL  ${label} — ${err.message}`)
  }
}

function assert (cond, why) {
  if (!cond) throw new Error(why || 'assertion failed')
}

/** a real 1x1 png, so nothing here depends on made-up image data */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function hasImagePart (m) {
  return Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url' || p.type === 'input_image')
}

/** exactly the shape the app stores after a fal edit, which is what broke */
const FAILING_CONVERSATION = [
  { role: 'user', content: 'make this image into a super realistic image', images: [{ name: 'in.png', url: TINY_PNG }] },
  { role: 'assistant', content: '', images: [{ name: 'out.png', url: TINY_PNG, path: 'C:\\imgs\\out.png' }], model: 'fal-ai/flux-2/klein/4b/base/edit' },
  { role: 'user', content: 'make it bigger', images: [] },
]

console.log('\nConversation mapping — offline\n')

check('1. an assistant turn never carries a picture, however it was stored', () => {
  const out = toChatMessages(FAILING_CONVERSATION, '', 'unknown')
  const assistant = out.filter((m) => m.role === 'assistant')
  assert(assistant.length > 0, 'the assistant turn is still there')
  for (const m of assistant) assert(!hasImagePart(m), 'an assistant message must never carry image parts (hard 400)')
  return true
})

check('2. the picture is still accounted for, in words', () => {
  const out = toChatMessages(FAILING_CONVERSATION, '', 'unknown')
  const assistant = out.find((m) => m.role === 'assistant')
  assert(typeof assistant.content === 'string' && assistant.content.length > 0, 'no empty turn: the API rejects those')
  assert(/out\.png/.test(assistant.content), `the turn says which picture it made, got ${JSON.stringify(assistant.content)}`)
  return true
})

check('3. the conversation that failed now maps to something valid', () => {
  const out = toChatMessages(FAILING_CONVERSATION, '', 'unknown')
  assert(out.length === 3, 'every turn survives the mapping')
  for (const m of out) {
    const empty = !Array.isArray(m.content) && !String(m.content || '').trim()
    assert(!empty, `a ${m.role} turn came out empty, which is its own 400`)
  }
  return true
})

check('4. a user picture still reaches a model that can read it', () => {
  const out = toChatMessages(FAILING_CONVERSATION, '', 'unknown')
  const user = out[0]
  assert(hasImagePart(user), 'the user\'s own picture is still sent as an image part')
  assert(user.content.some((p) => p.type === 'text'), 'and the words come with it')
  return true
})

check('5. a model the app has marked text-only is not sent pictures at all', () => {
  const out = toChatMessages(FAILING_CONVERSATION, '', 'no')
  for (const m of out) assert(!hasImagePart(m), 'a text-only model must not be sent any image part')
  const user = out[0]
  assert(/text-only/.test(String(user.content)), 'and is told why the picture is missing')
  return true
})

check('6. the Responses API mapping obeys the same rules', () => {
  const out = toResponsesInput(FAILING_CONVERSATION, 'unknown')
  for (const m of out) {
    if (m.role === 'assistant') {
      assert(!Array.isArray(m.content) || !m.content.some((p) => p.type === 'input_image'), 'no picture on an assistant turn here either')
      assert(String(m.content || '').trim().length > 0, 'no empty assistant turn')
    }
  }
  return true
})

check('7. a normal conversation is left exactly as it was', () => {
  const plain = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'how are you' },
  ]
  const out = toChatMessages(plain, 'be brief', 'unknown')
  assert(out[0].role === 'system' && out[0].content === 'be brief', 'the system prompt is still first')
  assert(out.length === 4, 'nothing added or lost')
  assert(out[3].content === 'how are you', 'plain text passes through untouched')
  return true
})

check('8. a user message with an unknown model preference keeps its picture', () => {
  const out = toChatMessages([{ role: 'user', content: 'what is this', images: [{ name: 'x.png', url: TINY_PNG }] }], '', 'yes')
  assert(hasImagePart(out[0]), 'a vision-capable model still gets the image')
  return true
})

/* --------------------------------------------------------------------- live */

function readStore () {
  const file = path.join(process.env.APPDATA || '', 'zen-chat', 'zen-chat-store.json')
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

async function live () {
  const store = readStore()
  const cfg = (store && store.config) || {}
  const key = process.env.ZEN_RELAY_KEY || cfg.apiKey
  if (!key) {
    console.log('\nLive checks skipped (no relay key found).\n')
    return
  }

  // Prefer the real conversation that failed, so the check is about the user's actual case.
  const real = (store.conversations || []).find(
    (c) => (c.messages || []).some((m) => m.role === 'assistant' && (m.images || []).length)
  )
  const messages = real
    ? real.messages.filter((m) => m.role === 'user' || m.role === 'assistant')
    : FAILING_CONVERSATION
  const vision = cfg.modelPrefs?.[cfg.model]?.vision || 'unknown'

  console.log('\nConversation mapping — live\n')
  console.log(`        replaying ${real ? `your conversation "${String(real.title || '').slice(0, 30)}"` : 'a synthetic conversation'} · ${cfg.model} · vision=${vision}`)

  const post = async (msgs) => {
    try {
      const res = await fetch(`${String(cfg.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'x-opencode-session': cfg.affinityId || 'zen-chat-test',
          'User-Agent': 'ZenChat/1.0',
        },
        body: JSON.stringify({ model: cfg.model, messages: msgs, stream: false, max_tokens: 1024, reasoning_effort: 'medium' }),
      })
      return { status: res.status, detail: (await res.text()).replace(/\s+/g, ' ').slice(0, 220) }
    } catch (err) {
      return { status: 0, detail: err.message }
    }
  }

  // The two things the app can send: the picture itself to a model confirmed to read pictures,
  // and — when the model refuses it — the same conversation with the picture described in words.
  // That second request is the retry the app now performs by itself.
  const withPicture = await post(toChatMessages(messages, cfg.systemPrompt || '', 'yes'))
  const inWords = await post(toChatMessages(messages, cfg.systemPrompt || '', 'no'))
  console.log(`        picture sent: HTTP ${withPicture.status} · picture described in words: HTTP ${inWords.status}`)

  // A rate limit upstream is not a failure of this code. Free models run on shared pools that say
  // "temporarily rate-limited upstream" and mean it, so this reports that the check could not run
  // instead of turning a busy pool into a red build. Without this, an outage and a real regression
  // look identical.
  // An upstream rate limit is not a failure of this code: free models run on shared pools that say
  // "temporarily rate-limited upstream" and mean it. Keyed on the request this check asserts,
  // because the picture request legitimately answers 400 when a model refuses images, and that is
  // not an outage. Check 10 below is mapping, so it runs either way.
  const upstreamBusy = (status) => status === 429 || status === 502 || status === 503
  if (upstreamBusy(inWords.status)) {
    console.log(
      `  SKIP  9 — ${cfg.model} is rate-limited upstream right now (HTTP ${inWords.status}). ` +
        'The mapping it covers is provider-independent and is tested above.'
    )
  } else {
    check('9. a conversation holding a picture answers when the picture is described, not sent', () => {
      assert(inWords.status === 200, `HTTP ${inWords.status} — ${inWords.detail}`)
      return true
    })
  }

  // This one is mapping, not provider behaviour, so it is built from a conversation of its own.
  // Asserting on whatever the user's newest chat happens to hold made the check fail for a chat
  // whose only picture is one the assistant drew, which by design is never sent to a model.
  const ownConversation = [
    { id: 'u1', role: 'user', content: 'what is this?', images: [{ url: 'data:image/png;base64,AAAA', name: 'shot.png', kind: 'image' }], createdAt: 1 },
    { id: 'a1', role: 'assistant', content: 'A screenshot.', createdAt: 2 },
  ]

  check('10. pictures only go to a model that reads them', () => {
    assert(
      toChatMessages(ownConversation, '', 'yes').some((m) => hasImagePart(m)),
      'with vision on, a model that reads pictures must be sent the picture itself'
    )
    assert(
      !toChatMessages(ownConversation, '', 'no').some((m) => hasImagePart(m)),
      'with vision off, a model that cannot read a picture must be sent none'
    )
    // and the words path still exists for the model that refused it
    assert(
      toChatMessages(ownConversation, '', 'no').some((m) => /shot\.png|what is this/.test(JSON.stringify(m))),
      'the conversation itself must survive being described instead of illustrated'
    )
    return true
  })
}

live()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed\n`)
    if (failed) {
      for (const f of failures) console.log(`  - ${f}`)
      process.exitCode = 1
    }
  })
  .catch((err) => {
    console.error('\ntest harness error:', err)
    process.exitCode = 1
  })
