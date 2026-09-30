// README screenshot capture: drives the REAL UI at a readable window size and
// writes publication-ready screenshots.
//
// Run with:  npx electron . --capture <api-key>
//
// Separate from selftest.cjs on purpose: the self-test asserts behaviour and
// its frames are mid-flow (tooltips open, answers still streaming), which makes
// poor README material. This pass drives a small, curated conversation instead.
// The seeded store is written to an isolated profile, so a capture run never
// touches the real one.

const fs = require('node:fs')
const path = require('node:path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(require('node:os').tmpdir(), '..', 'zen-shots')

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true })
  } catch {}
}

async function inPage(win, fn, args = []) {
  const src = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`
  return win.webContents.executeJavaScript(src, true)
}

async function shot(win, name) {
  ensureDir(SHOT_DIR)
  const img = await win.webContents.capturePage()
  const file = path.join(SHOT_DIR, `${name}.png`)
  fs.writeFileSync(file, img.toPNG())
  const { width, height } = img.getSize()
  console.log(`   shot: ${file}  (${width}x${height})`)
  return file
}

/** wait until the transcript stops changing — i.e. the answer has finished */
async function waitForAnswer(win, timeout = 180000) {
  const read = () =>
    inPage(win, function () {
      const els = Array.from(document.querySelectorAll('.prose-zen'))
      const last = els[els.length - 1]
      const t = last ? last.innerText || '' : ''
      const busy = !!document.querySelector('[data-busy], [aria-busy="true"]')
      const stop = Array.from(document.querySelectorAll('button')).some((b) =>
        /stop/i.test(b.getAttribute('aria-label') || b.title || ''),
      )
      return { len: t.length, text: t.slice(-60), busy: busy || stop }
    }).catch(() => ({ len: 0, text: '', busy: true }))

  const t0 = Date.now()
  let stable = 0
  let prev = -1
  while (Date.now() - t0 < timeout) {
    const s = await read()
    if (s.len > 0 && s.len === prev && !s.busy) {
      if (++stable >= 2) return s
    } else {
      stable = 0
    }
    prev = s.len
    await sleep(600)
  }
  console.log('   ! timed out waiting for the answer')
  return { len: prev }
}

function pageType(text) {
  const ta = document.querySelector('textarea')
  if (!ta) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, text)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.focus()
  return true
}

function pageSend() {
  const ta = document.querySelector('textarea')
  if (!ta) return false
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  return true
}

function pageOpenSettings() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))
  return true
}

function pageBlurComposer() {
  const ta = document.querySelector('textarea')
  if (ta) ta.blur()
  return true
}

/** the amber shortcut-conflict banner is honest but must not be in a screenshot */
function pageDismissBanner() {
  const banner = document.querySelector('[data-hotkey-banner]')
  if (!banner) return false
  const btn = Array.from(banner.querySelectorAll('button')).find(
    (b) => (b.getAttribute('title') || '') === 'Dismiss',
  )
  if (btn) {
    btn.click()
    return true
  }
  banner.remove()
  return true
}

/** put the latest question at the top so the shot shows a question AND its answer */
function pageScrollLastTurnTop() {
  const users = document.querySelectorAll('[data-msg][data-user]')
  const last = users[users.length - 1]
  if (!last) {
    // fall back to the newest message wrapper
    const all = document.querySelectorAll('[data-msg]')
    if (!all.length) return false
    all[all.length - 1].scrollIntoView({ block: 'start' })
    return true
  }
  last.scrollIntoView({ block: 'start' })
  return true
}

/** how many tool calls the last assistant turn made */
function pageToolCount() {
  const all = document.querySelectorAll('[data-msg]')
  const wrap = all[all.length - 1]
  if (!wrap) return 0
  return wrap.querySelectorAll('[data-tools] button').length
}

/** the thinking block auto-opens while streaming and stays open — fold it away */
function pageCollapseReasoning() {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    /^(Thought for|Thinking|Thoughts)/.test((b.textContent || '').trim()),
  )
  if (!btn) return false
  const chevron = btn.querySelector('svg:last-of-type')
  const isOpen = !!chevron && (chevron.getAttribute('class') || '').includes('rotate-90')
  if (!isOpen) return false
  btn.click()
  return true
}

/* ------------------------------------------- image generation, for proving it */

function pageClickButtonMatching(text, within) {
  const scope = within ? document.querySelector(within) : document
  if (!scope) return false
  const want = String(text).toLowerCase()
  const btn = Array.from(scope.querySelectorAll('button')).find((b) =>
    (b.textContent || '').toLowerCase().includes(want),
  )
  if (!btn) return false
  btn.click()
  return true
}

function pageFalStatus() {
  const el = document.querySelector('[data-fal-status]')
  return el ? { kind: el.getAttribute('data-fal-status'), text: (el.textContent || '').trim() } : null
}

function pageFalModelCount() {
  return document.querySelectorAll('[data-fal-model]').length
}

function pageSelectedFalModel() {
  const el = document.querySelector('[data-fal-model][data-selected="yes"]')
  return el ? { id: el.getAttribute('data-fal-model') } : null
}

function pageGenTest() {
  const el = document.querySelector('[data-gen-test]')
  return el ? { kind: el.getAttribute('data-gen-test'), text: (el.textContent || '').trim() } : null
}

function pageCloseSettings() {
  const root = document.querySelector('.fixed.inset-0.z-50')
  if (!root) return false
  root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  return true
}

function pageArmImageMode() {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    /Generate an image instead/.test(b.getAttribute('title') || ''),
  )
  if (!btn) return false
  btn.click()
  return true
}

/** what the last assistant turn is showing: rendered images, placeholders, an error */
function pageLastTurn() {
  const all = document.querySelectorAll('[data-msg]')
  const wrap = all[all.length - 1]
  if (!wrap) return null
  const err = wrap.querySelector('[data-msg-error]')
  return {
    images: wrap.querySelectorAll('[data-images] img').length,
    missing: wrap.querySelectorAll('[data-image-missing]').length,
    error: err ? (err.innerText || '').replace(/\s+/g, ' ').slice(0, 200) : '',
  }
}

/** titles for the seeded history, so the sidebar looks like a used app */
const SEED_TITLES = [
  'Debounce helper in TypeScript',
  'Refactor the upload endpoint',
  'Draft a release note',
  'Explain vector indexing',
  'Postgres index for a slow query',
]

function seedConversations(now) {
  return SEED_TITLES.map((title, i) => ({
    id: `seed-${i + 1}`,
    title,
    createdAt: now - (i + 2) * 3600_000,
    updatedAt: now - (i + 2) * 3600_000,
    messages: [
      { id: `seed-${i + 1}-u`, role: 'user', content: title, createdAt: now - (i + 2) * 3600_000 },
      {
        id: `seed-${i + 1}-a`,
        role: 'assistant',
        content: '(seed)',
        createdAt: now - (i + 2) * 3600_000 + 2000,
        finished: true,
      },
    ],
  }))
}

const HERO_PROMPT =
  'Write a short TypeScript debounce function in one code block. Then a table of three gotchas, one line each. Nothing else.'

const TOOLS_PROMPT = "What's the temperature in London right now? Use a tool and cite your source."

/** tidy the frame before capturing: no banner, no open thinking block, question at the top */
async function prepShot(win, label, { collapseReasoning = false } = {}) {
  const dismissed = await inPage(win, pageDismissBanner).catch(() => false)
  const collapsed = collapseReasoning
    ? await inPage(win, pageCollapseReasoning).catch(() => false)
    : false
  await sleep(500)
  const scrolled = await inPage(win, pageScrollLastTurnTop).catch(() => false)
  await inPage(win, pageBlurComposer).catch(() => false)
  await sleep(800)
  console.log(
    `   prep[${label}]: banner=${dismissed ? 'dismissed' : 'none'} ` +
      `folded=${collapsed} scrolled=${scrolled}`,
  )
}

async function run({ win, storePath, readStore, writeStore, apiKey }) {
  const shots = []

  // ---- seed an isolated profile: the real config, plus plausible history
  // prefer the real profile's config (presets, model prefs, search endpoint) so
  // the settings shot looks like a used install; the key always comes from argv
  // NOTE: the folder is WorkBuro. It was zen-chat before the rename, and while this said
  // 'zen-chat' the merge silently fell through to defaults on every capture run.
  const realStore = path.join(require('electron').app.getPath('appData'), 'WorkBuro', 'zen-chat-store.json')
  let base = readStore()
  try {
    if (fs.existsSync(realStore)) {
      const real = JSON.parse(fs.readFileSync(realStore, 'utf8'))
      base = { ...base, config: { ...base.config, ...real.config } }
      console.log('   merged config from the real profile')
    }
  } catch {
    console.log('   (real profile config unreadable — using defaults)')
  }
  const now = Date.now()
  const seeded = {
    ...base,
    config: {
      ...base.config,
      apiKey,
      // This run produces pictures for publication, so the endpoint and the model are pinned to
      // the hosted relay. Without this, the real profile's config (which may point at a model on
      // this machine) would be merged in and end up visible in a screenshot.
      baseUrl: 'https://opencode.ai/zen/go/v1',
      model: process.env.ZEN_SHOT_MODEL || 'deepseek-v4.1-flash',
      toolsEnabled: true,
      showUsage: true,
      thinking: true,
      // the session id is a real per-install identifier — never publish the real one
      affinityId: 'zen-chat-demo-0000',
      // the fal key is read from the environment, so it never rides on a command line
      imageGen: {
        ...(base.config.imageGen || {}),
        enabled: true,
        provider: 'fal',
        falKey: process.env.ZEN_FAL_KEY || base.config.imageGen?.falKey || '',
        model: process.env.ZEN_FAL_MODEL || 'fal-ai/flux/schnell',
        count: 1,
        size: 'square_hd',
      },
    },
    conversations: seedConversations(now),
    activeId: null,
    models: [],
  }
  writeStore(seeded)
  console.log(`   seeded ${seeded.conversations.length} history entries into ${storePath}`)

  // reload so the renderer picks up the seeded store
  await win.webContents.reload()
  await sleep(4000)

  // a wider window than the 485px default: the sidebar only renders inline
  // above the compact breakpoint, and the README needs to show it
  win.setBounds({ x: 120, y: 80, width: 1180, height: 800 })
  await sleep(1200)

  // ---- 1. the hero: a real question and a real answer
  await inPage(win, pageType, [HERO_PROMPT])
  await sleep(300)
  await inPage(win, pageSend)
  console.log('   asked the hero question, waiting for the answer...')
  const ans = await waitForAnswer(win)
  console.log(`   answer finished (${ans.len} chars)`)
  await sleep(600)
  await prepShot(win, 'app', { collapseReasoning: true })
  shots.push(await shot(win, 'readme-app'))

  // ---- 2. tools: a live tool call with citations
  await inPage(win, pageType, [TOOLS_PROMPT])
  await sleep(300)
  await inPage(win, pageSend)
  console.log('   asked the tool question, waiting for the answer...')
  await waitForAnswer(win)
  let used = await inPage(win, pageToolCount).catch(() => 0)
  if (!used) {
    console.log('   no tool call in that turn — retrying with a direct instruction')
    await inPage(win, pageType, ['Use the get_weather tool for London, UK, then cite the source you get.'])
    await sleep(300)
    await inPage(win, pageSend)
    await waitForAnswer(win)
    used = await inPage(win, pageToolCount).catch(() => 0)
  }
  console.log(`   tools used in the last turn: ${used}`)
  await sleep(600)
  await prepShot(win, 'tools')
  shots.push(await shot(win, 'readme-tools'))

  // ---- 3. settings, on the API & key pane
  await inPage(win, pageOpenSettings)
  await sleep(1200)
  const ok = await inPage(win, function () {
    const t = document.body.innerText || ''
    return t.includes('API base URL') && t.includes('Test connection')
  })
  console.log(`   settings modal open: ${ok}`)
  // the banner sits behind the modal and can show through at the edges
  await inPage(win, pageDismissBanner).catch(() => false)
  await sleep(500)
  shots.push(await shot(win, 'readme-settings'))

  // ---- 4. image generation: the settings pane, with a live model list
  console.log(
    `   image gen seeded: enabled=${seeded.config.imageGen?.enabled} ` +
      `key=${seeded.config.imageGen?.falKey ? 'present' : 'MISSING'}`,
  )
  await inPage(win, pageOpenSettings)
  await sleep(1200)
  console.log(
    `   opened the Images tab: ${await inPage(win, pageClickButtonMatching, [
      'Images',
      '.fixed.inset-0.z-50',
    ])}`,
  )
  let models = 0
  for (let i = 0; i < 20; i += 1) {
    models = await inPage(win, pageFalModelCount).catch(() => 0)
    if (models > 0) break
    await sleep(1000)
  }
  console.log(`   fal status: ${JSON.stringify(await inPage(win, pageFalStatus).catch(() => null))}`)
  console.log(`   models in the picker: ${models}`)
  console.log(`   selected: ${JSON.stringify(await inPage(win, pageSelectedFalModel).catch(() => null))}`)
  shots.push(await shot(win, 'readme-images'))

  // a real generation from the settings pane
  await inPage(win, pageClickButtonMatching, ['Generate one test image'])
  let gen = null
  for (let i = 0; i < 30; i += 1) {
    await sleep(1500)
    gen = await inPage(win, pageGenTest).catch(() => null)
    if (gen) break
  }
  console.log(`   test generation -> ${JSON.stringify(gen)}`)
  shots.push(await shot(win, 'verify-images-settings'))

  // ---- 5. the same thing through the composer, which is the real user path
  await inPage(win, pageCloseSettings)
  await sleep(900)
  const armed = await inPage(win, pageArmImageMode).catch(() => false)
  console.log(`   image mode armed in the composer: ${armed}`)
  await sleep(400)
  // A subject that draws well in one pass. This shot ends up in the README, and the old prompt
  // ("a single red dot centred on a white background") reliably came back with speckle.
  await inPage(win, pageType, ['a red fox in falling snow, soft winter light'])
  await sleep(400)
  await inPage(win, pageSend)
  let turn = null
  for (let i = 0; i < 40; i += 1) {
    await sleep(1500)
    turn = await inPage(win, pageLastTurn).catch(() => null)
    if (turn && (turn.error || turn.images)) break
  }
  console.log(`   composer turn -> ${JSON.stringify(turn)}`)
  shots.push(await shot(win, 'verify-images-composer'))

  // ---- 6. persistence: a saved generation must still render after a restart,
  // and a file the user deleted must say so rather than render a broken image
  const imgDir = path.join(path.dirname(storePath), 'images')
  fs.mkdirSync(imgDir, { recursive: true })
  const fixture = path.join(imgDir, 'zen-fixture-1.png')
  // build/icon.png exists in the source tree but is not inside the packaged asar, so this copy
  // worked from source and threw from a packaged build, crashing the run after every shot had
  // already been taken. The fixture is only a placeholder that has to render, so fall back to a
  // one pixel PNG instead.
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'build', 'icon.png'), fixture)
  } catch {
    fs.writeFileSync(fixture, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64'))
  }
  const persisted = readStore()
  const when = Date.now()
  persisted.config.imageGen = { ...persisted.config.imageGen, enabled: true }
  persisted.conversations = [
    {
      id: 'seed-image',
      title: 'A red fox in falling snow',
      createdAt: when,
      updatedAt: when,
      messages: [
        {
          id: 'seed-image-u',
          role: 'user',
          content: 'A red fox asleep in falling snow, cinematic',
          createdAt: when,
        },
        {
          id: 'seed-image-a',
          role: 'assistant',
          content: '',
          model: 'fal-ai/flux/schnell',
          note: 'fal · 1.4s',
          images: [
            { name: 'zen-fixture-1.png', path: fixture, url: '', width: 512, height: 512, bytes: 4813 },
            { name: 'zen-deleted.png', path: path.join(imgDir, 'zen-deleted.png'), url: '', width: 512, height: 512 },
          ],
          createdAt: when,
          finished: true,
        },
      ],
    },
    ...persisted.conversations,
  ]
  persisted.activeId = 'seed-image'
  writeStore(persisted)
  await win.webContents.reload()
  await sleep(4500)
  const after = await inPage(win, pageLastTurn).catch(() => null)
  console.log(`   after a restart -> ${JSON.stringify(after)}`)
  console.log('   (expected: 1 rendered image restored from disk, 1 missing-file placeholder)')
  shots.push(await shot(win, 'verify-images-persist'))

  console.log(`\ncaptured ${shots.length} screenshot(s) into ${SHOT_DIR}`)
  return shots
}

module.exports = { run, SHOT_DIR }
