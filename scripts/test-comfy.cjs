/**
 * Where the inputs are in a ComfyUI graph, tested against the real module.
 *
 * This is the part of the ComfyUI path that can be wrong on a workflow nobody has seen: the user
 * exports whatever they built, and the app has to find the prompt, the picture to edit and the
 * seeds by reading the wiring. The cases below are the ones that actually bite:
 *
 *   - A graph whose "negative" is the zeroed positive (the Flux2 edit templates). Treating that as
 *     a negative prompt would overwrite the user's own prompt with nothing.
 *   - A prompt that reaches the guider through a combine or a zero-out, rather than directly.
 *   - A file that is the editor's own format, which must be refused with the fix named rather than
 *     run and fail somewhere inside ComfyUI.
 *
 * Nothing is reimplemented: the module under test is the one the app runs.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const comfy = require(path.join(__dirname, '..', 'electron', 'comfy.cjs'))

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** A text-to-image graph with a base pass and a hires pass, the shape these workflows really have. */
function txt2img() {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'flux-2-klein-4b.safetensors', weight_dtype: 'default' } },
    '9': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'flux2' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { clip: ['9', 0], text: 'the prompt in the file' } },
    '3': { class_type: 'CLIPTextEncode', inputs: { clip: ['9', 0], text: '' } },
    '4': { class_type: 'CFGGuider', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], cfg: 1 } },
    '5': { class_type: 'EmptyFlux2LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '6': { class_type: 'RandomNoise', inputs: { noise_seed: 1045476173425301 } },
    '8': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '10': { class_type: 'Flux2Scheduler', inputs: { steps: 4, width: 1024, height: 1024 } },
    '7': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['6', 0], guider: ['4', 0], sampler: ['8', 0], sigmas: ['10', 0], latent_image: ['5', 0] } },
    '12': { class_type: 'VAELoader', inputs: { vae_name: 'flux2-vae.safetensors' } },
    '11': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['12', 0] } },
    '20': { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: 'Klein-BASE' } },
    '25': { class_type: 'LatentUpscaleBy', inputs: { samples: ['7', 0], scale_by: 1.5 } },
    '23': { class_type: 'RandomNoise', inputs: { noise_seed: 987654321 } },
    '24': { class_type: 'SplitSigmasDenoise', inputs: { sigmas: ['26', 0], denoise: 0.45 } },
    '26': { class_type: 'Flux2Scheduler', inputs: { steps: 6, width: 1536, height: 1536 } },
    '22': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['23', 0], guider: ['4', 0], sampler: ['8', 0], sigmas: ['24', 1], latent_image: ['25', 0] } },
    '21': { class_type: 'VAEDecode', inputs: { samples: ['22', 0], vae: ['12', 0] } },
    '200': { class_type: 'SaveImage', inputs: { images: ['21', 0], filename_prefix: 'Klein-HIRES' } },
  }
}

console.log('\na graph that draws from words')
{
  const d = comfy.detect(txt2img())
  check('the prompt is the text encoder feeding the guider', d.positive && d.positive.id === '2', d.positive && d.positive.id)
  check('and its field is the text widget', d.positive && d.positive.field === 'text')
  check('the negative is its own text encoder', d.negative && d.negative.id === '3', d.negative && d.negative.id)
  check('there is no picture to edit, so it draws', d.kind === 'txt2img', d.kind)
  check('it finds no image input', d.image === null)
  check('both noise nodes are found, base and hires', d.seeds.map((s) => s.id).join(',') === '6,23', d.seeds.map((s) => s.id).join(','))
  check('the seed field is noise_seed', d.seeds.every((s) => s.field === 'noise_seed'))
  check('both save nodes are found', d.saves.map((s) => s.id).join(',') === '20,200', d.saves.map((s) => s.id).join(','))
  check('the later save is last, so it is the finished picture', d.saves[d.saves.length - 1].id === '200')
  check('nothing is reported missing', d.missing.length === 0, d.missing.join(','))
  check('it reports itself ok', d.ok === true)
}

