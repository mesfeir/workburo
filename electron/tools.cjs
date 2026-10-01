/**
 * Tools the model can call. Everything here runs in the main process, which is
 * the only place that can reach the internet freely (no CORS, no page sandbox).
 *
 * Each tool returns { ok, text, sources, error }. `text` is what the model sees;
 * `sources` is what the user sees (clickable links under the reply); `images`
 * (generate_image only) is attachments the caller hangs on the reply.
 */

const UA = 'Zen-Chat/1.0'
const DEFAULT_SEARCH_URL = 'http://localhost:8888'

const falImages = require('./images.cjs')

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

/* ------------------------------------------------- the reference sources
 *
 * A floor under search that needs no key, no account and no service running, so a fresh install is
 * never dead-ended by search. Measured before being relied on: Wikipedia, Stack Overflow, Hacker
 * News and Open Library each answer clean JSON with no credential.
 *
 * These are reference sources, not a general web search. What they cover is an encyclopaedia,
 * programming questions, forum posts and books, so the results say which sources they came from and
 * the tool says out loud that this is what it is. Nothing here is ever presented as a web search,
 * and a model that cannot answer from them is expected to say so rather than guess.
 */

const REFERENCE_NOTE =
  'These are reference sources rather than a live web search: an encyclopaedia, programming ' +
  'questions, forum posts and books. Say which of them an answer came from. If they do not cover ' +
  'the question, say what you could not find instead of filling the gap in yourself.'

const REFERENCE_UA = UA

