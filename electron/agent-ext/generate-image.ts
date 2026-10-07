/**
 * generate_image, for the agent.
 *
 * The chat can make pictures; the agent could not. Asked to change one, it answered that it had no
 * way to, or described a picture it had not made. This is the same capability the composer has,
 * offered to the agent through Pi's own extension API, so the agent can actually do what it says.
 *
 * Two things a picture request really needs, and both are here: how many pictures to make, and a
 * picture that already exists to change rather than redraw from a description.
 *
 * The key and the folder paths arrive in the environment. Nothing secret is written into this file,
 * and nothing is written into the session: the picture is a file, and its path is the result.
 */
import { Type } from 'typebox'

const QUEUE = process.env.WORKBURO_FAL_QUEUE || 'https://queue.fal.run'
const SCHEMA = process.env.WORKBURO_FAL_SCHEMA || 'https://fal.ai/api/openapi/queue/openapi.json'
const KEY = process.env.WORKBURO_FAL_KEY || ''
const MODEL = process.env.WORKBURO_IMAGE_MODEL || 'fal-ai/flux-2/klein/9b'
const EDIT_MODEL = process.env.WORKBURO_IMAGE_EDIT_MODEL || MODEL
const IMAGES = process.env.WORKBURO_IMAGES_DIR || ''
const WORKSPACE = process.env.WORKBURO_WORKSPACE || ''
/**
 * The app's own server, on this machine, and a token that opens one route on it for this one turn.
 * When both are present the picture is made by the app rather than by this file: the same runner the
 * composer uses, so a workflow from the user's own ComfyUI works in agent mode exactly as it does
 * there, and nothing here has to know how that works.
 */
const API = process.env.WORKBURO_IMAGE_API || ''
const TOKEN = process.env.WORKBURO_IMAGE_TOKEN || ''

const SIZES = {
  square_hd: { width: 1024, height: 1024 },
  square: { width: 512, height: 512 },
  landscape_4_3: { width: 1024, height: 768 },
  landscape_16_9: { width: 1024, height: 576 },
  portrait_4_3: { width: 768, height: 1024 },
  portrait_16_9: { width: 576, height: 1024 }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** fal endpoints name the reference in one of these, most common first. */
const IMAGE_INPUT_KEYS = [
  'image_url',
  'image_urls',
  'image',
  'input_image',
  'image_reference',
  'reference_image',
  'init_image'
]

/** A reference travels inline as a data URI, so there is a size at which that stops being sane. */
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024

/**
 * Which of the model's own parameters takes the reference picture, if any. The app decides this the
 * same way, from fal's OpenAPI schema, so `image_url` is only sent to a model that declares it
 * instead of guessing and eating a 422. Reading a public schema needs no key.
 *
 * This mirrors electron/images.cjs rather than importing it on purpose: the app runs from an asar
 * archive, and a separate process cannot load a module out of one.
 */
async function schemaPropsFor (model) {
  try {
    const res = await fetch(`${SCHEMA}?endpoint_id=${encodeURIComponent(model)}`)
    if (!res.ok) return null
    const doc = await res.json()
    const comps = doc.components?.schemas || {}
    for (const [name, schema] of Object.entries(comps)) {
      if (/Input$/.test(name) && schema?.properties) return schema.properties
    }
    return null
  } catch {
    return null
  }
}

function imageParamFor (props) {
  for (const key of IMAGE_INPUT_KEYS) {
    const prop = props?.[key]
    if (!prop) continue
    return { key, isArray: prop.type === 'array' || Boolean(prop.items) }
  }
  const match = Object.keys(props || {}).find(
    (k) => /(^|_)images?(_|$)/.test(k) && !/num|count|size|format|strength|checker|per/.test(k)
  )
  if (!match) return null
  const prop = props[match]
  return { key: match, isArray: prop?.type === 'array' || Boolean(prop?.items) }
}

async function json (url, init) {
  const res = await fetch(url, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`expected JSON, got: ${text.slice(0, 200)}`)
  }
}

/** the extension a result should be saved with, from what fal says it is */
function extFor (contentType, url) {
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('png')) return 'png'
  if (ct.includes('webp')) return 'webp'
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg'
  const m = /\.(png|jpe?g|webp)/i.exec(String(url || ''))
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'png'
}

/** a name that says what the picture is, and stays a name a file system can hold */
function nameFor (prompt, index, total, ext) {
  const words = String(prompt || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && w.length > 2)
    .slice(0, 5)
    .join('-')
    .slice(0, 48)
  const tail = total > 1 ? `-${index + 1}` : ''
  return `${words || 'picture'}-${Date.now()}${tail}.${ext || 'png'}`
}

