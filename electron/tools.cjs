/**
 * Tools the model can call. Everything here runs in the main process, which is
 * the only place that can reach the internet freely (no CORS, no page sandbox).
 *
 * Each tool returns { ok, text, sources, error }. `text` is what the model sees;
 * `sources` is what the user sees (clickable links under the reply).
 */

const UA = 'Zen-Chat/1.0'
const DEFAULT_SEARCH_URL = 'http://localhost:8888'

function timeoutSignal(ms, outer) {
  const t = AbortSignal.timeout(ms)
  return outer ? AbortSignal.any([outer, t]) : t
}

function clamp(s, n) {
  const t = String(s || '')
  return t.length > n ? `${t.slice(0, n)}\n…[truncated]` : t
}

/* ------------------------------------------------------------------ search */

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
}

async function webSearch(args, opts = {}) {
  const query = String(args.query || args.q || '').trim()
  if (!query) return { ok: false, error: 'web_search needs a query.' }
  const limit = Math.min(Math.max(Number(args.limit) || 6, 1), 10)
  const searchUrl = String(opts.searchUrl || DEFAULT_SEARCH_URL).replace(/\/+$/, '')

  let res
  try {
    res = await fetch(`${searchUrl}/search?q=${encodeURIComponent(query)}&format=json`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: timeoutSignal(25000, opts.signal),
    })
  } catch (err) {
    return {
      ok: false,
      error:
        `Search backend at ${searchUrl} is unreachable (${err.message}). ` +
        'It is the local SearXNG container — start Docker Desktop, or set a different search URL in Settings → Tools.',
    }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const hint =
      res.status === 403
        ? ' (SearXNG must have `search.formats: [html, json]` enabled, otherwise the JSON API is off)'
        : ''
    return { ok: false, error: `Search backend returned HTTP ${res.status}${hint}: ${clamp(body, 200)}` }
  }

  let json
  try {
    json = await res.json()
  } catch {
    const body = await res.text().catch(() => '')
    return { ok: false, error: `Search backend did not return JSON: ${clamp(body, 200)}` }
  }

  const results = (json.results || []).filter((r) => r && r.url).slice(0, limit)
  if (!results.length) return { ok: true, text: `No results for "${query}".`, sources: [] }

  const lines = results.map((r, i) => {
    const snippet = clamp(decodeEntities(r.content || '').replace(/\s+/g, ' ').trim(), 400)
    return `${i + 1}. ${decodeEntities(r.title || r.url)}\n   ${r.url}${snippet ? `\n   ${snippet}` : ''}`
  })

  return {
    ok: true,
    text: `Search results for "${query}" (${results.length}):\n\n${lines.join('\n\n')}`,
    sources: results.map((r) => ({ title: decodeEntities(r.title || r.url), url: r.url })),
  }
}

/* -------------------------------------------------------------- read a page */