/** Search-match markup and forum HTML both arrive wrapped; the model wants the words. */
function stripTags (s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

async function wikipediaSearch (query, n, opts) {
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*' +
    `&srlimit=${n}&srsearch=${encodeURIComponent(query)}`
  const res = await opts.fetchImpl(url, { headers: { 'User-Agent': REFERENCE_UA, Accept: 'application/json' }, signal: opts.signal })
  if (!res.ok) throw new Error(`Wikipedia answered HTTP ${res.status}`)
  const json = await res.json()
  return ((json.query || {}).search || []).map((h) => ({
    title: decodeEntities(h.title || ''),
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(h.title || '').replace(/\s+/g, '_'))}`,
    snippet: stripTags(h.snippet),
  }))
}

async function stackOverflowSearch (query, n, opts) {
  // filter=withbody is what brings the text back; the default filter returns no body at all.
  const url =
    'https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&site=stackoverflow' +
    `&pagesize=${n}&filter=withbody&q=${encodeURIComponent(query)}`
  const res = await opts.fetchImpl(url, { headers: { 'User-Agent': REFERENCE_UA, Accept: 'application/json' }, signal: opts.signal })
  if (!res.ok) throw new Error(`Stack Exchange answered HTTP ${res.status}`)
  const json = await res.json()
  return ((json.items || [])).map((it) => ({
    title: decodeEntities(it.title || ''),
    url: it.link,
    snippet: clamp(stripTags(it.body), 300),
  }))
}

async function hackerNewsSearch (query, n, opts) {
  const url = `https://hn.algolia.com/api/v1/search?hitsPerPage=${n}&query=${encodeURIComponent(query)}`
  const res = await opts.fetchImpl(url, { headers: { 'User-Agent': REFERENCE_UA, Accept: 'application/json' }, signal: opts.signal })
  if (!res.ok) throw new Error(`Hacker News answered HTTP ${res.status}`)
  const json = await res.json()
  return ((json.hits || []))
    .map((h) => {
      const title = decodeEntities(h.title || h.story_title || '')
      const text = stripTags(h.story_text || h.comment_text || '')
      const points = Number(h.points)
      const talks = Number(h.num_comments)
      return {
        title,
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        snippet: text ? clamp(text, 300) : [points ? `${points} points` : '', talks ? `${talks} comments` : ''].filter(Boolean).join(', '),
      }
    })
    .filter((r) => r.title && r.url)
}

async function openLibrarySearch (query, n, opts) {
  const url =
    'https://openlibrary.org/search.json?limit=' + n +
    `&fields=title,author_name,first_publish_year,key&q=${encodeURIComponent(query)}`
  const res = await opts.fetchImpl(url, { headers: { 'User-Agent': REFERENCE_UA, Accept: 'application/json' }, signal: opts.signal })
  if (!res.ok) throw new Error(`Open Library answered HTTP ${res.status}`)
  const json = await res.json()
  return ((json.docs || []))
    .map((d) => {
      const author = (d.author_name || [])[0]
      const year = d.first_publish_year
      return {
        title: [decodeEntities(d.title || ''), author, year ? `(${year})` : ''].filter(Boolean).join(' '),
        url: d.key ? `https://openlibrary.org${d.key}` : '',
        snippet: '',
      }
    })
    .filter((r) => r.title && r.url)
}

const REFERENCE_SOURCES = [
  { label: 'Wikipedia', run: wikipediaSearch },
  { label: 'Stack Overflow', run: stackOverflowSearch },
  { label: 'Hacker News', run: hackerNewsSearch },
  { label: 'Open Library', run: openLibrarySearch },
]

/**
 * Ask every reference source at once, then take turns so one source cannot fill the whole list.
 *
 * A source that fails or is slow is left out and named, rather than failing the whole search: this
 * is the path taken when nothing else works, so it has to be the one that keeps going.
 */
async function referenceSearch (query, limit, opts = {}) {
  const n = Math.min(Math.max(Number(limit) || 6, 1), 10)
  const per = Math.max(2, Math.ceil(n / 2))
  const call = { ...opts, fetchImpl: opts.fetchImpl || fetch, signal: timeoutSignal(9000, opts.signal) }

  const settled = await Promise.all(
    REFERENCE_SOURCES.map(async (s) => {
      try {
        return { s, results: await s.run(query, per, call) }
      } catch (err) {
        return { s, error: err.message }
      }
    }),
  )

  const results = []
  for (let round = 0; round < per && results.length < n; round++) {
    for (const { s, results: r } of settled) {
      const item = (r || [])[round]
      if (item) results.push({ ...item, source: s.label })
      if (results.length >= n) break
    }
  }

  const answered = settled.filter((x) => (x.results || []).length).map((x) => x.s.label)
  const failed = settled.filter((x) => x.error).map((x) => x.s.label)

  if (!results.length) {
    if (failed.length === REFERENCE_SOURCES.length) {
      return { ok: false, error: `No reference source could be reached (${failed.join(', ')}).` }
    }
    return { ok: true, text: `No reference results for "${query}".${failed.length ? ` ${failed.join(' and ')} could not be reached.` : ''}`, sources: [] }
  }

  const lines = results.map((r, i) => {
    const snippet = clamp(r.snippet || '', 400)
    return `${i + 1}. ${r.title} (${r.source})\n   ${r.url}${snippet ? `\n   ${snippet}` : ''}`
  })

  return {
    ok: true,
    text:
      `Reference results for "${query}" from ${answered.join(', ')} (${results.length}):\n\n` +
      `${lines.join('\n\n')}\n\n${REFERENCE_NOTE}` +
      (failed.length ? `\n${failed.join(' and ')} did not answer this time.` : ''),
    sources: results.map((r) => ({ title: r.title, url: r.url })),
    reference: true,
  }
}

/* --------------------------------------------------------- a search API key */

/**
 * Brave and Tavily, for an install that wants real web search without running anything.
 *
 * Both are reached over plain JSON with a key. Both shapes are written from their published API, so
 * treat the key path as untested here until an install proves it with a real key.
 */
async function keyedSearch (query, limit, opts = {}) {
  const key = String(opts.searchKey || '').trim()
  const provider = String(opts.searchProvider || 'brave').toLowerCase()
  if (!key) return { ok: false, error: 'No search API key is set. Add one in Settings, then Tools.' }
  const call = { fetchImpl: opts.fetchImpl || fetch, signal: timeoutSignal(20000, opts.signal) }

  let results = []
  try {
    if (provider === 'tavily') {
      const res = await call.fetchImpl('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key, query, max_results: limit }),
        signal: call.signal,
      })
      if (!res.ok) return { ok: false, error: `Tavily answered HTTP ${res.status}.` }
      const json = await res.json()
      results = (json.results || []).map((r) => ({ title: r.title || r.url, url: r.url, snippet: r.content || '' }))
    } else {
      const res = await call.fetchImpl(
        `https://api.search.brave.com/res/v1/web/search?count=${limit}&q=${encodeURIComponent(query)}`,
        { headers: { Accept: 'application/json', 'X-Subscription-Token': key }, signal: call.signal },
      )
      if (!res.ok) return { ok: false, error: `Brave answered HTTP ${res.status}.` }
      const json = await res.json()
      results = (((json.web || {}).results) || []).map((r) => ({ title: r.title || r.url, url: r.url, snippet: r.description || '' }))
    }
  } catch (err) {
    return { ok: false, error: `${provider === 'tavily' ? 'Tavily' : 'Brave'} could not be reached: ${err.message}` }
  }

  results = results.filter((r) => r && r.url).slice(0, limit)
  if (!results.length) return { ok: true, text: `No results for "${query}".`, sources: [] }
  const lines = results.map((r, i) => {
    const snippet = clamp(decodeEntities(r.snippet || '').replace(/\s+/g, ' ').trim(), 400)
    return `${i + 1}. ${decodeEntities(r.title || r.url)}\n   ${r.url}${snippet ? `\n   ${snippet}` : ''}`
  })
  return {
    ok: true,
    text: `Search results for "${query}" (${results.length}):\n\n${lines.join('\n\n')}`,
    sources: results.map((r) => ({ title: decodeEntities(r.title || r.url), url: r.url })),
  }
}

/* ---------------------------------------------------------- your own SearXNG */

async function searxngSearch (query, limit, opts = {}) {
  const searchUrl = String(opts.searchUrl || DEFAULT_SEARCH_URL).replace(/\/+$/, '')
  const call = { fetchImpl: opts.fetchImpl || fetch }

  let res
  try {
    res = await call.fetchImpl(`${searchUrl}/search?q=${encodeURIComponent(query)}&format=json`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: timeoutSignal(25000, opts.signal),
    })
  } catch (err) {
    return {
      ok: false,
      error:
        `No search service is answering at ${searchUrl} (${err.message}). ` +
        'Search needs a SearXNG instance with the JSON API enabled, in search.formats. ' +
        'Point this at one in Settings, then Tools, or run: docker run -d -p 8888:8080 searxng/searxng',
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

/* --------------------------------------------------------------- choosing one
 *
 * Three ways to search, chosen in Settings, each falling back to the reference sources rather than
 * failing outright:
 *
 *   provider   the model's own search, where the provider has one. Nothing to configure, and the
 *              native search is used in main.cjs; this only runs when there is none.
 *   searxng    your own instance, which is what a searchUrl points at.
 *   key        Brave or Tavily with an API key.
 *   reference  the sources above, on their own, with no service and no key at all.
 *
 * The fallback is never silent: the answer says which sources it came from, so nobody is left
 * thinking an encyclopaedia entry was a web search.
 */

const SEARCH_MODES = ['provider', 'searxng', 'key', 'reference']

async function webSearch(args, opts = {}) {
  const query = String(args.query || args.q || '').trim()
  if (!query) return { ok: false, error: 'web_search needs a query.' }
  const limit = Math.min(Math.max(Number(args.limit) || 6, 1), 10)
  const mode = SEARCH_MODES.includes(String(opts.searchMode)) ? String(opts.searchMode) : 'searxng'

  if (mode === 'reference' || mode === 'provider') return referenceSearch(query, limit, opts)

  const first = mode === 'key'
    ? await keyedSearch(query, limit, opts)
    : await searxngSearch(query, limit, opts)
  if (first.ok) return first

  const ref = await referenceSearch(query, limit, opts)
  if (!ref.ok) return { ok: false, error: `${first.error} ${ref.error}` }
  return {
    ok: true,
    text: `${first.error}\n\nFalling back to reference sources.\n\n${ref.text}`,
    sources: ref.sources,
    reference: true,
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

  // open-meteo's geocoder rejects some "City, Country" strings outright: "London, UK" comes back
  // with no results at all while "Paris, France" works, so a person naming a place the natural way
  // was told the place does not exist. Ask for what they said, then for the part before the first
  // comma, rather than letting the phrasing decide whether the tool works.
  const asked = [place]
  const bare = place.split(',')[0].trim()
  if (bare && bare !== place) asked.push(bare)

  let geo = null
  for (const [i, name] of asked.entries()) {
    try {
      const r = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`,
        { headers: { 'User-Agent': UA }, signal: timeoutSignal(15000, opts.signal) },
      )
      if (!r.ok) return { ok: false, error: `Geocoding failed with HTTP ${r.status}.` }
      geo = await r.json()
    } catch (err) {
      return { ok: false, error: `Could not reach the geocoding service: ${err.message}` }
    }
    if ((geo.results || []).length) break
    // Only worth trying the shorter form once, and only when it is genuinely different.
    if (i === asked.length - 1) geo = null
  }

  const hit = ((geo && geo.results) || [])[0]
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

/* --------------------------------------------------------------- pictures */

/**
 * Draw a picture, as a tool, so the model can reach for it on its own the moment
 * the user asks to see something — no mode to arm first.
 *
 * Same return shape as every other tool, plus `images`: attachments the caller
 * puts on the reply. `text` is what the model reads — a short report, never the
 * image bytes.
 */
async function generateImage(args, opts = {}) {
  const prompt = String(args.prompt || args.description || '').trim()
  if (!prompt) return { ok: false, error: 'generate_image needs a prompt describing the picture.' }

  const cfg = opts.images || {}
  // a test can inject a stand-in here, so the whole tool path runs with no key and no network
  const generate = cfg.generate || falImages.generate

  if (!cfg.key) {
    return {
      ok: false,
      error:
        'No fal.ai API key is saved, so there is nothing to draw with. Add one in Settings → Images, ' +
        'then ask me again.',
    }
  }

  // Which picture is being changed, if any. main supplies the pictures that are actually in the
  // conversation; the model only names one, so it can never invent an image out of nowhere — and a
  // model with no vision can still work on a picture it cannot see.
  const wanted = String(args.reference || '').trim().toLowerCase()
  // main supplies the pictures that are in this conversation — as a map: last / attached / named /
  // list. A plain array is tolerated too, in order, so a caller that passes one still works.
  const refsIn = cfg.references
  const refs = Array.isArray(refsIn)
    ? { list: refsIn, last: refsIn[refsIn.length - 1] || null, named: {} }
    : refsIn || {}
  let reference = null
  if (wanted) {
    if (wanted === 'last' || wanted === 'attached' || wanted === 'recent') {
      reference = refs[wanted] || refs.last || null
    } else if (refs.named && refs.named[wanted]) {
      // the exact name, which is how the model is told about the pictures in the first place
      reference = refs.named[wanted]
    } else if (/^[0-9]+$/.test(wanted) && Array.isArray(refs.list)) {
      // or its position in that list, for "the second one"
      reference = refs.list[Number(wanted) - 1] || null
    }
    if (!reference || !reference.url) {
      // Say what *is* here, so the next attempt can name it correctly — a bare refusal is what made
      // the model give up and draw something new instead of changing the picture asked about.
      const known = Array.isArray(refs.list)
        ? refs.list.filter(Boolean).map((r) => r.name).filter(Boolean)
        : []
      return {
        ok: false,
        error:
          `There is no picture called "${wanted}" in this conversation.` +
          (known.length
            ? ` The pictures here are: ${known.join(', ')}. Name one of those, or say "last".`
            : refs.present
              ? ` There ${refs.present === 1 ? 'is a picture' : `are ${refs.present} pictures`} in this ` +
                `conversation, but ${refs.present === 1 ? 'it' : 'they'} could not be read — the file may ` +
                'have been moved or deleted.'
              : ' Nothing has been attached or drawn here yet — draw one first, or attach a picture, then ask again.'),
      }
    }
  }

  // The picture is made with the model the user chose in the bar — the same one the Image switch
  // uses — never one the model picks for itself. Letting the tool name its own model meant a picture
  // asked for in words could come back from a different endpoint than the one on screen, which is
  // not "the same tool" however much else matched. An edit uses the edit endpoint instead.
  const model = String((reference ? cfg.editModel || cfg.model : cfg.model) || '').trim()
  if (!model) return { ok: false, error: 'No fal.ai model is selected. Pick one in Settings → Images.' }

  const count = Math.min(Math.max(Number(args.count) || 1, 1), 4)
  const asked = String(args.size || '').trim()
  const isPreset = (s) => falImages.SIZE_PRESETS.some((p) => p.id === s)
  const chosen = isPreset(asked) ? asked : ''
  if (asked && !chosen) {
    return {
      ok: false,
      error: `Unknown size "${asked}". Use one of: ${falImages.SIZE_PRESETS.map((p) => p.id).join(', ')}.`,
    }
  }
  // nothing asked for: use the shape the user picked in Settings, so both doors make the same canvas
  const size = chosen || (isPreset(cfg.size) ? cfg.size : '')

  const result = await generate({
    key: cfg.key,
    model,
    prompt,
    count,
    size,
    // the reference travels inline: the picture is already here, and the endpoint is the one that
    // follows an instruction instead of re-drawing from the words alone
    imageUrl: reference ? reference.url : '',
    imagesDir: cfg.imagesDir,
    onProgress: cfg.onProgress,
  })
  if (!result.ok) return { ok: false, error: result.error || 'Image generation failed.' }

  const images = result.images || []
  const secs = ((result.tookMs || 0) / 1000).toFixed(1)

  if (reference) {
    return {
      ok: true,
      images,
      sources: [],
      text:
        `Changed the picture (${reference.name}) with ${model} in ${secs}s, following the user's ` +
        `instruction. The conversation now shows the changed picture${images.length === 1 ? '' : 's'}. ` +
        'Describe what changed in a sentence — never say you drew it from scratch, and do not repeat ' +
        'the instruction back.',
    }
  }

  return {
    ok: true,
    images,
    sources: [],
    text:
      `Drew ${images.length} image${images.length === 1 ? '' : 's'} with ${model} in ${secs}s` +
      `${size ? ` at ${size}` : ''}. The user can see ${images.length === 1 ? 'it' : 'them'} in the ` +
      'conversation now. Do not describe the picture as if you painted it and do not repeat the prompt ' +
      'back — just introduce it in a sentence or two.',
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
          'anything after your training cutoff. Returns ranked results with titles, URLs and snippets. ' +
          'When no search service is set up, the results come from reference sources instead, ' +
          'Wikipedia, programming questions, forum posts and books, and they say which source each ' +
          'came from: treat those as reference material and do not present them as a web search.',
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
  generate_image: {
    label: 'Image generation',
    describe: 'Draw a picture and show it in the chat, with fal.ai.',
    run: generateImage,
    schema: {
      type: 'function',
      function: {
        name: 'generate_image',
        description:
          'Create or change a picture and show it in the conversation. Call this whenever the user ' +
          'wants to SEE something rather than read about it: "create an image of …", "draw …", "make a ' +
          'picture / logo / poster / character of …", "show me how it would look", "what would X look ' +
          'like" — and equally when they want a picture that is already in the conversation changed: ' +
          '"add a hat to it", "make it blue", "change the background", "make it bigger", "recreate ' +
          'this but …". When they mean a picture that is already there — the one they attached, or one ' +
          'you drew — pass reference ("last" for the most recent, "attached" for the picture in their ' +
          'current message, or the picture’s name) and write the prompt as the instruction for that ' +
          'change. Anyone who says "it", "this" or "the image" means a picture that already exists, ' +
          'so pass reference — omitting it draws something new instead of changing theirs. ' +
          'Calling this with no reference draws a brand new one from scratch. ' +
          'Write the prompt as a rich visual description — subject, style, ' +
          'lighting, framing — because the words you send are the only instruction the image model gets. ' +
          'The picture appears in the conversation itself, so never answer a request like this by ' +
          'describing the scene in words instead of calling this tool.',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description:
                'What to draw, as a detailed visual description. Expand the user’s words into a prompt ' +
                'an image model can use: subject, setting, style, lighting, colours, framing. When ' +
                'editing with a reference, this is the instruction for the change.',
            },
            reference: {
              type: 'string',
              // No enum: the model is told about the pictures by name ("2. shot.png — drawn"), so it
              // must be allowed to name one back. The wording is imperative because omitting it is
              // silent and expensive: the instruction gets drawn from scratch instead of applied,
              // and the user sees a picture unrelated to what they asked for.
              description:
                'Which picture already in the conversation to change. "last" = the most recent one, ' +
                'whether the user attached it or you drew it. "attached" = the picture in the user’s ' +
                'current message. Or the picture’s exact name, as listed in the notes above. ' +
                'If the user’s message refers to a picture that already exists — "it", "this", ' +
                '"the image", "the one you made" — you MUST pass reference; leaving it out draws a ' +
                'brand new picture instead of changing theirs, which is not what they asked for. ' +
                'Leave it out only when they want something new drawn.',
            },
            count: { type: 'integer', description: 'How many images to make, 1-4 (default 1)' },
            size: {
              type: 'string',
              enum: falImages.SIZE_PRESETS.map((p) => p.id),
              description: 'Canvas shape. Defaults to what the user picked in Settings.',
            },
            // No `model` argument: the picture is drawn with whatever the user picked in the bar, so
            // the two doors cannot disagree about which endpoint made it.
          },
          required: ['prompt'],
        },
      },
    },

    },
    /* ---------------------------------------------------- connected apps (Composio) */

    list_connected_apps: {
      label: 'Connected apps',
      describe: "See which of the user's apps are connected and usable.",
      run: connectedApps,
      schema: {
        type: 'function',
        function: {
          name: 'list_connected_apps',
          description:
            "List the apps the user has connected (Gmail, Slack, Notion, Drive, and so on) and whether " +
            'each one is usable right now. Call this before assuming you can do something in one of ' +
            "their accounts. If nothing is connected, tell them where to connect it — do not pretend.",
          parameters: { type: 'object', properties: {} },
        },
      },
    },

    search_app_tools: {
      label: 'Find app actions',
      describe: 'Look up the actions a connected app offers, with the arguments each needs.',
      run: searchAppTools,
      schema: {
        type: 'function',
        function: {
          name: 'search_app_tools',
          description:
            "Find the exact action to call in one of the user's connected apps. Give the app slug and " +
            'what they want to do ("send", "create event", "read unread") and this returns the tool ' +
            'slugs with the arguments each expects. Call this before run_app_tool so the tool slug and ' +
            'its arguments are right.',
          parameters: {
            type: 'object',
            properties: {
              app: { type: 'string', description: 'The app slug, e.g. "gmail", "slack", "notion"' },
              query: { type: 'string', description: 'What the user wants to do, in a word or two' },
            },
            required: ['app'],
          },
        },
      },
    },

    run_app_tool: {
      label: 'Run an app action',
      describe: "Run an action in one of the user's connected accounts.",
      run: runAppTool,
      schema: {
        type: 'function',
        function: {
          name: 'run_app_tool',
          description:
            "Run one action in the user's connected account — send the email, create the event, post " +
            'the message. Get the exact tool slug and argument names from search_app_tools first. This ' +
            'really acts in their account, so say plainly what you did and report exactly what the app ' +
            'returned; never claim something was sent or posted unless the result says so.',
          parameters: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: 'The exact tool slug, e.g. "GMAIL_SEND_EMAIL"' },
              arguments: {
                type: 'object',
                description: 'The arguments for that action, named as search_app_tools showed them',
              },
            },
            required: ['tool'],
          },
        },
      },
    },
    create_document: {
      label: 'Create a document',
      describe: 'Write a file — a spreadsheet, a Word document, a PDF — and say where it went.',
      run: createDocument,
      schema: {
        type: 'function',
        function: {
          name: 'create_document',
          description:
            'Create a file and save it for the user: a spreadsheet, a document, a PDF or plain text. ' +
            'Use it whenever they ask for a file to be made, saved, exported or downloaded — a report, ' +
            'a list, a table, a letter. Give the content as text: for xlsx and csv put the headings on ' +
            'the first line and commas between columns, and they become a real table; in docx and pdf, ' +
            'lines starting with # become headings and - becomes a bullet. Names only, never a path — ' +
            'the file is saved in the folder the app uses. Never claim a file was saved without calling ' +
            'this, and tell the user where it went afterwards.',
          parameters: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['xlsx', 'csv', 'docx', 'pdf', 'md', 'txt', 'json'],
                description: 'The kind of file: xlsx = spreadsheet, docx = Word, pdf = PDF.',
              },
              filename: {
                type: 'string',
                description: 'A plain file name such as "quarterly-report.xlsx". No folders.',
              },
              title: { type: 'string', description: 'Optional title, shown at the top of docx and pdf files.' },
              content: {
                type: 'string',
                description:
                  'The contents as text. For xlsx and csv the first line is the column headings; for ' +
                  'docx and pdf, plain text where # makes a heading and - makes a bullet.',
              },
            },
            required: ['kind', 'content'],
          },
        },
      },
    },
  }