/**
 * Make the picture through the app's own server.
 *
 * The model comes from the environment, so it is whichever the user picked in the bar -- one of
 * their ComfyUI workflows included -- and an edit goes to the edit model for the same reason. The
 * reference is sent as a path: the app reads it off this machine, which is where it already is.
 */
async function throughApp (params, onUpdate) {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const model = params.image_path ? EDIT_MODEL || MODEL : MODEL
  const body: Record<string, unknown> = {
    prompt: params.prompt,
    count: params.count,
    size: params.size,
    model,
    json: true
  }

  if (params.image_path) {
    const given = String(params.image_path)
    const abs = path.isAbsolute(given) ? given : path.join(WORKSPACE || process.cwd(), given)
    if (!fs.existsSync(abs)) {
      throw new Error(`There is no picture at ${abs}. Use a path from the list of pictures you were given.`)
    }
    onUpdate?.({ content: [{ type: 'text', text: `Changing ${path.basename(abs)}…` }] })
    body.imageUrl = abs
  } else {
    onUpdate?.({ content: [{ type: 'text', text: 'Asking the app for the picture…' }] })
  }

  const res = await fetch(`${API}/api/image`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-workburo-image-token': TOKEN
    },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  let out: any
  try {
    out = JSON.parse(text)
  } catch {
    throw new Error(`The app answered with something unexpected: ${text.slice(0, 200)}`)
  }
  if (!out || !out.ok) throw new Error((out && out.error) || 'The app could not make the picture.')

  const came: any[] = Array.isArray(out.images) ? out.images : []
  const files = came.map((i) => i && i.path).filter(Boolean) as string[]
  if (!files.length) throw new Error('The picture came back but no file was written.')
  const first = came[0] || {}
  return {
    content: [
      {
        type: 'text',
        text:
          `Made ${files.length === 1 ? 'the picture' : `${files.length} pictures`} and saved ` +
          `${files.length === 1 ? 'it' : 'them'} as:\n${files.map((f) => `- ${f}`).join('\n')}\n` +
          `Size: ${first.width || '?'}x${first.height || '?'}` +
          `${params.image_path ? `, changed from ${params.image_path}` : ''}. ` +
          'Use the paths above if you need to refer to them.'
      }
    ],
    details: { files, count: files.length, prompt: params.prompt }
  }
}