function htmlToText(html) {
  let s = String(html || '')
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<(br|p|div|li|tr|h[1-6])\b[^>]*>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  return s
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function fetchPage(args, opts = {}) {
  const raw = String(args.url || '').trim()
  if (!raw) return { ok: false, error: 'fetch_url needs a url.' }
  let url
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return { ok: false, error: `Not a usable URL: ${raw}` }
  }

  let res
  try {
    res = await fetch(url.href, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/json,text/plain,*/*' },
      redirect: 'follow',
      signal: timeoutSignal(25000, opts.signal),
    })
  } catch (err) {
    return { ok: false, error: `Could not fetch ${url.href}: ${err.message}` }
  }
  if (!res.ok) return { ok: false, error: `Could not fetch ${url.href}: HTTP ${res.status}` }

  const ctype = res.headers.get('content-type') || ''
  const body = await res.text()
  const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = decodeEntities(titleMatch ? titleMatch[1].trim() : url.hostname)

  const text = ctype.includes('html') ? htmlToText(body) : body
  if (!text.trim()) return { ok: false, error: `${url.href} returned no readable text.` }

  return {
    ok: true,
    text: `Content of ${url.href}\nTitle: ${title}\n\n${clamp(text, 12000)}`,
    sources: [{ title, url: url.href }],
  }
}

/* ----------------------------------------------------------------- weather */

// WMO weather interpretation codes, as used by open-meteo
const WMO = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog',
  51: 'light drizzle', 53: 'moderate drizzle', 55: 'dense drizzle',
  56: 'light freezing drizzle', 57: 'dense freezing drizzle',
  61: 'slight rain', 63: 'moderate rain', 65: 'heavy rain',
  66: 'light freezing rain', 67: 'heavy freezing rain',
  71: 'slight snowfall', 73: 'moderate snowfall', 75: 'heavy snowfall',
  77: 'snow grains',
  80: 'slight rain showers', 81: 'moderate rain showers', 82: 'violent rain showers',
  85: 'slight snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with slight hail', 99: 'thunderstorm with heavy hail',
}

async function getWeather(args, opts = {}) {
  const place = String(args.location || args.city || args.place || '').trim()
  if (!place) return { ok: false, error: 'get_weather needs a location.' }
  const days = Math.min(Math.max(Number(args.days) || 1, 1), 7)

  let geo
  try {
    const r = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`,
      { headers: { 'User-Agent': UA }, signal: timeoutSignal(15000, opts.signal) },
    )
    if (!r.ok) return { ok: false, error: `Geocoding failed with HTTP ${r.status}.` }
    geo = await r.json()
  } catch (err) {
    return { ok: false, error: `Could not reach the geocoding service: ${err.message}` }
  }

  const hit = (geo.results || [])[0]
  if (!hit) return { ok: false, error: `I could not find a place called "${place}".` }

  const label = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ')
  const params = new URLSearchParams({
    latitude: String(hit.latitude),
    longitude: String(hit.longitude),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,wind_speed_10m,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: String(days),
  })

  let wx
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      headers: { 'User-Agent': UA },
      signal: timeoutSignal(15000, opts.signal),
    })
    if (!r.ok) return { ok: false, error: `Weather service returned HTTP ${r.status}.` }
    wx = await r.json()
  } catch (err) {
    return { ok: false, error: `Could not reach the weather service: ${err.message}` }
  }

  const c = wx.current || {}
  const u = wx.current_units || {}
  const lines = [
    `Current weather for ${label} (${wx.timezone}) — observed ${c.time}`,
    `Conditions: ${WMO[c.weather_code] || `code ${c.weather_code}`}`,
    `Temperature: ${c.temperature_2m}${u.temperature_2m || '°C'} (feels like ${c.apparent_temperature}${u.apparent_temperature || '°C'})`,
    `Humidity: ${c.relative_humidity_2m}${u.relative_humidity_2m || '%'}`,
    `Wind: ${c.wind_speed_10m}${u.wind_speed_10m || ' km/h'}`,
    `Precipitation now: ${c.precipitation}${u.precipitation || ' mm'}`,
  ]

  const d = wx.daily || {}
  if (Array.isArray(d.time)) {
    lines.push('', days > 1 ? `${days}-day forecast:` : 'Today:')
    for (let i = 0; i < d.time.length; i++) {
      lines.push(
        `  ${d.time[i]}: ${WMO[d.weather_code?.[i]] || 'code ' + d.weather_code?.[i]}, ` +
          `${d.temperature_2m_min?.[i]}–${d.temperature_2m_max?.[i]}°C, ` +
          `precipitation chance ${d.precipitation_probability_max?.[i]}%`,
      )
    }
  }

  return {
    ok: true,
    text: lines.join('\n'),
    sources: [
      { title: `${label} — live weather (open-meteo)`, url: `https://open-meteo.com/en/docs` },
    ],
  }
}

/* -------------------------------------------------------------------- time */

async function getTime(args) {
  const tz = String(args.timezone || '').trim() || Intl.DateTimeFormat().resolvedOptions().timeZone
  try {
    const now = new Date()
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      dateStyle: 'full',
      timeStyle: 'long',
    })
    return { ok: true, text: `Current date and time in ${tz}: ${fmt.format(now)}`, sources: [] }
  } catch {
    return { ok: false, error: `Unknown timezone "${tz}". Use an IANA name like Europe/London.` }
  }
}