/* ------------------------------------------------- connected apps (Composio) */

/**
 * The tools that reach into a person's real accounts.
 *
 * Off unless the user switches them on. Everything else in this registry reads the world (a search,
 * a headline, a drawing); these can send an email, post a message or create a file in someone's live
 * account, so they are the one group that does not come along by default.
 *
 * The account id is filled in down in composio.cjs — the model names an app and a tool, never an
 * account, so it cannot invent one.
 */
/* ------------------------------------------------------- making documents */

/**
 * Write a document the user asked for and hand back where it went.
 *
 * The model supplies the words and a file name; the folder is chosen by the app (opts.docs.dir), and
 * create.cjs refuses anything that is a path rather than a name. The result carries `files`, which
 * main puts on the reply, so a spreadsheet reaches the user the same way a picture does.
 */
async function createDocument(args = {}, opts = {}) {
  const docs = opts.docs
  if (!docs || typeof docs.create !== 'function') {
    return { ok: false, error: 'Saving documents is not available in this build.' }
  }
  const r = await docs.create({
    kind: args.kind,
    filename: args.filename,
    title: args.title,
    content: args.content,
  })
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'Could not save that file.' }
  return { ok: true, text: r.text, files: [r.file], sources: [] }
}

const APP_TOOLS = new Set(['list_connected_apps', 'search_app_tools', 'run_app_tool'])