console.log('\na graph that changes a picture you give it')
{
  const g = txt2img()
  g['30'] = { class_type: 'LoadImage', inputs: { image: 'pasted/image (537).png' } }
  g['31'] = { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['30', 0], megapixels: ['32', 0], upscale_method: 'nearest-exact' } }
  g['32'] = { class_type: 'PrimitiveFloat', inputs: { value: 1 } }
  g['33'] = { class_type: 'VAEEncode', inputs: { pixels: ['31', 0], vae: ['12', 0] } }
  // the Flux2 edit shape: the negative branch is the zeroed positive, not a prompt of its own
  g['3'] = { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['2', 0] } }
  g['34'] = { class_type: 'ReferenceLatent', inputs: { conditioning: ['2', 0], latent: ['33', 0] } }
  g['4'] = { class_type: 'CFGGuider', inputs: { model: ['1', 0], positive: ['34', 0], negative: ['3', 0], cfg: 1 } }

  const d = comfy.detect(g)
  check('the picture to edit is the LoadImage', d.image && d.image.id === '30', d.image && d.image.id)
  check('the field it goes in is image', d.image && d.image.field === 'image')
  check('having an image input makes it an edit', d.kind === 'edit', d.kind)
  check('the prompt is still found through the reference latent', d.positive && d.positive.id === '2', d.positive && d.positive.id)
  check(
    'a zeroed negative is NOT reported as a negative prompt',
    d.negative === null,
    d.negative ? `found ${d.negative.id} — writing a negative would clobber the prompt` : undefined,
  )
  check('the value baked into LoadImage is reported, so it can be replaced', d.image && d.image.value === 'pasted/image (537).png')
}

console.log('\nwalking back through conditioning')
{
  const g = txt2img()
  g['40'] = { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['2', 0], conditioning_2: ['41', 0] } }
  g['41'] = { class_type: 'ConditioningSetTimestepRange', inputs: { conditioning: ['42', 0], start: 0, end: 0.5 } }
  g['42'] = { class_type: 'CLIPTextEncode', inputs: { clip: ['9', 0], text: 'a second, later prompt' } }
  g['4'] = { class_type: 'CFGGuider', inputs: { model: ['1', 0], positive: ['40', 0], negative: ['3', 0], cfg: 1 } }
  const d = comfy.detect(g)
  check('a prompt behind a combine is still found', d.positive && d.positive.id === '2', d.positive && d.positive.id)
  check('and the negative is still its own node', d.negative && d.negative.id === '3', d.negative && d.negative.id)
}

console.log('\nthe graphs that cannot be used, said plainly')
{
  const noGuider = { '2': { class_type: 'CLIPTextEncode', inputs: { text: 'orphan' } }, '20': { class_type: 'SaveImage', inputs: { images: ['2', 0] } } }
  const d = comfy.detect(noGuider)
  check('with no guider the prompt is reported missing', d.missing.includes('prompt'), d.missing.join(','))
  check('and it does not claim to be ok', d.ok === false)

  check('an empty graph does not throw', comfy.detect({}).ok === false)
  check('a graph with no saves lists none', comfy.detect(txt2img()).saves.length === 2)
  const g = txt2img()
  delete g['20']
  delete g['200']
  check('a graph that saves nothing has no save nodes', comfy.detect(g).saves.length === 0)
}

console.log('\nreading the file')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-comfy-'))
  const apiFile = path.join(dir, 'my-workflow-API.json')
  fs.writeFileSync(apiFile, JSON.stringify(txt2img()))
  const r = comfy.readWorkflow(apiFile)
  check('an API-format file is read', r.ok === true, r.error)
  check('the name comes from the filename', r.name === 'my-workflow-API', r.name)
  check('the kind comes from the graph', r.kind === 'txt2img', r.kind)
  check('the node count is reported', r.nodes === Object.keys(txt2img()).length, r.nodes)

  const editorFile = path.join(dir, 'editor.json')
  fs.writeFileSync(editorFile, JSON.stringify({ nodes: [{ id: 1 }], links: [], last_node_id: 1 }))
  const e = comfy.readWorkflow(editorFile)
  check('the editor format is refused', e.ok === false)
  check('and the fix is named in the message', /Export \(API\)/.test(e.error || ''), e.error)

  const notJson = path.join(dir, 'nope.json')
  fs.writeFileSync(notJson, 'this is not json')
  check('a file that is not JSON is refused', comfy.readWorkflow(notJson).ok === false)

  const other = path.join(dir, 'package.json')
  fs.writeFileSync(other, JSON.stringify({ name: 'x', version: '1.0.0' }))
  const o = comfy.readWorkflow(other)
  check('a JSON file that is not a workflow is refused', o.ok === false)
  check('and it says so rather than guessing', /API-format/.test(o.error || ''), o.error)

  check('a file that is not there is refused', comfy.readWorkflow(path.join(dir, 'missing.json')).ok === false)
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\nthe ports it will try')
{
  check('8188, ComfyUI own default, is tried first', comfy.DEFAULT_PORTS[0] === 8188, comfy.DEFAULT_PORTS.join(','))
  check('and the Desktop build port is tried too', comfy.DEFAULT_PORTS.includes(8000), comfy.DEFAULT_PORTS.join(','))
  check('a base URL is built from host and port', comfy.baseFor('127.0.0.1', 8000) === 'http://127.0.0.1:8000', comfy.baseFor('127.0.0.1', 8000))
  check('and falls back to the default port', comfy.baseFor('127.0.0.1', 0) === 'http://127.0.0.1:8188', comfy.baseFor('127.0.0.1', 0))
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