/* ------------------------------------------------------------- the registry */

const REGISTRY = {
  web_search: {
    label: 'Web search',
    describe: 'Search the live web and return ranked results with snippets.',
    run: webSearch,
    schema: {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          'Search the internet for current information: news, prices, weather, sports, releases, ' +
          'anything after your training cutoff. Returns ranked results with titles, URLs and snippets.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query' },
            limit: { type: 'integer', description: 'How many results to return (1-10, default 6)' },
          },
          required: ['query'],
        },
      },
    },
  },
  fetch_url: {
    label: 'Read a page',
    describe: 'Fetch a web page and return its readable text.',
    run: fetchPage,
    schema: {
      type: 'function',
      function: {
        name: 'fetch_url',
        description:
          'Fetch a single web page and return its text content. Use it to read a result from ' +
          'web_search in full, or any URL the user gives you.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'Absolute URL to fetch' } },
          required: ['url'],
        },
      },
    },
  },
  get_weather: {
    label: 'Weather',
    describe: 'Live weather and forecast for a place, from open-meteo.',
    run: getWeather,
    schema: {
      type: 'function',
      function: {
        name: 'get_weather',
        description:
          'Get the current weather and short forecast for a place. Real-time data, not from memory.',
        parameters: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'City or place name, e.g. "Manchester" or "Paris, France"' },
            days: { type: 'integer', description: 'Forecast days, 1-7 (default 1)' },
          },
          required: ['location'],
        },
      },
    },
  },
  get_time: {
    label: 'Date & time',
    describe: "The current date and time, so the model never guesses today's date.",
    run: getTime,
    schema: {
      type: 'function',
      function: {
        name: 'get_time',
        description: 'Get the current date and time in any timezone. Use this whenever the user asks about now/today.',
        parameters: {
          type: 'object',
          properties: { timezone: { type: 'string', description: 'IANA timezone, e.g. Europe/London' } },
          required: [],
        },
      },
    },
  },
}

const ALL_TOOLS = Object.keys(REGISTRY)

/** Tool definitions in chat/completions shape, for the tools the config enables. */
function chatToolDefs(cfg) {
  const on = (cfg.toolToggles || {})
  return ALL_TOOLS.filter((n) => on[n] !== false).map((n) => REGISTRY[n].schema)
}

/** Same definitions flattened, which is what the Responses API expects. */
function responsesToolDefs(cfg) {
  return chatToolDefs(cfg).map((t) => ({ type: 'function', ...t.function }))
}

async function executeTool(name, argsRaw, opts = {}) {
  const tool = REGISTRY[name]
  if (!tool) return { ok: false, name, error: `Unknown tool "${name}".`, text: '', sources: [] }
  let args = argsRaw
  if (typeof argsRaw === 'string') {
    try {
      args = argsRaw.trim() ? JSON.parse(argsRaw) : {}
    } catch {
      return { ok: false, name, error: `Arguments were not valid JSON: ${clamp(argsRaw, 200)}`, text: '', sources: [] }
    }
  }
  try {
    const r = await tool.run(args || {}, opts)
    return { name, text: r.text || '', sources: r.sources || [], ok: r.ok !== false, error: r.error || null }
  } catch (err) {
    return { name, ok: false, error: `${name} threw: ${err.message}`, text: '', sources: [] }
  }
}

module.exports = {
  REGISTRY,
  ALL_TOOLS,
  chatToolDefs,
  responsesToolDefs,
  executeTool,
  htmlToText,
  DEFAULT_SEARCH_URL,
}