async function connectedApps(args, opts = {}) {
  const client = opts.apps && opts.apps.client
  if (!client) {
    return {
      ok: false,
      error:
        'Connected apps are not switched on. Turn them on in Settings → Connected apps, and add a Composio API key.',
    }
  }
  const r = await client.connections()
  if (!r.ok) return { ok: false, error: r.error }
  if (!r.connections.length) {
    return {
      ok: true,
      sources: [],
      text:
        'No apps are connected yet. The user has to connect them in Settings → Connected apps — ' +
        'nothing can be done in their accounts until they do. Tell them that rather than guessing.',
    }
  }
  const lines = r.connections.map(
    (c) => `- ${c.app}: ${c.status}${c.active ? ' (usable)' : ' (not usable)'}${c.reason ? ` — ${c.reason}` : ''}`,
  )
  return {
    ok: true,
    sources: [],
    text: `Apps connected right now:\n${lines.join('\n')}\nOnly ACTIVE ones can run actions.`,
  }
}

async function searchAppTools(args, opts = {}) {
  const client = opts.apps && opts.apps.client
  if (!client) return { ok: false, error: 'Connected apps are not switched on (Settings → Connected apps).' }
  const app = String(args.app || '').trim().toLowerCase()
  if (!app) return { ok: false, error: 'Which app? Pass its slug, for example "gmail" or "slack".' }
  const wanted = String(args.query || '').trim()
  const r = await client.toolsFor(app, wanted)
  if (!r.ok) return { ok: false, error: r.error }
  if (!r.tools.length) {
    return {
      ok: true,
      sources: [],
      text: `No actions matched "${wanted}" in ${app}. Try a broader word, or list without a query.`,
    }
  }
  const lines = r.tools.map((t) => {
    const params = t.input && t.input.properties ? Object.keys(t.input.properties) : []
    const required = (t.input && t.input.required) || []
    const args = params
      .map((p) => `${p}${required.includes(p) ? '' : '?'}`)
      .join(', ')
    return `- ${t.slug}${t.deprecated ? ' (deprecated)' : ''}: ${t.description.slice(0, 160)}${
      args ? `\n    arguments: ${args}` : ''
    }`
  })
  return {
    ok: true,
    sources: [],
    text:
      `Actions available in ${app}:\n${lines.join('\n')}\n\n` +
      'Run one with run_app_tool, passing the exact tool slug and its arguments as an object.',
  }
}