export default function (pi) {
  pi.registerTool({
    name: 'generate_image',
    label: 'Generate image',
    description:
      'Create a picture from a written description and save it as a file. Use this whenever the user ' +
      'asks to see something, to draw it, to make a picture, poster or logo, or to change a picture ' +
      'that already exists. Do not describe the picture in words instead of making it. ' +
      'Set count to make more than one. Set image_path to an existing picture to change that picture ' +
      'rather than drawing a new one from the description alone; the list of pictures this app has ' +
      'made is given to you each turn. The result reports the full path of every file written.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'A detailed description of the picture to create' }),
      count: Type.Optional(
        Type.Number({ description: 'How many pictures to make, 1 to 4. Default 1.' })
      ),
      size: Type.Optional(
        Type.String({
          description:
            'One of square_hd, square, landscape_4_3, landscape_16_9, portrait_4_3, portrait_16_9'
        })
      ),
      image_path: Type.Optional(
        Type.String({
          description:
            'Full path of an existing picture to change, for example one you were told about. Leave ' +
            'out to draw something new.'
        })
      )
    }),
    async execute (_toolCallId, params, _signal, onUpdate) {
      // Asked through the app when the turn was given a way to reach it. This comes first on
      // purpose: a picture drawn by one of the user's own ComfyUI workflows needs no fal key, so a
      // key check before this would refuse to draw on a machine that is perfectly able to.
      if (API && TOKEN) return await throughApp(params, onUpdate)

      if (!KEY) {
        return {
          content: [
            {
              type: 'text',
              text: 'No image key is saved. Add a fal.ai key in WorkBuro settings under Images, then ask again.'
            }
          ],
          details: {}
        }
      }

      const model = params.image_path ? EDIT_MODEL || MODEL : MODEL
      const props = (await schemaPropsFor(model)) || {}
      const max = Number(props.num_images?.maximum) || 4
      const count = Math.max(1, Math.min(Math.round(Number(params.count) || 1), max))
      const body = { prompt: params.prompt }
      // Send the classic fields when the schema says the model takes them, or when it could not be
      // read at all. Never invent a field a model has not declared: that is a 422, not a picture.
      const declared = Object.keys(props).length > 0
      if (props.num_images || !declared) body.num_images = count
      if (props.image_size || !declared) body.image_size = SIZES[params.size] || SIZES.square_hd

      if (params.image_path) {
        const fs = await import('node:fs')
        const path = await import('node:path')
        const given = String(params.image_path)
        const abs = path.isAbsolute(given) ? given : path.join(WORKSPACE || process.cwd(), given)
        let buf = null
        try {
          buf = Buffer.from(fs.readFileSync(abs))
        } catch {
          throw new Error(`There is no picture at ${abs}. Use a path from the list of pictures you were given.`)
        }
        if (buf.length > MAX_REFERENCE_BYTES) {
          throw new Error(
            `That picture is too large to send (${Math.round(buf.length / 1048576)} MB). Use one this app generated, or describe the change in words.`
          )
        }
        const ext = path.extname(abs).slice(1).toLowerCase()
        const mime = ext === 'png' ? 'png' : ext === 'webp' ? 'webp' : ext === 'gif' ? 'gif' : 'jpeg'
        const param = imageParamFor(props)
        if (!param) {
          throw new Error(
            `${model} cannot take a picture to change. Ask for the change in words, or set an edit model in settings.`
          )
        }
        const uri = `data:image/${mime};base64,${buf.toString('base64')}`
        body[param.key] = param.isArray ? [uri] : uri
        // FLUX-style image-to-image re-draws from the prompt and only guides itself with the
        // reference; at fal's default the picture you sent comes back looking like a new one drawn
        // from your words, which is exactly what "it ignored my image" means. Instruction editors
        // such as nano-banana have no strength and need none.
        if (props.strength) body.strength = 0.85
        onUpdate?.({ content: [{ type: 'text', text: `Changing ${path.basename(abs)} with ${model}…` }] })
      } else {
        onUpdate?.({ content: [{ type: 'text', text: 'Asking fal.ai for the picture…' }] })
      }

      const submit = await json(`${QUEUE}/${model}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Key ${KEY}` },
        body: JSON.stringify(body)
      })

      const statusUrl = submit.status_url || `${QUEUE}/${model}/requests/${submit.request_id}/status`
      const responseUrl = submit.response_url || `${QUEUE}/${model}/requests/${submit.request_id}`
      if (!submit.request_id) {
        throw new Error(`fal.ai did not accept the request: ${JSON.stringify(submit).slice(0, 200)}`)
      }

      // The queue is asynchronous: ask until it is finished, then take the answer.
      let done = null
      for (let i = 0; i < 150; i++) {
        await sleep(i === 0 ? 1500 : 2000)
        const status = await json(statusUrl, { headers: { Authorization: `Key ${KEY}` } })
        if (status.status === 'COMPLETED') {
          done = await json(responseUrl, { headers: { Authorization: `Key ${KEY}` } })
          break
        }
        if (status.status === 'FAILED' || status.error) {
          throw new Error(`fal.ai failed: ${JSON.stringify(status).slice(0, 300)}`)
        }
        onUpdate?.({ content: [{ type: 'text', text: `Waiting for fal.ai… (${status.status || 'queued'})` }] })
      }
      if (!done) throw new Error('fal.ai did not finish within five minutes.')

      const came = (done.images || []).filter((i) => i && i.url)
      if (!came.length) throw new Error(`fal.ai returned no picture: ${JSON.stringify(done).slice(0, 200)}`)

      const fs = await import('node:fs')
      const path = await import('node:path')
      const written = []
      for (let i = 0; i < came.length; i++) {
        // an instruction editor answers with a jpeg, and naming that ".png" is a lie the viewer has
        // to guess its way out of, so the extension comes from what fal says it sent
        const res = await fetch(came[i].url)
        const bytes = Buffer.from(await res.arrayBuffer())
        const ext = extFor(came[i].content_type || res.headers?.get?.('content-type'), came[i].url)
        const file = nameFor(params.prompt, i, came.length, ext)
        for (const dir of [IMAGES, WORKSPACE].filter(Boolean)) {
          try {
            fs.mkdirSync(dir, { recursive: true })
            const target = path.join(dir, file)
            fs.writeFileSync(target, bytes)
            written.push(target)
          } catch {
            /* one of the two places is enough, but say which ones worked */
          }
        }
      }
      if (!written.length) throw new Error('The picture came back but could not be saved anywhere.')

      const first = came[0]
      const list = written.map((w) => `- ${w}`).join('\n')
      return {
        content: [
          {
            type: 'text',
            text:
              `Made ${came.length === 1 ? 'the picture' : `${came.length} pictures`} and saved ` +
              `${came.length === 1 ? 'it' : 'them'} as:\n${list}\n` +
              `Size: ${first.width || '?'}x${first.height || '?'}` +
              `${params.image_path ? `, changed from ${params.image_path}` : ''}. ` +
              'Use the paths above if you need to refer to them.'
          }
        ],
        details: { files: written, count: came.length, prompt: params.prompt }
      }
    }
  })
}
