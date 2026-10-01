/**
 * generate_image, for the agent.
 *
 * The chat can make pictures; the agent could not. Asked to change one, it answered that it had no
 * way to, or described a picture it had not made. This is the same capability the composer has,
 * offered to the agent through Pi's own extension API, so the agent can actually do what it says.
 *
 * The key and the folder paths arrive in the environment. Nothing secret is written into this file,
 * and nothing is written into the session: the picture is a file, and its path is the result.
 */
import { Type } from 'typebox'

const QUEUE = process.env.WORKBURO_FAL_QUEUE || 'https://queue.fal.run'
const KEY = process.env.WORKBURO_FAL_KEY || ''
const MODEL = process.env.WORKBURO_IMAGE_MODEL || 'fal-ai/flux-2/klein/9b'
const IMAGES = process.env.WORKBURO_IMAGES_DIR || ''
const WORKSPACE = process.env.WORKBURO_WORKSPACE || ''

const SIZES = {
  square_hd: { width: 1024, height: 1024 },
  square: { width: 512, height: 512 },
  landscape_4_3: { width: 1024, height: 768 },
  landscape_16_9: { width: 1024, height: 576 },
  portrait_4_3: { width: 768, height: 1024 },
  portrait_16_9: { width: 576, height: 1024 }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

/** a name that says what the picture is, and stays a file system can hold */
function nameFor (prompt) {
  const words = String(prompt || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && w.length > 2)
    .slice(0, 5)
    .join('-')
    .slice(0, 48)
  return `${words || 'picture'}-${Date.now()}.png`
}

export default function (pi) {
  pi.registerTool({
    name: 'generate_image',
    label: 'Generate image',
    description:
      'Create a picture from a written description and save it as a file. Use this whenever the user ' +
      'asks to see something, to draw it, to make a picture, poster or logo, or to change a picture ' +
      'that already exists. Do not describe the picture in words instead of making it. The result ' +
      'reports the full path of the file that was written.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'A detailed description of the picture to create' }),
      size: Type.Optional(
        Type.String({
          description:
            'One of square_hd, square, landscape_4_3, landscape_16_9, portrait_4_3, portrait_16_9'
        })
      )
    }),
    async execute (_toolCallId, params, _signal, onUpdate) {
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

      onUpdate?.({ content: [{ type: 'text', text: 'Asking fal.ai for the picture…' }] })

      const body = {
        prompt: params.prompt,
        num_images: 1,
        image_size: SIZES[params.size] || SIZES.square_hd
      }
      const submit = await json(`${QUEUE}/${MODEL}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Key ${KEY}` },
        body: JSON.stringify(body)
      })

      const statusUrl = submit.status_url || `${QUEUE}/${MODEL}/requests/${submit.request_id}/status`
      const responseUrl = submit.response_url || `${QUEUE}/${MODEL}/requests/${submit.request_id}`
      if (!submit.request_id) {
        throw new Error(`fal.ai did not accept the request: ${JSON.stringify(submit).slice(0, 200)}`)
      }

      // The queue is asynchronous: ask until it is finished, then take the answer.
      let done = null
      for (let i = 0; i < 90; i++) {
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
      if (!done) throw new Error('fal.ai did not finish within three minutes.')

      const first = (done.images || [])[0] || {}
      if (!first.url) throw new Error(`fal.ai returned no picture: ${JSON.stringify(done).slice(0, 200)}`)

      const bytes = Buffer.from(await (await fetch(first.url)).arrayBuffer())
      const file = nameFor(params.prompt)
      const fs = await import('node:fs')
      const path = await import('node:path')

      const written = []
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
      if (!written.length) throw new Error('The picture came back but could not be saved anywhere.')

      return {
        content: [
          {
            type: 'text',
            text: `Made the picture and saved it as:\n${written.map((w) => `- ${w}`).join('\n')}\nIt is ${first.width || '?'}x${first.height || '?'}. Use the path above if you need to refer to it.`
          }
        ],
        details: { file: written[0], files: written, prompt: params.prompt }
      }
    }
  })
}