async function runAppTool(args, opts = {}) {
  const client = opts.apps && opts.apps.client
  if (!client) return { ok: false, error: 'Connected apps are not switched on (Settings → Connected apps).' }
  const tool = String(args.tool || args.slug || '').trim()
  if (!tool) return { ok: false, error: 'Which action? Pass the tool slug from search_app_tools.' }
  const callArgs = args.arguments && typeof args.arguments === 'object' ? args.arguments : {}
  const r = await client.runTool(tool, callArgs)
  if (!r.ok) return { ok: false, error: r.error }

  const payload = r.data === undefined ? null : r.data
  const asText =
    typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1).slice(0, 4000)
  return {
    ok: true,
    sources: [],
    text: `${tool} ran in the user's account. Result:\n${asText || '(the app returned nothing)'}`,
  }
}

const ALL_TOOLS = Object.keys(REGISTRY)

/**
 * Tool definitions in chat/completions shape, for the tools the config enables.
 *
 * `extra` carries the tools discovered on MCP servers. They are passed in rather than read from a
 * module-level list because they do not exist until a server has been started, and a list computed
 * once at load would leave every late-registered tool invisible forever.
 */
function chatToolDefs(cfg, extra = []) {
  // The master switch means no tools at all. Settings greys the per-tool toggles out when it
  // is off, so advertising tools anyway would contradict what the app says it is doing.
  if (cfg && cfg.toolsEnabled === false) return []
  const on = cfg.toolToggles || {}
  const built = ALL_TOOLS.filter((n) => {
    if (on[n] === false) return false
    // The connected-app tools act in someone's real accounts, so they stay hidden until the user
    // switches them on — and hidden for good without a key, rather than advertised and then refusing.
    if (APP_TOOLS.has(n) && !(cfg && cfg.apps && cfg.apps.enabled)) return false
    return true
  }).map((n) => REGISTRY[n].schema)
  const discovered = (Array.isArray(extra) ? extra : []).filter(
    (d) => d && d.function && d.function.name && on[d.function.name] !== false,
  )
  return [...built, ...discovered]
}

