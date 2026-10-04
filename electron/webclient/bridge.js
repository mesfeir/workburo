/*
 * The Electron bridge, provided by a page, backed by real work.
 *
 * The renderer in dist/ talks to window.zen and nothing else, so this file is the whole difference
 * between the desktop app and the phone. Everything below does real work: the turn goes to the
 * endpoint configured in the app, attachments are read by the app's own document reader, pictures are
 * drawn by the app's own fal pipeline, and the conversations are the app's own -- this page is a
 * second front end onto the same list, not a copy of it. No provider key is in this file: the host
 * holds them, and this file only ever holds the key that gets it in the door.
 *
 * The transport is the app's own wire format, copied from main.cjs: same headers, same body, same SSE
 * parsing. What is deliberately missing is listed at the bottom of the file.
 */
(function () {
  'use strict'

  /*
   * The key guards the whole thing, so a stray device on the network cannot spend the keys. It
   * normally arrives by pairing: the app shows a six-digit code, the phone types it once at /pair, and
   * that page stores what it gets back. A ?key= in the link also works, for a device where pairing is
   * inconvenient.
   */
  const params = new URLSearchParams(location.search)
  if (params.get('key')) localStorage.setItem('wb-server-key', params.get('key'))
  const KEY = localStorage.getItem('wb-server-key') || ''

  /* Without a key there is nothing this page is allowed to do, so send the device to fetch one. */
  if (!KEY) {
    location.replace('/pair')
    return
  }

  /* What the page keeps on its own is only which chat was open; the conversations live on the host. */
  const LS_STORE = 'wb-server-store'
  const LS_SEEDED = 'wb-server-v1'

  const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` })

  const chatHandlers = []
  const running = new Map()
  const progressHandlers = new Map()
  const sessionHandlers = new Set()

  function emit(ev) {
    chatHandlers.forEach((h) => {
      try {
        h(ev)
      } catch (e) {
        console.error(e)
      }
    })
  }

  function fireProgress(kind, p) {
    const set = progressHandlers.get(kind)
    if (set) set.forEach((h) => h(p))
  }

  async function api(pathname, body, signal) {
    const res = await fetch(pathname, {
      method: body === undefined ? 'GET' : 'POST',
      headers: authHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    const text = await res.text()
    let out
    try {
      out = JSON.parse(text)
    } catch {
      throw new Error(`${res.status}: ${text.slice(0, 200)}`)
    }
    if (!res.ok && !out.ok) throw new Error(out.error || `HTTP ${res.status}`)
    return out
  }

  /* Server-sent events, the way main reads them: a data line per blank-line-separated block. */
  async function sse(pathname, body, onEvent, signal) {
    const res = await fetch(pathname, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      const text = await res.text()
      let msg = text
      try {
        msg = JSON.parse(text).error || text
      } catch {}
      throw new Error(msg || `HTTP ${res.status}`)
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const line = block.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          onEvent(JSON.parse(data))
        } catch {
          /* a keepalive or a comment line */
        }
      }
    }
  }

  function normalizeUsage(u) {
    if (!u) return null
    return {
      prompt: u.prompt_tokens ?? u.input_tokens ?? 0,
      completion: u.completion_tokens ?? u.output_tokens ?? 0,
      total: u.total_tokens ?? 0,
      reasoning: u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens ?? 0,
    }
  }

  /* ---------------------------------------------------------------- the store */

  const real = {
    config: null,
    models: [],
    groups: [],
    imageModels: null,
    settingsLoaded: false,
    error: null,
  }

  function seedConfig(config) {
    return {
      theme: 'dark',
      baseUrl: config.baseUrl || '',
      /* a placeholder: the real key stays on the PC and is never sent to this page */
      apiKey: 'held-on-the-pc',
      model: config.model || '',
      systemPrompt: config.systemPrompt || '',
      temperature: config.temperature ?? 1,
      maxTokens: config.maxTokens ?? 8192,
      thinking: config.thinking !== false,
      stream: true,
      showUsage: true,
      protocol: 'chat',
      sendAffinity: true,
      affinityId: 'wb-web-' + Math.random().toString(36).slice(2, 10),
      hotkey: '',
      startWithWindows: false,
      alwaysOnTop: false,
      autoMinimizeSec: 0,
      toolsEnabled: false,
      toolToggles: {},
      serverSearch: false,
      maxToolRounds: 0,
      searchUrl: '',
      searchMode: 'off',
      imageGen: {
        enabled: Boolean(config.hasFalKey),
        provider: 'fal',
        /*
         * The window refuses to draw without a key (it checks this field before it will send anything
         * to fal), so the page has to hold something. It is a placeholder, not a credential: the real
         * key stays on the PC and is the one every fal call is made with. The lesson from the chat
         * side applies here too: a feature gated on a secret has to be told a secret exists.
         */
        falKey: config.hasFalKey ? 'held-on-the-pc' : '',
        model: config.imageGen?.model || 'fal-ai/flux/schnell',
        editModel: config.imageGen?.editModel || 'fal-ai/flux-pro/kontext',
        count: config.imageGen?.count || 1,
        size: config.imageGen?.size || 'square_hd',
      },
      apps: { enabled: false, apiKey: '', userId: '' },
      mcp: { enabled: false, servers: [] },
      agent: {
        workspace: config.agent?.workspace || '',
        enabled: Boolean(config.agent?.enabled),
      },
      profiles: [],
      modelPrefs: config.modelPrefs || {},
    }
  }

  /*
   * The list is the app's own: pulled once at boot, pushed back when this page changes it, and
   * re-pulled while the page is in front, so a chat you started on the desktop turns up here without
   * a reload. Only conversations cross -- settings and keys stay on the host, which is why the push
   * below sends the conversations and nothing else.
   */
  let store = { config: null, conversations: [], activeId: null, models: [] }
  let storeSignature = ''
  let storeLoaded = false
  /* The signature of what was last successfully sent to the host, which is how this page tells its own
   * news from the host's. */
  let pushedSignature = ''
  /* Turns in flight, chat or agent: while one is running this page is the one with the newer list. */
  let turnsInFlight = 0
  const storeHandlers = new Set()

  /* Cheap, and enough to notice a new chat, a new message or an edit: ids, times, and how many. */
  const signatureOf = (s) =>
    JSON.stringify(
      (s.conversations || []).map((c) => [c.id, c.updatedAt || c.createdAt || '', (c.messages || []).length]),
    )

  function noteStore(next) {
    const changed = signatureOf(next) !== storeSignature
    store = next
    storeSignature = signatureOf(store)
    if (changed) {
      storeHandlers.forEach((h) => {
        try {
          h(store)
        } catch (e) {
          console.error(e)
        }
      })
    }
    return changed
  }

  async function pullStore() {
    try {
      const out = await api('/api/store')
      const incoming = out.conversations || []
      const incomingSignature = signatureOf({ conversations: incoming })
      const first = !storeLoaded
      storeLoaded = true

      if (first) {
        /* The app's own list, once at the start. This is what the conversation list is. */
        pushedSignature = incomingSignature
        return noteStore({ ...store, conversations: incoming })
      }

      /*
       * After that, the host's copy is only taken when this page has nothing of its own outstanding.
       *
       * A save to the host rewrites every conversation it holds and takes seconds to do it, so mid-turn
       * the host's list does not yet contain the words just typed. Re-reading and adopting it there
       * deleted the message in front of the person using it, which reads as the app resetting itself.
       * When this page's list differs from what it last sent, the newer copy is this one, so the host's
       * is left alone until the two agree again.
       */
      if (signatureOf(store) !== pushedSignature) return false
      if (incomingSignature === storeSignature) return false
      return noteStore({ ...store, conversations: incoming })
    } catch (err) {
      console.warn('could not read the conversations', err.message)
      return false
    }
  }

  /*
   * Nothing is ever pushed before the first read has landed. Without that gate the page would arrive
   * with an empty list and helpfully save it over every conversation on the host, which is the one
   * mistake in here that would actually lose something.
   */
  const PUSH_DELAY_MS = 1200
  let pushTimer = null
  function saveStore() {
    try {
      const keep = JSON.parse(localStorage.getItem(LS_STORE) || '{}')
      localStorage.setItem(LS_STORE, JSON.stringify({ ...keep, activeId: store.activeId }))
    } catch {}
    if (!storeLoaded) return
    storeSignature = signatureOf(store)
    if (pushTimer) return
    pushTimer = setTimeout(pushStore, PUSH_DELAY_MS)
  }

  async function pushStore() {
    pushTimer = null
    /*
     * A turn changes this list constantly -- every streamed word is a change worth saving -- and each
     * push rewrites the whole store on the host. Pushing during one would have the host working on a
     * list that is already out of date, and the save would still be landing after the answer arrived.
     * A turn is pushed once, when it is over: the last state is the one worth keeping.
     */
    if (turnsInFlight > 0) {
      pushTimer = setTimeout(pushStore, PUSH_DELAY_MS)
      return
    }
    const sending = signatureOf(store)
    try {
      await api('/api/store', { conversations: store.conversations })
      pushedSignature = sending
    } catch (err) {
      console.warn('could not save to the app', err.message)
    }
  }

  /* A chat started on the desktop should show up here on its own: a cheap poll, only when visible. */
  setInterval(() => {
    if (document.visibilityState === 'visible') void pullStore()
  }, 4000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void pullStore()
  })

  /* ---------------------------------------------------------------- the endpoints */

  async function settings() {
    if (real.settingsLoaded) return real.config
    try {
      real.config = await api('/api/config')
      real.settingsLoaded = true
      /* The host's settings, adapted for drawing this page. They are not saved back: the host's copy
       * is the one that counts, and /api/store would not accept them anyway. */
      store.config = seedConfig(real.config)
    } catch (err) {
      real.error = err.message
      if (!store.config) store.config = seedConfig({})
    }
    return real.config
  }

  async function allModels() {
    if (real.models.length) return real.models
    const out = await api('/api/models')
    real.models = out.models || []
    real.groups = out.groups || []
    store.models = real.models.map((m) => ({
      id: m.id,
      ownedBy: m.ownedBy,
      contextLength: m.contextLength,
      provider: m.provider || out.base,
    }))
    saveStore()
    return real.models
  }

  /* ---------------------------------------------------------------- the bridge */

  const zen = {
    theme: { apply: async () => true },

    store: {
      get: async () => {
        await settings()
        if (!real.models.length) {
          try {
            await allModels()
          } catch (err) {
            real.error = err.message
          }
        }
        /* The host's conversations, before the renderer is handed a list to draw. */
        if (!storeLoaded) await pullStore()
        return JSON.parse(JSON.stringify(store))
      },
      save: async (next) => {
        store = next
        saveStore()
        return true
      },
      flush: async () => {
        if (pushTimer) {
          clearTimeout(pushTimer)
          pushTimer = null
        }
        if (storeLoaded) {
          const sending = signatureOf(store)
          try {
            await api('/api/store', { conversations: store.conversations })
            pushedSignature = sending
          } catch {}
        }
        return true
      },
      /* So this page can follow a chat that is being written on the desktop. */
      onChanged: (cb) => {
        storeHandlers.add(cb)
        return () => storeHandlers.delete(cb)
      },
    },

    chat: {
      start: async (req) => {
        const requestId = req.requestId
        const cfg = store.config || {}
        const model = req.cfg?.model || cfg.model
        const prefs = (cfg.modelPrefs || {})[model] || {}

        const ac = new AbortController()
        running.set(requestId, ac)
        const started = Date.now()
        let usage = null

        // fire and forget: the renderer listens on onEvent, exactly as it does for the app
        turnsInFlight++
        ;(async () => {
          try {
            emit({
              requestId,
              type: 'meta',
              value: { protocol: 'chat', model, note: `via the app's own request path, endpoint ${cfg.baseUrl}` },
            })
            await sse(
              '/api/chat',
              {
                requestId,
                model,
                // the endpoint this model belongs to: the renderer sets it when a model is picked, so a
                // model from a second provider is not sent to the first one
                baseUrl: req.cfg?.baseUrl,
                systemPrompt: req.systemPrompt,
                messages: req.messages,
                temperature: cfg.temperature,
                maxTokens: cfg.maxTokens,
              },
              (payload) => {
                if (payload.error && !payload.choices) {
                  emit({ requestId, type: 'error', value: String(payload.error.message || payload.error) })
                  return
                }
                const choice = payload.choices?.[0]
                if (payload.usage) {
                  usage = normalizeUsage(payload.usage)
                  emit({ requestId, type: 'usage', value: usage })
                }
                if (!choice) return
                const d = choice.delta || choice.message || {}
                const think = d.reasoning_content || d.reasoning || d.thinking
                if (think) emit({ requestId, type: 'reasoning', value: String(think) })
                if (d.content) emit({ requestId, type: 'text', value: d.content })
                if (Array.isArray(d.tool_calls) && d.tool_calls.length) {
                  emit({ requestId, type: 'notice', value: 'tool calls belong to agent mode, which runs on the host' })
                }
                if (choice.finish_reason) emit({ requestId, type: 'finish', value: choice.finish_reason })
              },
              ac.signal,
            )
            emit({ requestId, type: 'done', value: { ok: true, usage, elapsedMs: Date.now() - started } })
          } catch (err) {
            const stopped = err.name === 'AbortError'
            if (!stopped) emit({ requestId, type: 'error', value: err.message })
            emit({ requestId, type: 'done', value: { ok: !stopped, stopped, usage, elapsedMs: Date.now() - started } })
          } finally {
            running.delete(requestId)
            turnsInFlight = Math.max(0, turnsInFlight - 1)
          }
        })()

        return { ok: true }
      },

      abort: async (requestId) => {
        const ac = running.get(requestId)
        if (ac) ac.abort()
        return Boolean(ac)
      },

      /* the app's own rules for a name, then one short call on the real model */
      title: async (req) => {
        try {
          const out = await api('/api/title', { messages: req?.messages || [] })
          return out.ok ? { ok: true, title: out.title } : { ok: false }
        } catch {
          return { ok: false }
        }
      },

      onEvent: (handler) => {
        chatHandlers.push(handler)
        return () => {
          const i = chatHandlers.indexOf(handler)
          if (i >= 0) chatHandlers.splice(i, 1)
        }
      },
    },

    models: {
      list: async () => {
        try {
          const list = await allModels()
          return { ok: true, models: list.map((m) => ({ id: m.id, ownedBy: m.ownedBy, contextLength: m.contextLength })), base: store.config?.baseUrl }
        } catch (err) {
          return { ok: false, error: err.message, models: [] }
        }
      },
      all: async () => {
        const list = await allModels()
        // the app groups models by the provider they came from, and so should this: a model list is
        // only a choice if you can tell which key each one will be spent on
        const groups = (real.groups || []).map((g) => ({
          provider: g.provider,
          baseUrl: g.baseUrl,
          models: g.models || [],
          key: '',
          affinity: Boolean(g.affinity),
        }))
        const unavailable = (real.groups || [])
          .filter((g) => g.error)
          .map((g) => ({ provider: g.provider, baseUrl: g.baseUrl, error: g.error }))
        return { ok: true, count: list.length, models: list, groups, unavailable }
      },
      probe: async (req) => {
        const model = (req && req.model) || store.config?.model
        const prefs = (store.config?.modelPrefs || {})[model] || {}
        return { ok: true, vision: prefs.vision || 'unknown', thinking: prefs.thinking ?? store.config?.thinking, protocol: 'chat' }
      },
    },

    files: {
      add: () =>
        new Promise((resolve) => {
          const input = document.createElement('input')
          input.type = 'file'
          input.multiple = true
          input.style.position = 'fixed'
          input.style.left = '-9999px'
          input.onchange = async () => {
            const added = []
            for (const f of Array.from(input.files || [])) {
              const isImage = /^image\//.test(f.type)
              if (isImage) {
                const url = await new Promise((res) => {
                  const fr = new FileReader()
                  fr.onload = () => res(String(fr.result))
                  fr.readAsDataURL(f)
                })
                added.push({ name: f.name, url, kind: 'image', bytes: f.size })
                continue
              }
              // a document is written to the PC so the app's own reader can open it by path
              try {
                const res = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${KEY}` },
                  body: f,
                })
                const out = await res.json()
                if (!out.ok) {
                  added.push({ name: f.name, kind: 'document', error: out.error, bytes: f.size })
                  continue
                }
                added.push({
                  name: out.name,
                  path: out.path,
                  kind: 'document',
                  docKind: out.docKind,
                  chars: out.chars,
                  bytes: out.bytes,
                  preview: out.preview,
                })
              } catch (err) {
                added.push({ name: f.name, kind: 'document', error: err.message, bytes: f.size })
              }
            }
            input.remove()
            resolve({ ok: true, added })
          }
          input.oncancel = () => {
            input.remove()
            resolve({ ok: true, added: [], canceled: true })
          }
          document.body.appendChild(input)
          input.click()
        }),
      pathFor: () => '',
      open: async () => ({ ok: false, error: 'files live on the PC — open them there, or ask for the contents' }),
      reveal: async () => ({ ok: false, error: 'the phone has no file manager to reveal into' }),
    },

    tools: {
      list: async () => [],
      probe: async () => ({
        ok: false,
        error: 'search is a setting on the host: change it in the app, not from here',
        sources: [],
      }),
    },

    search: {
      docker: async () => ({ docker: false, daemon: false, version: null, error: 'not available from a phone: it runs on the host' }),
      install: async () => ({ ok: false, error: 'not available from a phone: it runs on the host' }),
      onInstallProgress: () => () => {},
    },

    images: {
      models: async () => {
        if (real.imageModels) return real.imageModels
        try {
          const out = await api('/api/image-models')
          real.imageModels = out.ok ? out : { ok: false, error: out.error, models: [] }
        } catch (err) {
          real.imageModels = { ok: false, error: err.message, models: [] }
        }
        return real.imageModels
      },
      options: async () => ({
        sizes: [
          { id: 'square_hd', label: 'Square, 1024', width: 1024, height: 1024 },
          { id: 'landscape_16_9', label: 'Wide, 16:9', width: 1344, height: 768 },
          { id: 'portrait_4_3', label: 'Tall, 4:3', width: 896, height: 1152 },
        ],
      }),
      /* the app's own generate(), running on the PC, streaming its progress back here */
      generate: async (req) => {
        const out = await new Promise((resolve) => {
          sse(
            '/api/image',
            {
              prompt: req.prompt,
              model: req.model,
              count: req.count,
              size: req.size,
              imageUrl: req.imageUrl || req.url,
              strength: req.strength,
            },
            (payload) => {
              if (payload.type === 'progress') fireProgress('images', payload.value)
              if (payload.type === 'result') resolve(payload.value)
            },
          ).catch((err) => resolve({ ok: false, error: err.message }))
        })
        return out
      },
      saveAs: async (req) => {
        /* the phone's own download flow is the equivalent of saving to a folder */
        const url = typeof req === 'string' ? req : req?.url || req?.dataUrl
        const name = (typeof req === 'object' && req?.name) || 'workburo-image.png'
        if (!url) return { ok: false, error: 'nothing to save' }
        const a = document.createElement('a')
        a.href = url
        a.download = name
        document.body.appendChild(a)
        a.click()
        a.remove()
        return { ok: true, saved: true }
      },
      dataUrl: async (p) => ({ ok: true, url: p }),
      prices: async () => ({ ok: true, prices: {} }),
      cost: async () => ({ ok: true, text: '' }),
      openFolder: async () => ({ ok: false, error: 'the image was saved on the PC, in the app’s images folder' }),
      onProgress: (handler) => {
        if (!progressHandlers.has('images')) progressHandlers.set('images', new Set())
        progressHandlers.get('images').add(handler)
        return () => progressHandlers.get('images').delete(handler)
      },
    },

    app: {
      info: async () => ({
        version: 'WorkBuro on a phone',
        storePath: 'on the host',
        platform: 'web',
        endpoint: store.config?.baseUrl,
        real: true,
      }),
      openStore: async () => {},
      pickImages: () =>
        new Promise((resolve) => {
          const input = document.createElement('input')
          input.type = 'file'
          input.accept = 'image/*'
          input.multiple = true
          input.style.position = 'fixed'
          input.style.left = '-9999px'
          input.onchange = async () => {
            const out = []
            for (const f of Array.from(input.files || [])) {
              const url = await new Promise((res) => {
                const fr = new FileReader()
                fr.onload = () => res(String(fr.result))
                fr.readAsDataURL(f)
              })
              out.push({ name: f.name, url })
            }
            input.remove()
            resolve(out)
          }
          input.oncancel = () => {
            input.remove()
            resolve([])
          }
          document.body.appendChild(input)
          input.click()
        }),
      getHotkey: async () => ({ requested: '', active: null, fallback: false, error: null, accelerator: null }),
      setHotkey: async () => ({ ok: false, registered: false, accelerator: null, error: 'a phone has no global hotkey' }),
      getLoginItem: async () => ({ openAtLogin: false, executableWillLaunchAtLogin: false }),
      setLoginItem: async () => ({ openAtLogin: false, executableWillLaunchAtLogin: false }),
      resetBounds: async () => null,
      hideWindow: async () => false,
      onMenuAction: () => () => {},
      onHotkeyStatus: () => () => {},
    },

    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener')
      return { ok: true }
    },

    /* ---------------------------------------------------------------- honest gaps
     *
     * These are the features that genuinely cannot work behind a page, so they say so instead of
     * pretending: agent mode (it runs a program on the PC), local models (a downloaded runtime),
     * Composio (a stored account token), MCP (it starts a server process), and opening or revealing
     * files (there is no desktop behind this window).
     */
    apps: {
      list: async () => ({ ok: true, apps: [], needsKey: true }),
      connections: async () => ({ ok: true, connections: [], needsKey: true }),
      connect: async () => ({ ok: false, error: 'Composio signs in on the host, not from a phone', needsKey: true }),
      status: async () => ({ ok: false, error: 'not available from a phone: it runs on the host' }),
    },

    local: {
      status: async () => ({
        installed: false,
        version: null,
        pinned: null,
        model: null,
        modelPath: null,
        modelReady: false,
        ready: false,
        root: '',
        defaultModel: null,
        catalogue: [],
        running: null,
      }),
      install: async () => ({ ok: false, error: 'a local model runs in the app, not behind a page' }),
      start: async () => ({ ok: false, error: 'not available from a phone: it runs on the host' }),
      stop: async () => ({ ok: true }),
      detect: async () => ({ found: [], tried: [] }),
      open: async () => '',
      onProgress: () => () => {},
    },

    pi: {
      status: async () => {
        try {
          const s = await api('/api/pi/status')
          return {
            installed: Boolean(s.installed),
            version: s.version,
            pinned: s.pinned,
            exe: s.exe,
            agentDir: s.agentDir,
            workspace: s.workspace,
            workspaceExists: s.workspaceExists,
            allowed: s.allowed,
            appEnabled: s.appEnabled,
            configured: s.configured,
          }
        } catch (err) {
          return { installed: false, error: err.message }
        }
      },
      install: async () => ({
        installed: true,
        busy: false,
        error: 'Pi runs on the host and is installed there. Manage it in the app under Settings, Agent.',
      }),
      uninstall: async () => ({ installed: true }),
      // a phone has no folder picker: the workspace is the one the app is set to
      pickWorkspace: async () => null,
      sessions: async () => {
        try {
          return await api('/api/pi/sessions')
        } catch {
          return []
        }
      },
      onSessions: (handler) => {
        sessionHandlers.add(handler)
        return () => sessionHandlers.delete(handler)
      },
      openWorkspace: async () => ({ ok: false, error: 'the workspace folder is on the host' }),

      /*
       * A real agent turn. Pi runs on the PC with its own tools and workspace; this page only shows
       * what it does. The conversation so far rides along so the agent can pick up a chat that was
       * started with agent mode off.
       */
      turn: async (req) => {
        const requestId = req.requestId
        const started = Date.now()
        const convo = (store.conversations || []).find((c) => c.id === req.conversationId)
        const contextMessages = (convo?.messages || []).map((m) => ({ id: m.id, role: m.role, content: m.content }))

        turnsInFlight++
        ;(async () => {
          try {
            emit({
              requestId,
              type: 'meta',
              value: {
                protocol: 'agent',
                model: req.model,
                workspace: req.workspace || store.config?.agent?.workspace,
                note: 'Pi is running on the host; this window is the front end',
              },
            })
            await sse(
              '/api/pi/turn',
              {
                requestId,
                conversationId: req.conversationId,
                prompt: req.prompt,
                model: req.model,
                // the endpoint this model belongs to, so the agent runs on the model you picked
                baseUrl: store.config?.baseUrl,
                documents: req.documents || [],
                images: req.images || [],
                messages: contextMessages,
              },
              (payload) => {
                if (payload.type === 'event') emit({ requestId, ...payload.value })
                if (payload.type === 'done') {
                  emit({ requestId, type: 'done', value: { ok: payload.value?.ok !== false, elapsedMs: Date.now() - started } })
                }
              },
            )
          } catch (err) {
            emit({ requestId, type: 'error', value: err.message })
            emit({ requestId, type: 'done', value: { ok: false, elapsedMs: Date.now() - started } })
          } finally {
            turnsInFlight = Math.max(0, turnsInFlight - 1)
          }
        })()

        return { ok: true }
      },

      stop: async (req) => {
        try {
          const out = await api('/api/pi/stop', { requestId: (req && req.requestId) || req })
          return { stopped: Boolean(out.stopped) }
        } catch {
          return { stopped: false }
        }
      },
      onProgress: () => () => {},
    },

    mcp: {
      status: async () => ({ enabled: false, servers: [], tools: [] }),
      start: async () => ({ ok: false, error: 'not available from a phone: it runs on the host' }),
      stop: async () => ({ ok: false }),
    },
  }

  window.zen = zen
  window.__workburoWeb = 'live'
  console.info('[WorkBuro] web bridge: the app\'s own conversations, models and images, from another device. No provider key on this page.')
})()
