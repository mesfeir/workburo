/*
 * The Electron bridge, provided by a page, backed by real work.
 *
 * The renderer in dist/ talks to window.zen and nothing else, so this file is the whole difference
 * between the app and this preview. Everything below does real work: the conversation goes to the
 * endpoint configured in the app, attachments are read by the app's own document reader, pictures are
 * drawn by the app's own fal pipeline, and conversations are kept in this browser so they survive a
 * reload. No key is in this file: the server on the PC holds it.
 *
 * The transport is the app's own wire format, copied from main.cjs: same headers, same body, same SSE
 * parsing. What is deliberately missing is listed at the bottom of the file.
 */
(function () {
  'use strict'

  /* The link carries a token so a stray device on the network cannot spend the keys. */
  const params = new URLSearchParams(location.search)
  if (params.get('k')) localStorage.setItem('wb-preview-token', params.get('k'))
  const TOKEN = localStorage.getItem('wb-preview-token') || ''

  const LS_STORE = 'wb-preview-store'
  const LS_SEEDED = 'wb-preview-v2'

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
      headers: { 'Content-Type': 'application/json', 'x-preview-token': TOKEN },
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
      headers: { 'Content-Type': 'application/json', 'x-preview-token': TOKEN },
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
      affinityId: 'wb-preview-' + Math.random().toString(36).slice(2, 10),
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

  function loadStore() {
    try {
      const raw = localStorage.getItem(LS_STORE)
      if (raw) return JSON.parse(raw)
    } catch {}
    return null
  }

  let store = loadStore() || {
    config: null,
    conversations: [],
    activeId: null,
    models: [],
  }

  function saveStore() {
    try {
      localStorage.setItem(LS_STORE, JSON.stringify(store))
    } catch (e) {
      console.warn('could not save locally', e)
    }
  }

  /* ---------------------------------------------------------------- the endpoints */

  async function settings() {
    if (real.settingsLoaded) return real.config
    try {
      real.config = await api('/api/config')
      real.settingsLoaded = true
      store.config = seedConfig(real.config)
      saveStore()
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
        return JSON.parse(JSON.stringify(store))
      },
      save: async (next) => {
        store = next
        saveStore()
        return true
      },
      flush: async () => true,
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
                  emit({ requestId, type: 'notice', value: 'tool calls are not wired up in this preview' })
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
                  headers: { 'Content-Type': 'application/octet-stream', 'x-preview-token': TOKEN },
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
        error: 'search and tools are not wired up in this preview: they run in the app, not behind a page',
        sources: [],
      }),
    },

    search: {
      docker: async () => ({ docker: false, daemon: false, version: null, error: 'not in the preview' }),
      install: async () => ({ ok: false, error: 'not in the preview' }),
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
        version: '1.0.16 on a phone (preview)',
        storePath: 'this browser',
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
      connect: async () => ({ ok: false, error: 'Composio is not wired up in this preview', needsKey: true }),
      status: async () => ({ ok: false, error: 'not in the preview' }),
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
      start: async () => ({ ok: false, error: 'not in the preview' }),
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
        error: 'Pi runs on the PC and is installed there. Manage it in the app under Settings, Agent.',
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
      openWorkspace: async () => ({ ok: false, error: 'the workspace folder is on the PC' }),

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

        ;(async () => {
          try {
            emit({
              requestId,
              type: 'meta',
              value: {
                protocol: 'agent',
                model: req.model,
                workspace: req.workspace || store.config?.agent?.workspace,
                note: 'Pi is running on the PC; this window is the front end',
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
      start: async () => ({ ok: false, error: 'not in the preview' }),
      stop: async () => ({ ok: false }),
    },
  }

  window.zen = zen
  window.__workburoPreview = 'live'
  console.info('[WorkBuro] live bridge: real model, real settings, real images. No key on this page.')
})()