/** Same definitions flattened, which is what the Responses API expects. */
function responsesToolDefs(cfg, extra = []) {
  return chatToolDefs(cfg, extra).map((t) => ({ type: 'function', ...t.function }))
}

async function executeTool(name, argsRaw, opts = {}) {
  const tool = REGISTRY[name]
  let args = argsRaw
  if (typeof argsRaw === 'string') {
    try {
      args = argsRaw.trim() ? JSON.parse(argsRaw) : {}
    } catch {
      return { ok: false, name, error: `Arguments were not valid JSON: ${clamp(argsRaw, 200)}`, text: '', sources: [] }
    }
  }
  // A tool found on an MCP server is not in the registry: it runs over the protocol, through the
  // handle main passes in. Every failure here comes back as a failed tool result, so a hung or dead
  // server can never hang the chat.
  if (!tool && /^mcp__/.test(String(name || ''))) {
    const bridge = opts.mcp
    if (!bridge || typeof bridge.call !== 'function') {
      return { ok: false, name, error: `The MCP tool "${name}" is not available in this turn.`, text: '', sources: [] }
    }
    try {
      const r = await bridge.call(name, args || {})
      return {
        name,
        text: r.text || '',
        sources: [],
        images: r.images || [],
        files: r.files || [],
        ok: r.ok !== false,
        error: r.error || null,
      }
    } catch (err) {
      const why = String((err && err.message) || err)
      return { ok: false, name, error: `MCP server problem: ${why}`, text: `The MCP tool could not run: ${why}`, sources: [] }
    }
  }
  if (!tool) return { ok: false, name, error: `Unknown tool "${name}".`, text: '', sources: [] }
  try {
    const r = await tool.run(args || {}, opts)
    return {
      name,
      text: r.text || '',
      sources: r.sources || [],
      // only generate_image fills this in; every other tool leaves it empty
      images: r.images || [],
      // files the tool made. This was missing, and the failure is quiet and total: the document is
      // written, the model truthfully says it saved it, and nothing ever appears on the reply — the
      // same silent drop the image tool had before its return shape was widened.
      files: r.files || [],
      ok: r.ok !== false,
      error: r.error || null,
    }
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
  SEARCH_MODES,
  referenceSearch,
  keyedSearch,
  searxngSearch,
}
