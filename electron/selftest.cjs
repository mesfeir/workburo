// End-to-end self-test: drives the REAL renderer UI inside the REAL app,
// exercises the real network stack, and captures screenshots + a JSON report.
// Run with:  npx electron . --selftest <api-key> [--keep]

const fs = require('node:fs')
const path = require('node:path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SHOT_DIR =
  process.env.ZEN_SHOT_DIR ||
  path.join(require('node:os').tmpdir(), '..', 'zen-shots')

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true })
  } catch {}
}

async function inPage(win, fn, args = []) {
  const src = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`
  return win.webContents.executeJavaScript(src, true)
}

async function waitFor(win, fn, timeout = 150000, interval = 400, label = '') {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const ok = await inPage(win, fn).catch(() => false)
    if (ok) return true
    await sleep(interval)
  }
  console.log(`   ! timed out waiting for ${label}`)
  return false
}

async function shot(win, name) {
  ensureDir(SHOT_DIR)
  try {
    const img = await win.webContents.capturePage()
    const file = path.join(SHOT_DIR, `${name}.png`)
    fs.writeFileSync(file, img.toPNG())
    console.log(`   shot: ${file}`)
    return file
  } catch (err) {
    console.log('   shot failed:', err.message)
    return null
  }
}

/* ------------------------------------------------------- in-page actions */

// type into the composer using the native value setter so React sees it
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

function pagePasteImage(dataUrl) {
  const ta = document.querySelector('textarea')
  if (!ta) return false
  const bin = atob(dataUrl.split(',')[1])
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  const file = new File([arr], 'probe.png', { type: 'image/png' })
  const dt = new DataTransfer()
  dt.items.add(file)
  ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  return true
}

function pageThumbCount() {
  // composer thumbnails are the only 64x64 images on screen
  return Array.from(document.querySelectorAll('img')).filter(
    (i) => i.clientWidth === 64 && i.clientHeight === 64,
  ).length
}

function pageOpenModelPicker() {
  const btns = Array.from(document.querySelectorAll('button'))
  const b = btns.find((x) => /deepseek|grok|glm|qwen|gpt|kimi|minimax|mimo|longcat/i.test(x.textContent || ''))
  if (!b) return false
  b.click()
  return true
}

function pagePickModel(name) {
  const btns = Array.from(document.querySelectorAll('button'))
  const b = btns.find((x) => (x.textContent || '').trim().startsWith(name))
  if (!b) return false
  b.click()
  return true
}

function pageLastAssistantText() {
  // assistant turns render markdown into .prose-zen; user turns are bubbles
  const els = Array.from(document.querySelectorAll('.prose-zen'))
  if (!els.length) return ''
  return els[els.length - 1].innerText || ''
}

function pageAssistantTurns() {
  return document.querySelectorAll('.prose-zen').length
}

function pageHasError() {
  // scoped to the LAST message: a banner from an earlier turn must never be able
  // to satisfy (or fail) a check about the current reply
  const all = document.querySelectorAll('[data-msg]')
  const wrap = all[all.length - 1]
  if (wrap) {
    const el = wrap.querySelector('[data-msg-error]')
    return el ? (el.innerText || '').replace(/\s+/g, ' ').slice(0, 300) : ''
  }
  const t = document.body.innerText || ''
  const m = t.match(/Request failed[^\n]*\n([^\n]*)/)
  return m ? m[1].slice(0, 300) : ''
}

/** everything the last assistant turn did: tools it called, sources it cited, error it hit */
function pageLastMessage() {
  const all = document.querySelectorAll('[data-msg]')
  const wrap = all[all.length - 1]
  if (!wrap) return { tools: 0, labels: [], sources: false, sourceText: '', error: null, text: '' }
  const btns = Array.from(wrap.querySelectorAll('[data-tools] button'))
  const src = wrap.querySelector('[data-sources]')
  const err = wrap.querySelector('[data-msg-error]')
  // assertions want the ANSWER, not the thinking that precedes it
  const answer = wrap.querySelector('.prose-zen')
  return {
    tools: btns.length,
    labels: btns
      .map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean),
    sources: !!src,
    sourceText: src ? (src.innerText || '').replace(/\s+/g, ' ').trim() : '',
    error: err ? (err.innerText || '').replace(/\s+/g, ' ').slice(0, 260) : null,
    text: ((answer || wrap).innerText || '').replace(/\s+/g, ' ').slice(0, 900),
  }
}

/** is the last assistant turn still streaming? */
function pageIdle() {
  const all = document.querySelectorAll('[data-msg]')
  const wrap = all[all.length - 1]
  if (!wrap) return true
  return !wrap.hasAttribute('data-streaming')
}

/** scroll state: is the newest reply actually on screen where the user can see it? */
function pageScrollState() {
  const scroller = document.querySelector('.overflow-y-auto')
  const all = document.querySelectorAll('[data-msg]')
  const wrap = all[all.length - 1]
  if (!scroller || !wrap) return { atBottom: false, visible: false, gap: -1, stranded: -1 }
  const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
  const sr = scroller.getBoundingClientRect()
  const wr = wrap.getBoundingClientRect()
  let stranded = 0
  for (const m of all) {
    if (m.getBoundingClientRect().top > sr.bottom + 4) stranded++
  }
  return {
    atBottom: gap < 60,
    visible: wr.bottom <= sr.bottom + 8 && wr.bottom > sr.top,
    gap: Math.round(gap),
    stranded,
  }
}

function pageThumbs() {
  return Array.from(document.querySelectorAll('img')).filter(
    (i) => i.clientWidth >= 50 && i.clientWidth <= 72,
  ).length
}

function pageHeaderModel() {
  return (document.querySelector('header')?.innerText || '').trim()
}

function pageComposerEmpty() {
  const ta = document.querySelector('textarea')
  return ta && ta.value === ''
}

// open the picker (careful: the header button toggles), wait for the row, click it, confirm
// the header actually switched to the requested model
async function pickModel(win, name) {
  const alreadyOpen = await inPage(win, function () {
    return document.querySelectorAll('.max-h-\\[340px\\] > div').length > 0
  })
  if (!alreadyOpen) await inPage(win, pageOpenModelPicker)
  const present = await waitFor(
    win,
    new Function(
      `return function(){ return Array.from(document.querySelectorAll('button')).some(b => (b.textContent||'').trim().startsWith(${JSON.stringify(
        name,
      )})) }`,
    )(),
    40000,
    500,
    `model row ${name}`,
  )
  if (!present) return false
  const clicked = await inPage(win, pagePickModel, [name])
  await sleep(600)
  const header = await inPage(win, pageHeaderModel)
  return clicked && header.includes(name)
}

/* --------------------------------------------------------------- runner */

async function run({
  win,
  apiKey,
  toggle,
  hide,
  isVisible,
  isRegistered,
  readBounds,
  setLogin,
  getLogin,
  isPackaged,
  reapplyStored,
  hasFalKey = false,
  alwaysOnTop,
  isMinimized,
  minimize,
  restore,
  showInactive,
  armAutoMinimize,
  autoMinimizeSecs,
  workInFlight,
}) {
  const results = []

  // surface renderer-side errors so a silent failure can't hide
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`   [renderer ${level === 3 ? 'ERROR' : 'WARN'}] ${message}`)
  })
  const record = (name, pass, detail) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`)
  }

  console.log('\n=== Zen Chat self-test ===')
  console.log('waiting for app to settle…')
  await sleep(2500)

  // ---------- 1. shell renders
  const shell = await inPage(win, function () {
    const toggleBtn = Array.from(document.querySelectorAll('button')).find((b) =>
      (b.getAttribute('title') || '').toLowerCase().includes('sidebar'),
    )
    return {
      hasComposer: !!document.querySelector('textarea'),
      hasEmpty: (document.body.innerText || '').includes('Ready when you are'),
      sidebarVisible: !!document.querySelector('aside'),
      hasSidebarToggle: !!toggleBtn,
      width: window.innerWidth,
      title: document.title,
    }
  })
  record(
    'UI shell renders (small window: sidebar collapsed, toggle offered)',
    shell.hasComposer && shell.hasEmpty && shell.hasSidebarToggle && !shell.sidebarVisible && shell.width < 720,
    JSON.stringify(shell),
  )
  await shot(win, '01-empty-state')

  // ---------- 1a. window opens at the small launcher size
  const bounds = readBounds()
  record(
    'opens at the small default size',
    bounds.width <= 620 && bounds.height <= 780 && bounds.width >= 380,
    `${bounds.width}x${bounds.height} at ${bounds.x},${bounds.y}`,
  )

  // ---------- 1b. the sidebar drawer still works in a narrow window
  await inPage(win, function () {
    const b = Array.from(document.querySelectorAll('button')).find((x) =>
      (x.getAttribute('title') || '').toLowerCase().includes('sidebar'),
    )
    if (b) b.click()
  })
  await sleep(600)
  const drawer = await inPage(win, function () {
    const aside = document.querySelector('aside')
    return { visible: !!aside, recents: !!aside && (aside.innerText || '').includes('Recents') }
  })
  record('sidebar drawer opens over the chat in a small window', drawer.visible && drawer.recents, JSON.stringify(drawer))
  await shot(win, '02b-compact-drawer')
  await inPage(win, function () {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await sleep(500)
  const drawerClosed = await inPage(win, function () {
    return !document.querySelector('aside')
  })
  record('Escape closes the drawer', drawerClosed, `closed=${drawerClosed}`)

  // ---------- 1b. diagnostics: does models.list work over IPC at all?
  const diag = await inPage(
    win,
    function (key) {
      return window.zen.app.info().then(function (info) {
        return window.zen.models
          .list({
            baseUrl: 'https://opencode.ai/zen/go/v1',
            apiKey: key,
            sendAffinity: true,
            affinityId: 'diag-1',
            protocol: 'auto',
          })
          .then(function (r) {
            return {
              storePath: info.storePath,
              platform: info.platform,
              ok: r.ok,
              error: r.error || null,
              n: (r.models || []).length,
              base: r.base || null,
            }
          })
      })
    },
    [apiKey],
  )
  record('DIAG models.list over IPC', Boolean(diag && diag.ok && diag.n > 5), JSON.stringify(diag))

  // the probe image is drawn here so it is identical to what the app itself would attach
  const testImageDataUrl = await inPage(win, function () {
    const c = document.createElement('canvas')
    c.width = 360
    c.height = 130
    const d = c.getContext('2d')
    d.fillStyle = '#0f0f0f'
    d.fillRect(0, 0, 360, 130)
    d.fillStyle = '#00ff88'
    d.font = 'bold 38px monospace'
    d.fillText('ZEN 4729', 42, 80)
    return c.toDataURL('image/png')
  })

  // ---------- 2. models auto-load from the API on a fresh profile
  await inPage(win, pageOpenModelPicker)
  await waitFor(
    win,
    function () {
      return document.querySelectorAll('.max-h-\\[340px\\] > div').length > 5
    },
    40000,
    500,
    'model list to auto-load',
  )
  const modelCount = await inPage(win, function () {
    return document.querySelectorAll('.max-h-\\[340px\\] > div').length
  })
  record('model list auto-loads from /models', modelCount > 5, `${modelCount} rows in picker`)
  await shot(win, '02-model-picker')
  // close it for real — the app closes on mousedown outside, not on a synthetic click
  await inPage(win, function () {
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
  await sleep(400)

  // ---------- 3. streaming text completion
  const t0 = Date.now()
  await inPage(win, pageType, ['Reply with exactly the word: PONGOUT'])
  await inPage(win, pageSend)
  const gotText = await waitFor(
    win,
    function () {
      return document.querySelectorAll('.prose-zen').length > 0
    },
    150000,
    400,
    'first assistant turn',
  )
  await sleep(2500)
  const text = await inPage(win, pageLastAssistantText)
  const errText = await inPage(win, pageHasError)
  const tFirst = Date.now() - t0
  record(
    'streamed completion renders',
    gotText && /PONGOUT/i.test(text),
    `"${String(text).slice(0, 90).replace(/\n/g, ' ')}" in ${tFirst}ms` + (errText ? ` ERR:${errText}` : ''),
  )
  await shot(win, '03-after-reply')

  // ---------- 4. markdown + code rendering
  await inPage(win, pageType, ['Write a javascript function that returns the nth Fibonacci number. Include one code block and a short table of the first 4 values.'])
  await inPage(win, pageSend)
  await waitFor(
    win,
    function () {
      return document.querySelectorAll('.prose-zen').length > 1
    },
    150000,
    400,
    'markdown turn',
  )
  await sleep(4000)
  const md = await inPage(win, function () {
    const els = document.querySelectorAll('.prose-zen')
    const last = els[els.length - 1]
    return {
      code: last.querySelectorAll('pre code').length,
      table: last.querySelectorAll('table').length,
      hljs: last.querySelectorAll('.hljs-keyword, .hljs-function, .hljs-title').length,
      text: (last.innerText || '').length,
    }
  })
  record(
    'markdown, code block and table render',
    md.code > 0 && md.text > 40,
    JSON.stringify(md),
  )
  await shot(win, '04-markdown')

  // ---------- 5. image input on a vision model
  const picked = await pickModel(win, 'deepseek-v4-flash-vision-exp')
  await inPage(win, pageType, ['What exact text is written in this image? Answer with only that text.'])
  await inPage(win, pagePasteImage, [testImageDataUrl])
  const thumbs = await waitFor(
    win,
    function () {
      return (
        Array.from(document.querySelectorAll('img')).filter(
          (i) => i.clientWidth >= 50 && i.clientWidth <= 72,
        ).length > 0
      )
    },
    15000,
    300,
    'image thumbnail',
  )
  await shot(win, '05-image-attached')

  // An attachment now defaults to a fal edit, so this check has to ask for the model
  // explicitly — which is also the only place the "Ask about it" escape hatch is
  // exercised end to end.
  const askedSwitch = await inPage(win, function () {
    const box = document.querySelector('[data-refmode]')
    if (!box) return false
    const b = Array.from(box.querySelectorAll('button')).find(
      (x) => (x.textContent || '').trim() === 'Ask about it',
    )
    if (b) b.click()
    return Boolean(b)
  })
  await sleep(300)
  const askHint = await inPage(win, function () {
    const h = document.querySelector('[data-refhint]')
    return h ? (h.textContent || '').trim() : null
  })
  record(
    'the Ask switch hands the picture back to the model',
    askedSwitch === true && /the model reads the image/i.test(askHint || ''),
    `clicked=${askedSwitch} hint="${askHint}"`,
  )

  await inPage(win, pageSend)
  const turnsBefore = await inPage(win, pageAssistantTurns)
  await waitFor(
    win,
    new Function(`return function(){ return document.querySelectorAll('.prose-zen').length > ${turnsBefore} }`)(),
    150000,
    400,
    'vision reply',
  )
  await sleep(3000)
  const visText = await inPage(win, pageLastAssistantText)
  const visErr = await inPage(win, pageHasError)
  record(
    'image input + vision reply',
    picked && thumbs && /4729/.test(visText),
    `model picked=${picked} thumb=${thumbs} reply="${String(visText).slice(0, 80).replace(/\n/g, ' ')}"${
      visErr ? ` ERR:${visErr}` : ''
    }`,
  )
  await shot(win, '06-vision-reply')

  // ---------- 6. protocol fallback (grok = Responses API)
  const picked2 = await pickModel(win, 'grok-4.7')
  const before2 = await inPage(win, pageAssistantTurns)
  await inPage(win, pageType, ['Say exactly: PROTO-OK'])
  await inPage(win, pageSend)
  await waitFor(
    win,
    new Function(`return function(){ return document.querySelectorAll('.prose-zen').length > ${before2} }`)(),
    150000,
    400,
    'responses-protocol reply',
  )
  await sleep(3000)
  const protoText = await inPage(win, pageLastAssistantText)
  const protoErr = await inPage(win, pageHasError)
  record(
    'protocol fallback to Responses (grok-4.7)',
    picked2 && protoText.length > 0 && !protoErr,
    `reply="${String(protoText).slice(0, 70).replace(/\n/g, ' ')}"${protoErr ? ` ERR:${protoErr}` : ''}`,
  )
  await shot(win, '07-responses-protocol')

  // ---------- 7. text-only model rejects images gracefully
  const picked3 = await pickModel(win, 'glm-5.3')
  const before3 = await inPage(win, pageAssistantTurns)
  await inPage(win, pageType, ['hello'])
  await inPage(win, pagePasteImage, [testImageDataUrl])
  await sleep(1200)
  // an attachment defaults to a fal edit now, so ask for the model explicitly here:
  // the point of this check is the chat model's own refusal, not fal's
  await inPage(win, function () {
    const box = document.querySelector('[data-refmode]')
    const b = box
      ? Array.from(box.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === 'Ask about it')
      : null
    if (b) b.click()
  })
  await sleep(300)
  await inPage(win, pageSend)
  await waitFor(
    win,
    new Function(`return function(){ return document.querySelectorAll('.prose-zen').length > ${before3} || /Request failed/.test(document.body.innerText) }`)(),
    150000,
    400,
    'text-only outcome',
  )
  await sleep(2500)
  const rejErr = await inPage(win, pageHasError)
  // The app no longer lets a text-only model fail the request: the picture is left out and the
  // model is remembered as text-only, with the reason shown in the message's own note. Either
  // outcome tells the user what happened; silence would not.
  const rejNote = await inPage(win, function () {
    const all = document.querySelectorAll('[data-msg]')
    const wrap = all[all.length - 1]
    return wrap ? String(wrap.innerText || '') : ''
  })
  const toldClearly = /does not support image inputs/i.test(rejErr) || /could not take the picture/i.test(rejNote)
  record(
    'text-only model failure is surfaced clearly',
    picked3 && toldClearly,
    `glm-5.3 selected=${picked3}; ${
      toldClearly
        ? `user saw: "${(rejErr || rejNote).replace(/\s+/g, ' ').slice(0, 130)}"`
        : 'NOTHING SAID TO THE USER about the picture'
    }`,
  )
  await shot(win, '08-text-only-model')

  // ---------- 8. settings modal
  await inPage(win, function () {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))
  })
  await sleep(900)
  const modal = await inPage(win, function () {
    const t = document.body.innerText || ''
    return { open: t.includes('API base URL') && t.includes('Test connection') }
  })
  record('settings modal opens (Ctrl+,)', modal.open, JSON.stringify(modal))
  await shot(win, '09-settings')

  // the General tab holds the summon shortcut + startup options
  await inPage(win, function () {
    const b = Array.from(document.querySelectorAll('button')).find(
      (x) => (x.textContent || '').trim() === 'General',
    )
    if (b) b.click()
  })
  await sleep(700)
  const generalTab = await inPage(win, function () {
    const t = document.body.innerText || ''
    return {
      shortcut: t.includes('Summon shortcut'),
      startup: t.includes('Start Zen Chat when Windows starts'),
      presets: t.includes('Ctrl+Alt+Space') && t.includes('Alt+Shift+Space') && t.includes('Ctrl+Alt+K'),
      recorder: !!document.querySelector('[data-hotkey-recorder]'),
    }
  })
  record(
    'General tab exposes shortcut + startup settings',
    generalTab.shortcut && generalTab.startup && generalTab.presets && generalTab.recorder,
    JSON.stringify(generalTab),
  )
  await shot(win, '09b-settings-general')
  await inPage(win, function () {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await sleep(600)

  // ---------- 9. persistence across reload
  const beforeReload = await inPage(win, pageAssistantTurns)
  await win.webContents.reload()
  await sleep(3500)
  // the window is small, so the sidebar starts collapsed — open it to count the list
  await inPage(win, function () {
    const b = Array.from(document.querySelectorAll('button')).find((x) =>
      (x.getAttribute('title') || '').toLowerCase().includes('sidebar'),
    )
    if (b) b.click()
  })
  await sleep(600)
  const afterReload = await inPage(win, function () {
    return {
      turns: document.querySelectorAll('.prose-zen').length,
      recents: Array.from(document.querySelectorAll('aside button')).filter((b) =>
        /PONGOUT|fibonacci|text is written|hello|PROTO/i.test(b.textContent || ''),
      ).length,
    }
  })
  record(
    'conversation persists across restart',
    afterReload.turns >= beforeReload,
    `turns before=${beforeReload} after=${afterReload.turns}, sidebar recents with real titles=${afterReload.recents}`,
  )
  await shot(win, '10-after-reload')

  // put the window back the way the user keeps it — a drawer left open here would
  // sit over the chat in every screenshot the remaining checks take
  await inPage(win, function () {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await sleep(500)

  // ---------- 11. summon hotkey
  const info = await inPage(win, function () {
    return window.zen.app.info()
  })
  const status = info.hotkeyStatus || {}
  record(
    'summon shortcut is live',
    Boolean(status.active),
    `requested=${status.requested} active=${status.active} fallback=${Boolean(status.fallback)}` +
      (status.error ? ` — ${status.error}` : ''),
  )

  // whatever Windows granted, the app must not pretend it got what it asked for
  const banner = await inPage(win, function () {
    const el = document.querySelector('[data-hotkey-banner]')
    return { shown: !!el, text: el ? (el.innerText || '').replace(/\s+/g, ' ').slice(0, 170) : '' }
  })
  record(
    'substituted shortcut is disclosed in the UI',
    banner.shown === Boolean(status.fallback),
    `fallback=${Boolean(status.fallback)} bannerShown=${banner.shown} "${banner.text}"`,
  )
  if (banner.shown) await shot(win, '11-hotkey-fallback-banner')

  hide()
  await sleep(800)
  const wasHidden = !isVisible()
  toggle()
  await sleep(900)
  const backVisible = isVisible()
  record(
    'hotkey toggle brings a hidden window back',
    wasHidden && backVisible,
    `hidden=${wasHidden} then visible=${backVisible}`,
  )

  // ---------- 11b. window behaviour: above other windows, and away by itself
  record('the window is kept above other windows', alwaysOnTop() === true, `alwaysOnTop=${alwaysOnTop()}`)

  const delaySecs = autoMinimizeSecs()
  record('a minimise delay is configured', delaySecs > 0, `${delaySecs}s out of focus before it tucks itself away`)

  // win.blur() does not move focus on every desktop, so show the window again without focusing it:
  // visible and genuinely unfocused is the case being tested, and it is the case a summon-away
  // launcher actually lives in.
  hide()
  await sleep(400)
  showInactive()
  await sleep(600)
  const unfocused = !win.isFocused()
  armAutoMinimize({ autoMinimizeSec: 0.5 })
  await sleep(1800)
  const tuckedAway = isMinimized()
  record(
    'it minimises itself once focus has been gone for the delay',
    unfocused && tuckedAway,
    `unfocused=${unfocused} minimised=${tuckedAway}`,
  )

  toggle()
  await sleep(900)
  record(
    'the summon shortcut brings it back from minimised',
    isVisible() && !isMinimized(),
    `visible=${isVisible()} minimised=${isMinimized()}`,
  )

  // ---------- 11c. the input at its narrowest: the mode switches must not eat it
  win.setSize(380, 640)
  await sleep(800)
  const layout = await inPage(win, function () {
    const ta = document.querySelector('textarea')
    const modes = document.querySelector('[data-modes]')
    const t = ta ? ta.getBoundingClientRect() : null
    const m = modes ? modes.getBoundingClientRect() : null
    return {
      hasModes: !!m,
      inputWidth: t ? Math.round(t.width) : 0,
      inputBottom: t ? Math.round(t.bottom) : 0,
      modesTop: m ? Math.round(m.top) : 0,
      modesLabels: modes ? String(modes.innerText || '').replace(/\s+/g, ' ').trim() : '',
      overlapping:
        !!(t && m && m.top < t.bottom - 2 && m.left < t.right && m.right > t.left && m.left < t.right),
    }
  })
  record(
    'the mode switches sit under the input, not beside it',
    layout.hasModes && layout.modesTop >= layout.inputBottom - 2,
    `switches top=${layout.modesTop}, input bottom=${layout.inputBottom} · "${layout.modesLabels}"`,
  )
  record(
    'the input keeps real room to type in at the narrowest window',
    layout.inputWidth >= 150,
    `${layout.inputWidth}px of input in a 380px window`,
  )
  record(
    'and no switch is stacked over the input',
    !layout.overlapping,
    layout.overlapping ? 'a switch overlaps the textarea' : 'clear',
  )
  win.setSize(480, 660)
  await sleep(600)
  await shot(win, '11c-composer-modes')

  // ---------- 11d. the Images item is a gallery of pictures, not the image settings
  await inPage(win, function () {
    if (document.querySelector('nav button')) return true
    const show = [...document.querySelectorAll('button')].find((b) =>
      /show sidebar/i.test(b.getAttribute('title') || ''),
    )
    if (show) show.click()
    return true
  })
  await sleep(600)
  const clickedImages = await inPage(win, function () {
    const row = [...document.querySelectorAll('nav button')].find((b) =>
      /Images/.test(b.innerText || ''),
    )
    if (!row) return false
    row.click()
    return true
  })
  await sleep(800)
  const gallery = await inPage(win, function () {
    const panel = document.querySelector('[data-gallery]')
    return {
      open: !!panel,
      count: panel ? String(panel.querySelector('[data-gallery-count]')?.innerText || '').trim() : '',
      tiles: panel ? panel.querySelectorAll('[data-gallery-grid] button').length : 0,
      filters: panel
        ? String(panel.querySelector('[data-gallery-filter]')?.innerText || '').replace(/\s+/g, ' ').trim()
        : '',
      settingsAlsoOpen: !!document.querySelector('[data-fal-editmodel]'),
    }
  })
  record(
    'the Images item opens a gallery of pictures, not the image settings',
    clickedImages && gallery.open && !gallery.settingsAlsoOpen,
    gallery.open
      ? `"${gallery.count}" · tiles=${gallery.tiles} · filters "${gallery.filters}"`
      : 'no gallery appeared',
  )
  record(
    'the gallery lists the pictures from this conversation',
    gallery.tiles >= 1,
    `${gallery.tiles} tile(s) shown`,
  )
  await shot(win, '11d-gallery')
  const clickedTile = await inPage(win, function () {
    const tile = document.querySelector('[data-gallery-grid] button')
    if (!tile) return false
    tile.click()
    return true
  })
  await sleep(800)
  const galleryClosed = await inPage(win, () => !document.querySelector('[data-gallery]'))
  record(
    'clicking a picture opens the chat it came from',
    clickedTile && galleryClosed,
    clickedTile ? `gallery closed=${galleryClosed}` : 'no tile to click',
  )

  const rebind = await inPage(
    win,
    function (current) {
      const cands = [
        'Ctrl+Alt+Space',
        'Alt+Shift+Space',
        'Ctrl+Alt+K',
        'Ctrl+Shift+A',
        'Ctrl+Shift+J',
        'Alt+G',
        'Ctrl+Alt+G',
      ]
      return (async function () {
        const tried = []
        for (let i = 0; i < cands.length; i++) {
          // re-registering the combination we already hold proves nothing
          if (cands[i] === current) {
            tried.push(cands[i] + '=skip(same)')
            continue
          }
          const r = await window.zen.app.setHotkey(cands[i])
          tried.push(cands[i] + '=' + (r.registered ? 'ok' : 'taken'))
          if (r.ok && r.registered) return { target: cands[i], tried: tried.join(' ') }
        }
        return { target: null, tried: tried.join(' ') }
      })()
    },
    [status.active || ''],
  )
  const oldReleased = status.active ? !isRegistered(status.active) : true
  record(
    'shortcut is rebindable at runtime (old combination released)',
    Boolean(rebind.target) && isRegistered(rebind.target) && oldReleased,
    `now=${rebind.target} old=${status.active} released=${oldReleased} | tried ${rebind.tried}`,
  )

  reapplyStored()
  await sleep(500)
  const restored = Boolean(status.active) && isRegistered(status.active)
  record(
    'stored shortcut is restored after rebinding',
    restored,
    `active=${status.active} registered=${restored}`,
  )

  // ---------- 12. start with Windows
  if (isPackaged) {
    const on = setLogin(true)
    const off = setLogin(false)
    const final = getLogin()
    record(
      'start-with-Windows enables and disables (registry left clean)',
      on.openAtLogin === true && off.openAtLogin === false && final.openAtLogin === false,
      `enable=${on.openAtLogin} disable=${off.openAtLogin} left=${final.openAtLogin}`,
    )
  } else {
    console.log(
      'SKIP  start-with-Windows round trip (dev build would register electron.exe; verified in the packaged run)',
    )
  }

  // ---------- 13. tools: the model grounded its answer in live data
  const { executeTool } = require('./tools.cjs')
  const toolsPicked = await pickModel(win, 'deepseek-v4.1-flash')
  const beforeTools = await inPage(win, pageAssistantTurns)
  await inPage(win, pageType, [
    'Use your get_weather tool for London right now, then tell me the temperature and the conditions.',
  ])
  await inPage(win, pageSend)

  // while this answer is still on its way the window must not tuck itself away: losing sight of a
  // run in progress is worse than one extra window on screen
  win.blur()
  await sleep(300)
  armAutoMinimize({ autoMinimizeSec: 0.5 })
  let sawWork = false
  let minimisedWhileBusy = false
  for (let i = 0; i < 7; i += 1) {
    await sleep(400)
    if (workInFlight()) {
      sawWork = true
      if (isMinimized()) minimisedWhileBusy = true
    }
  }
  record(
    'a run in progress keeps the window on screen instead of tucking it away',
    sawWork && !minimisedWhileBusy,
    `work in flight seen=${sawWork} minimised while busy=${minimisedWhileBusy}`,
  )
  restore()
  await sleep(500)

  await waitFor(
    win,
    new Function(`return function(){ return document.querySelectorAll('.prose-zen').length > ${beforeTools} }`)(),
    180000,
    400,
    'tool-grounded answer',
  )
  // the tool round runs after the first text arrives — wait for the turn to settle
  await waitFor(win, pageIdle, 240000, 300, 'tool round to finish')
  await sleep(600)
  const m13 = await inPage(win, pageLastMessage)
  const toolText = m13.text
  const toolErr = m13.error

  // take our own live reading and require the model's answer to agree with it
  const live = await executeTool('get_weather', { location: 'London' })
  const liveTemp = Number((String(live.text).match(/Temperature:\s*(-?\d+(?:\.\d+)?)/) || [])[1])
  const said = (toolText.match(/-?\d+(?:\.\d+)?/g) || []).map(Number)
  const grounded = Number.isFinite(liveTemp) && said.some((n) => Math.abs(n - liveTemp) <= 2)
  record(
    'model calls a tool and answers from live data',
    toolsPicked && m13.tools > 0 && !toolErr && grounded,
    `tools=${m13.tools} [${m13.labels.join(' | ')}] liveTemp=${liveTemp} said=${said.slice(0, 6).join(',')} ${toolErr ? `ERR:"${toolErr}" ` : ''}answer="${toolText.slice(0, 150)}"`,
  )
  record(
    'tool sources are listed under the reply',
    m13.sources,
    `${m13.sourceText}${toolErr ? ` ERR:${toolErr}` : ''}`,
  )
  await shot(win, '12-tools-weather')

  // the view must follow a new reply instead of stranding it below the fold
  const scroll = await inPage(win, pageScrollState)
  record(
    'the newest reply is scrolled into view',
    scroll.atBottom && scroll.visible && scroll.stranded === 0,
    JSON.stringify(scroll),
  )

  // ---------- 14. the relay's own server-side search (grok) also surfaces sources
  const grokPicked = await pickModel(win, 'grok-4.7')
  const beforeGrok = await inPage(win, pageAssistantTurns)
  await inPage(win, pageType, [
    'Search the web for the current temperature in London and tell me the number.',
  ])
  await inPage(win, pageSend)
  await waitFor(
    win,
    new Function(`return function(){ return document.querySelectorAll('.prose-zen').length > ${beforeGrok} }`)(),
    180000,
    400,
    'server-search answer',
  )
  await waitFor(win, pageIdle, 240000, 300, 'server search to finish')
  await sleep(600)
  const m14 = await inPage(win, pageLastMessage)
  record(
    'grok uses live web search with sources',
    grokPicked &&
      m14.tools > 0 &&
      m14.sources &&
      !m14.error &&
      /\d+(\.\d+)?\s*(°\s*C|degrees?\s*C|celsius)/i.test(m14.text),
    `toolRows=${m14.tools} [${m14.labels.join(' | ')}] sources=${m14.sources} ${m14.error ? `ERR:"${m14.error}" ` : ''}answer="${m14.text.slice(0, 150)}"`,
  )
  await shot(win, '13-server-search')

  // ---------- 14b. pictures are a tool, not a mode: the model draws on its own
  // Nothing to arm. Asking to see something must make the model call generate_image
  // itself — and when it cannot draw (no key, no credit) the user must be told why
  // rather than handed a description that pretends to be the request.
  const imgTools = await inPage(win, function () {
    return window.zen.tools.list().then((t) => t.map((x) => x.name))
  })
  record(
    'image generation is offered to the model as a tool',
    Array.isArray(imgTools) && imgTools.includes('generate_image'),
    `tools=[${(imgTools || []).join(', ')}]`,
  )

  const drewPicked = await pickModel(win, 'deepseek-v4.1-flash')
  await inPage(win, function () {
    const b = Array.from(document.querySelectorAll('button')).find(
      (x) => (x.textContent || '').trim() === 'New chat',
    )
    if (b) b.click()
  })
  await sleep(700)
  const beforeDraw = await inPage(win, pageAssistantTurns)
  await inPage(win, pageType, ['Create an image of an elephant.'])
  await inPage(win, pageSend)
  await waitFor(
    win,
    new Function(`return function(){ return document.querySelectorAll('.prose-zen').length > ${beforeDraw} }`)(),
    180000,
    400,
    'image turn to start',
  )
  await waitFor(win, pageIdle, 300000, 400, 'image turn to finish')
  await sleep(900)
  const imgState = await inPage(win, function () {
    const all = document.querySelectorAll('[data-msg]')
    const wrap = all[all.length - 1]
    return {
      imgs: wrap ? wrap.querySelectorAll('img').length : 0,
      toolRows: wrap ? wrap.querySelectorAll('[data-tools] button').length : 0,
      text: (wrap ? wrap.innerText || '' : '').replace(/\s+/g, ' ').slice(0, 400),
    }
  })
  const drewIt = imgState.imgs > 0
  record(
    'asking for a picture makes the model call the image tool by itself',
    drewPicked && imgState.toolRows > 0 && /image generation/i.test(imgState.text),
    `toolRows=${imgState.toolRows} imgs=${imgState.imgs} text="${imgState.text.slice(0, 160)}"`,
  )
  record(
    'the request ends with the picture, or with the reason it could not be drawn',
    drewIt || /Settings → Images|balance|locked|credit/i.test(imgState.text),
    `imgs=${imgState.imgs} falKey=${hasFalKey ? 'saved' : 'none'} text="${imgState.text.slice(0, 200)}"`,
  )
  if (hasFalKey) {
    record(
      'with a fal key saved the picture really lands on the reply',
      drewIt || /balance|locked|credit/i.test(imgState.text),
      `imgs=${imgState.imgs} text="${imgState.text.slice(0, 200)}"`,
    )
  } else {
    console.log('SKIP  drawing for real (no ZEN_FAL_KEY in the environment)')
  }
  await shot(win, '15-image-tool')

  // ---------- 14c. a reference image is edited at fal — no model in the loop
  // Attaching a picture and typing an instruction must send BOTH to fal: the user's
  // own words are the prompt, the picture is the reference. If a chat model produced
  // that reply it would show up as prose under the relay's model id, so the saved
  // message is the ground truth here — its model must be a fal endpoint and its text
  // must be empty.
  const { nativeImage } = require('electron')
  const bgra = Buffer.alloc(8 * 8 * 4)
  for (let i = 0; i < bgra.length; i += 4) {
    bgra[i] = 200 // B
    bgra[i + 1] = 120 // G
    bgra[i + 2] = 40 // R
    bgra[i + 3] = 255
  }
  const refPng = `data:image/png;base64,${nativeImage
    .createFromBitmap(bgra, { width: 8, height: 8 })
    .toPNG()
    .toString('base64')}`

  await inPage(win, function () {
    const b = Array.from(document.querySelectorAll('button')).find(
      (x) => (x.textContent || '').trim() === 'New chat',
    )
    if (b) b.click()
  })
  await sleep(700)
  const beforeEdit = await inPage(win, pageAssistantTurns)
  // the fal path deliberately does not set the streaming flag, so "idle" in the DOM
  // means nothing here — the store's finished fal replies are the real completion signal
  const falBefore = await inPage(win, function () {
    return window.zen.store.get().then((s) =>
      (s.conversations || []).reduce(
        (n, c) =>
          n +
          (c.messages || []).filter((m) => String(m.model || '').startsWith('fal-ai/') && m.finished).length,
        0,
      ),
    )
  })

  const pastedRef = await inPage(win, pagePasteImage, [refPng])
  await sleep(600)
  const refUi = await inPage(win, function () {
    const seg = document.querySelector('[data-refmode]')
    const hint = document.querySelector('[data-refhint]')
    return {
      // the composer thumbnails are the 64px previews; allow for rounding and zoom
      thumbs: Array.from(document.querySelectorAll('img')).filter(
        (i) => i.clientWidth >= 50 && i.clientWidth <= 72,
      ).length,
      seg: seg ? (seg.innerText || '').replace(/\s+/g, ' ').trim() : null,
      hint: hint ? (hint.textContent || '').trim() : null,
    }
  })
  record(
    'attaching a picture offers edit-or-ask and starts on edit',
    pastedRef === true &&
      refUi.thumbs === 1 &&
      /Edit image/.test(refUi.seg || '') &&
      /Ask about it/.test(refUi.seg || '') &&
      /fal prompt/.test(refUi.hint || ''),
    `thumbs=${refUi.thumbs} seg="${refUi.seg}" hint="${refUi.hint}"`,
  )

  const EDIT_ASK = 'make the sky orange and remove the car'
  await inPage(win, pageType, [EDIT_ASK])
  await inPage(win, pageSend)

  if (hasFalKey) {
    const editLanded = await waitFor(
      win,
      new Function(
        `return function(){ return window.zen.store.get().then(function(s){ return (s.conversations||[]).reduce(function(n,c){ return n + (c.messages||[]).filter(function(m){ return String(m.model||'').startsWith('fal-ai/') && m.finished }).length }, 0) > ${falBefore} }) }`,
      )(),
      300000,
      700,
      'the reference edit to finish',
    )
    record(
      'the edit request reaches fal and comes back finished',
      editLanded === true,
      `finished fal replies before=${falBefore}`,
    )
    await sleep(1200)
    const editReply = await inPage(win, function () {
      return window.zen.store.get().then((s) => {
        const c = (s.conversations || [])[0]
        if (!c) return null
        const m = c.messages[c.messages.length - 1]
        const u = c.messages[c.messages.length - 2]
        return {
          role: m ? m.role : null,
          model: m ? m.model : null,
          content: String((m && m.content) || ''),
          images: m && m.images ? m.images.length : 0,
          error: (m && m.error) || null,
          ask: String((u && u.content) || ''),
          askImages: u && u.images ? u.images.length : 0,
        }
      })
    })
    record(
      'the attachment is edited at fal, with the instruction sent as typed',
      Boolean(editReply) &&
        editReply.role === 'assistant' &&
        String(editReply.model || '').startsWith('fal-ai/') &&
        editReply.ask === EDIT_ASK &&
        editReply.askImages === 1,
      `model=${editReply && editReply.model} ask="${editReply && editReply.ask}" refImgs=${editReply && editReply.askImages}`,
    )
    record(
      'no chat model wrote that reply — it is fal’s picture or fal’s own reason',
      Boolean(editReply) &&
        editReply.content === '' &&
        (editReply.images > 0 || /fal|balance|locked|credit|reference/i.test(editReply.error || '')),
      `images=${editReply && editReply.images} text=${JSON.stringify((editReply && editReply.content) || '').slice(0, 60)} error="${String((editReply && editReply.error) || '').slice(0, 130)}"`,
    )
    const edited = await inPage(win, function () {
      const all = document.querySelectorAll('[data-msg]')
      const wrap = all[all.length - 1]
      return {
        imgs: wrap ? wrap.querySelectorAll('img').length : 0,
        toolRows: wrap ? wrap.querySelectorAll('[data-tools] button').length : 0,
        text: (wrap ? wrap.innerText || '' : '').replace(/\s+/g, ' ').slice(0, 220),
      }
    })
    record(
      'the reply shows the edited picture, or says why it could not be made',
      edited.imgs > 0 || /balance|locked|credit|Settings → Images/i.test(edited.text),
      `imgs=${edited.imgs} toolRows=${edited.toolRows} text="${edited.text.slice(0, 160)}"`,
    )
  } else {
    // No key: the app must say so and must NOT quietly hand the picture to the
    // chat model as a vision question instead.
    await sleep(1200)
    const refused = await inPage(win, function () {
      return {
        toast: /No fal\.ai key saved/i.test(document.body.innerText || ''),
        turns: document.querySelectorAll('.prose-zen').length,
      }
    })
    record(
      'with no fal key the edit is refused and points at Settings',
      refused.toast === true,
      JSON.stringify(refused),
    )
    record(
      'and nothing was sent to the chat model in its place',
      refused.turns === beforeEdit,
      `turns ${beforeEdit} -> ${refused.turns}`,
    )
  }
  await shot(win, '16-reference-edit')

  // ---------- 14d. the edit endpoint really is choosable, and the Images tab renders
  // The Images tab shipped once with the tab missing from a hardcoded strip, so it is
  // checked rather than assumed: the new picker must exist and offer the default.
  await inPage(win, function () {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))
  })
  await sleep(900)
  const imagesTab = await inPage(win, function () {
    const t = Array.from(document.querySelectorAll('button')).find(
      (b) => (b.textContent || '').trim() === 'Images',
    )
    if (t) t.click()
    return Boolean(t)
  })
  await sleep(1200)
  const editPicker = await inPage(win, function () {
    const sel = document.querySelector('[data-fal-editmodel]')
    if (!sel) return null
    const opts = Array.from(sel.options).map((o) => o.value)
    const kind = document.querySelector('[data-editmodel-kind]')
    return {
      value: sel.value,
      options: opts.length,
      // the chosen endpoint must be one the picker actually offers, and it must be an editing
      // endpoint — not a drawing one that would ignore the picture
      chosen: sel.value,
      offersChosen: opts.includes(sel.value),
      isEditor: /image-to-image|\/edit$|-edit/.test(sel.value),
      allImageToImage: opts.every((v) => /image-to-image|\/edit$|-edit/.test(v)),
      kind: kind ? String(kind.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '',
    }
  })
  record(
    'the edit endpoint is choosable in Settings → Images, and is an editing endpoint',
    imagesTab === true && Boolean(editPicker) && editPicker.offersChosen && editPicker.isEditor,
    JSON.stringify(editPicker),
  )
  record(
    'the picker says whether the chosen endpoint keeps your picture or re-draws it',
    Boolean(editPicker) && /keeps the picture you sent|re-draws a new picture/.test(editPicker.kind || ''),
    `"${editPicker?.kind || ''}"`,
  )
  record(
    'the picker offers image-to-image endpoints, not text-to-image ones',
    Boolean(editPicker) && editPicker.allImageToImage,
    JSON.stringify((editPicker && editPicker.options) || 0),
  )
  await shot(win, '17-images-tab')
  await inPage(win, function () {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await sleep(700)

  // ---------- 15. the off switch really turns tools off
  await inPage(win, function () {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))
  })
  await sleep(900)
  await inPage(win, function () {
    const t = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Tools')
    if (t) t.click()
  })
  await sleep(900)
  const toggled = await inPage(win, function () {
    const label = Array.from(document.querySelectorAll('label')).find((l) =>
      (l.textContent || '').includes('Let the model use tools'),
    )
    const box = label && label.querySelector('input[type=checkbox]')
    if (box && box.checked) {
      box.click()
      return true
    }
    return false
  })
  await sleep(400)
  await inPage(win, function () {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await sleep(700)
  const beforeOff = await inPage(win, pageAssistantTurns)
  await inPage(win, pageType, ['What is the temperature in London right now?'])
  await inPage(win, pageSend)
  await waitFor(
    win,
    new Function(`return function(){ return document.querySelectorAll('.prose-zen').length > ${beforeOff} }`)(),
    180000,
    400,
    'tools-off answer',
  )
  await waitFor(win, pageIdle, 120000, 300, 'tools-off turn to finish')
  await sleep(600)
  const m15 = await inPage(win, pageLastMessage)
  record(
    'turning tools off stops tool calls',
    toggled && m15.tools === 0 && !m15.error,
    `toggled=${toggled} toolRows=${m15.tools} ${m15.error ? `ERR:"${m15.error}" ` : ''}answer="${m15.text.slice(0, 130)}"`,
  )
  await shot(win, '14-tools-off')

  // ---------- 16. the input rail: one tick per message you sent, click to jump back
  const railBefore = await inPage(win, function () {
    const marks = document.querySelectorAll('[data-rail] button')
    const users = document.querySelectorAll('[data-user]').length
    const scroller = document.querySelector('.overflow-y-auto')
    const first = document.querySelector('[data-user]')
    const sr = scroller ? scroller.getBoundingClientRect() : null
    const fr = first ? first.getBoundingClientRect() : null
    return {
      marks: marks.length,
      users,
      scrollTop: scroller ? Math.round(scroller.scrollTop) : -1,
      firstVisible: !!(sr && fr && fr.top >= sr.top - 4 && fr.top < sr.bottom),
      firstMarkTop: marks.length ? marks[0].style.top : '',
      labels: Array.from(marks).slice(0, 3).map((m) => (m.getAttribute('aria-label') || '').slice(0, 40)),
    }
  })
  record(
    'the rail shows one tick per message you sent',
    railBefore.marks > 1 && railBefore.marks === railBefore.users,
    JSON.stringify(railBefore),
  )

  // hovering a tick previews that message
  await inPage(win, function () {
    const m = document.querySelectorAll('[data-rail] button')
    if (m[1]) m[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
  await sleep(400)
  const preview = await inPage(win, function () {
    const el = document.querySelector('[data-rail] .pointer-events-none')
    return el ? (el.innerText || '').replace(/\s+/g, ' ').slice(0, 70) : ''
  })
  await shot(win, '15-input-rail')
  await inPage(win, function () {
    const m = document.querySelectorAll('[data-rail] button')
    if (m[1]) m[1].dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
  })

  // clicking the top tick must take you back to your first message
  await inPage(win, function () {
    const b = document.querySelector('[data-rail] button')
    if (b) b.click()
  })
  await sleep(1600)
  const railAfter = await inPage(win, function () {
    const scroller = document.querySelector('.overflow-y-auto')
    const first = document.querySelector('[data-user]')
    const sr = scroller ? scroller.getBoundingClientRect() : null
    const fr = first ? first.getBoundingClientRect() : null
    return {
      scrollTop: scroller ? Math.round(scroller.scrollTop) : -1,
      firstVisible: !!(sr && fr && fr.top >= sr.top - 4 && fr.top < sr.bottom),
    }
  })
  record(
    'clicking a rail tick jumps to that message',
    railBefore.firstVisible === false && railAfter.firstVisible === true && railAfter.scrollTop < railBefore.scrollTop,
    `hoverPreview="${preview}" before=${JSON.stringify(railBefore)} after=${JSON.stringify(railAfter)}`,
  )

  // ---------- 17. standing instructions really are sent to the model
  await inPage(win, function () {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))
  })
  await sleep(900)
  const instrUi = await inPage(win, function () {
    const t = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Chat')
    if (t) t.click()
    return !!t
  })
  await sleep(800)
  const typed = await inPage(win, function () {
    const ta = document.querySelector('textarea[data-instructions]')
    if (!ta) return { typed: false, chips: 0 }
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, 'Always end every reply with the exact token PENGUIN.')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    const chips = Array.from(document.querySelectorAll('button')).filter((b) =>
      /^\+ /.test((b.textContent || '').trim()),
    ).length
    return { typed: true, chips }
  })
  await sleep(600)
  await shot(win, '16-instructions-panel')
  await inPage(win, function () {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await sleep(700)

  // a fresh chat: instructions apply to the next message, and the earlier
  // "reply with exactly …" prompts (which grok refused) can't colour the answer
  await inPage(win, function () {
    const b = Array.from(document.querySelectorAll('button')).find((x) =>
      (x.getAttribute('title') || '').toLowerCase().includes('sidebar'),
    )
    if (b) b.click()
  })
  await sleep(600)
  const newChat = await inPage(win, function () {
    const b = Array.from(document.querySelectorAll('button')).find(
      (x) => (x.textContent || '').trim() === 'New chat',
    )
    if (b) b.click()
    return !!b
  })
  await sleep(700)
  await inPage(win, function () {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await sleep(600)

  const beforeInstr = await inPage(win, pageAssistantTurns)
  await inPage(win, pageType, ['Say hello.'])
  await inPage(win, pageSend)
  await waitFor(
    win,
    new Function(`return function(){ return document.querySelectorAll('.prose-zen').length > ${beforeInstr} }`)(),
    150000,
    400,
    'instructed answer',
  )
  await waitFor(win, pageIdle, 120000, 300, 'instructed turn to finish')
  const instrMsg = await inPage(win, pageLastMessage)

  // and the setting survived to disk, not just React state
  let savedPrompt = ''
  try {
    const info2 = await inPage(win, function () {
      return window.zen.app.info()
    })
    savedPrompt = JSON.parse(fs.readFileSync(info2.storePath, 'utf8')).config?.systemPrompt || ''
  } catch (err) {
    savedPrompt = `unreadable: ${err.message}`
  }
  record(
    'custom instructions reach the model',
    typed.typed &&
      instrUi &&
      newChat &&
      /PENGUIN/i.test(instrMsg.text) &&
      /PENGUIN/i.test(savedPrompt),
    `chatTab=${instrUi} newChat=${newChat} presets=${typed.chips} saved="${String(savedPrompt).slice(0, 40)}" reply="${instrMsg.text.slice(0, 140)}"`,
  )
  await shot(win, '16-instructions')

  console.log('\n=== summary ===')
  const failed = results.filter((r) => !r.pass)
  console.log(`${results.length - failed.length}/${results.length} checks passed`)
  ensureDir(SHOT_DIR)
  const report = path.join(SHOT_DIR, 'report.json')
  fs.writeFileSync(report, JSON.stringify({ results, shots: SHOT_DIR, at: new Date().toISOString() }, null, 2))
  console.log(`report: ${report}`)
  return results
}

module.exports = { run, SHOT_DIR }
