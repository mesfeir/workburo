# Image generation — what shipped, and the local research

**Shipped: hosted generation through fal.ai.** Zen Chat generates images in the chat, using a
fal.ai key you supply in Settings → Images. That part is real, wired, and tested (see
[What shipped](#what-shipped-hosted-falai) below).

**Not wired in: local pipelines.** Sana-Sprint, SANA-1.5 and Flux 2 Klein 4B were measured on real
hardware and are *not* connected to the app — nothing in the local sections below runs when you
click Image. They are kept because the numbers cost real GPU time to produce and because local
generation is still the direction of travel. The scripts and ~26 GB of checkpoints live outside
this repo and are not redistributable from here.

## What shipped (hosted fal.ai)

Generation runs in the **main process**, never the renderer: the key stays out of the page, and
there is no CORS to negotiate. Specifically:

- **The model list is live.** `GET https://api.fal.ai/v1/models` with your key, paginated, filtered
  to `text-to-image` and `image-to-image`, with deprecated/removed endpoints dropped. That same
  call is the honest key test — fal answers `401` for a bad key. (It also answers `200` when no
  `Authorization` header is sent at all, which is why the app always sends one.)
- **Requests are schema-driven.** Before generating, the app fetches that endpoint's OpenAPI spec
  from `fal.ai/api/openapi/queue/openapi.json?endpoint_id=…` and sends **only** the parameters the
  model declares. `prompt` is always sent; `num_images` and `image_size` only if the schema has
  them, and `image_size` only if the value is in the schema's own enum. Sending a plausible-looking
  `image_size` to a model that doesn't take one is a 422 — so it isn't sent.
- **Generation goes through fal's queue**, not the blocking endpoint: submit → poll `status_url`
  until `COMPLETED` (reported to the UI as queued → generating → downloading) → fetch
  `response_url` → download → write to disk. Six-minute ceiling, 1.5 s polling.
- **Images are files, not blobs.** Each is written to `%APPDATA%\zen-chat\images\`, and only the
  path is kept in the conversation JSON. `writeStore` strips the data URL, `readStore` puts it back,
  so the store stays small and a picture deleted from disk renders as *Image file missing* instead
  of a broken image.
- **Money is the user's.** The app never invents a price. Where fal publishes pricing text for a
  model, it is shown under the picker; the per-model rate is whatever fal bills.
- **It is reached as a tool, not a mode.** `generate_image` lives in the same registry as web search
  and weather (`electron/tools.cjs`), so the model calls it when the user asks to see something, and
  Settings → Tools is its off switch. Main runs the generation and hands the finished attachments
  back to the reply, which is why the key never reaches the renderer. Progress (queued → generating
  → downloading) streams onto the tool row while fal works.

### Reference edits (image-to-image)

Attaching a picture changes the shape of the request, and the trigger is the attachment itself
rather than a mode you switch on:

- **Your words are the prompt.** When a message carries an image, the picture and the text you
  typed go to an edit endpoint together. Nothing rewrites the instruction — the model is not
  consulted, so there is no "here is what I see in your image" step and no re-described prompt.
  The reply is fal's picture, or fal's reason.
- **Which endpoint** is `editModel`, chosen in Settings → Images from fal's own `image-to-image`
  list. Two families behave very differently, and the picker says which is which:
  - **Instruction editors** — `fal-ai/nano-banana/edit` (the default, ~$0.04 an image),
    `fal-ai/flux-pro/kontext` (~$0.04), `openai/gpt-image-2/edit`, `…/seedream/…/edit`. These read
    your instruction and change *that* picture: subject, framing and details survive.
  - **Re-drawing image-to-image** — everything FLUX `…/image-to-image`. These make a new picture
    guided by yours, so details drift even when the instruction asks for one small change. Still
    offered, because occasionally that is what you want.
- **A strength that keeps your picture.** FLUX-style endpoints take a `strength`, and fal's default
  is 0.95 — high enough that the words win and your picture is only a hint. That is why "make it
  bigger" came back as a new picture. The app sends **0.85** whenever an endpoint declares a
  `strength`, and sends nothing at all to the instruction editors, which have no such parameter.
- **Which parameter** the reference goes in comes from that endpoint's schema, not from a guess:
  `image_url`, `image_urls` (a one-item list), `image`, `input_image`, `init_image` and similar are
  probed in that order, and counters or sizing options (`num_images`, `image_size`) are explicitly
  never mistaken for an image input. An endpoint that declares no image parameter is refused with
  *"…does not accept a reference image"* rather than being sent a prompt-only draw.
- **The reference travels inline** as a data URI, re-encoded in the main process with Electron's
  `nativeImage` and capped at 1536px on the long edge (and again at 1024px if the JPEG still
  exceeds 4 MB). A hard-to-decode reference fails the request outright — it never silently becomes a
  text-to-image draw.
- **An empty instruction is refused** before anything is sent: an edit with no change described has
  nothing to do.
- **The switch beside the thumbnail** ("Edit image" / "Ask about it") keeps the ordinary vision path
  reachable — attaching a picture to ask *what is in it* still works, it is just no longer the
  default gesture. The switch resets to **Edit image** when the attachments are cleared.
- **Editing a picture that is already in the conversation.** Nothing has to be re-attached: ask, and
  the model calls the image tool with a `reference`. `reference: "last"` is the most recent picture
  in the conversation — the one you attached, or the one just drawn; `reference: "attached"` is the
  picture in your current message. The model only *names* one and **main resolves the actual
  image**: a drawn picture is read back off disk when the store holds no URL for it, and a request
  with no picture to act on is refused plainly ("there is no picture in this conversation to
  change") instead of quietly drawing something unrelated. This is also how a model with no vision
  can still change a picture it cannot see.
- **The model is told what exists.** Every turn that can draw carries a line listing the
  conversation's pictures, oldest first, marking the most recent. Without it, "add a hat to it"
  reads as a request to draw something new — which is exactly how a picture came back recreated.
- **Cost** is the same per-megapixel rate as generation, billed on the output.

### Cost, for reference

fal prices by the megapixel, rounded up, so the floor matters more than the model choice:

| Model | Price | Notes |
|---|---|---|
| `fal-ai/flux/schnell` | $0.003/MP | 1–4 step distilled; the cheap default |
| `fal-ai/flux-2-pro` | ~$0.03/MP | reported in the catalogue |
| `fal-ai/nano-banana-pro` | ~$0.15/image | fal's own pricing text |

1024×1024 is 1.049 MP, so it rounds to 2 MP. Rendering at 1000×1000 stays inside one megapixel and
roughly halves the bill — worth knowing before generating a folder of wallpapers.

### How it is tested

`node scripts/test-images.cjs` runs two halves:

- **Offline** — a local stand-in replays fal's documented response shapes (submit → status → result
  → image bytes), so the polling loop, the schema-driven body, the download, the file write and the
  base64 round-trip are all asserted with no key and no network. Two of its checks exist purely to
  stop a future edit from leaking a parameter the model never declared.
- **Live** (with `FAL_KEY` set) — the real catalogue, a real per-model schema, a deliberately bad
  key, and one real generation.

## Local models, 1024×1024 (measured, not wired in)

| Model | Params | On disk | Cold load | Warm image | VRAM resident | VRAM peak | Licence | Quality |
|---|---|---|---|---|---|---|---|---|
| Sana-Sprint 1.6B (2 steps) | 1.6 B | 9.1 GB | 8.2–18.4 s | **0.46 s** | 9.07 GB | 10.86 GB | Apache-2.0 | draft |
| SANA-1.5 1.6B (20 steps) | 1.6 B | 9.1 GB | 7.6–18.4 s | 1.55 s | 9.06 GB | 10.85 GB | Apache-2.0 | fair |
| Flux 2 Klein 4B (10 steps) | 3.88 B | ~8.2 GB | ~24 s | 12.3 s | ~16 GB | 18.56 GB | Apache-2.0 | **best** |

- **Cold load is not a fixed number.** The same checkpoint measured 10.9 s and later 18.4 s —
  re-reading tens of GB evicts the OS disk cache. Quote a range.
- **VRAM tracks the text encoder, not the step count.** Both SANA variants sit at ~9.06 GB whether
  sampling 2 steps or 20, because the ~5.2 GB Gemma-2 encoder dominates. Fewer steps buys speed
  only.
- **Generation time is contention-sensitive.** SANA-1.5's 20 steps measured 3.15 s while ComfyUI
  held ~19 GB of the card, and 1.55 s with the GPU idle. A contended number compared against an
  idle one silently doubles the apparent gap between models.

![Four-way comparison: local Sana-Sprint, SANA-1.5 and Flux 2 Klein 4B against hosted FLUX.1 schnell](figures/image-model-comparison.png)

## The GPU spike, decomposed

The spike is the **weights**, not the act of sampling:

| Phase | Delta over idle |
|---|---|
| disk → RAM (`from_pretrained`) | +0.35 GB — CUDA context only |
| **weights resident in VRAM** | **+9.07 GB** |
| generation (activations) | +1.8 GB on top of resident |
| **total peak** | **~+11 GB** |

It all comes back: after `del` + `gc.collect()` + `empty_cache()` the card returns to idle
in-process, and process exit returns the last of it (9,211 MiB after exit vs 9,251 MiB before). No
leak, no residue.

![SANA VRAM usage traced at 200 ms resolution through load, generate and unload](figures/sana-vram-spike.png)

**Measurement note:** `torch.cuda.mem_get_info()` and `nvidia-smi` disagree by a constant ~7.5 GB
on this machine (Windows WDDM accounting). torch reported 1.67 GB idle / 13.05 GB peak; nvidia-smi
reported 9.25 GB / 20.46 GB for the same instants. The deltas agreed to within 0.4 GB — which is
why only deltas are quoted.

## Quality: hosted schnell against local Klein

On the same prompt and seed, `fal-ai/flux/schnell` scored roughly **3.5–4/10** against the free,
local **Klein 4B at ~7.5–8/10** — a glass facade with no mullions at all, no railing structure,
merged water/sky/concrete tones. schnell is a 1–4 step distilled model, so 4 steps is its ceiling
and no setting recovers the detail.

That verdict shaped the shipped defaults rather than the decision to ship: schnell is the default
because it is fast and cheap, and the picker exists precisely so you can move up to a model whose
quality you are willing to pay for. The comparison is only about the cheapest model on fal, not
about hosted generation as such.

## What it costs

Every model in the picker is priced where fal publishes a price, and the chosen model gets an exact
figure for the size and count selected — `$0.025 per megapixel · $0.05 per image at this size (fal
bills 2 MP — a part megapixel rounds up)`.

Two sources, in this order:

1. **fal's pricing API** (`api.fal.ai/v1/models/pricing`) answers for one endpoint at a time with a
   number and a unit — `0.025 megapixels`, `0.15 images`. This is the one that answers for models
   the catalogue says nothing about, which includes `fal-ai/flux/dev`, the model this app starts on.
   It needs the account key, and one request per model, so rates are kept on disk for a week and
   only models actually chosen are ever asked about. A lookup that found nothing is never cached:
   a failure must not become the answer for a week.
2. **fal's public catalogue** states a price in prose for 735 of 1,504 models, which is what the
   picker rows show while browsing, and is used as the arithmetic fallback.

Where fal publishes no rate, the panel says so rather than guessing. Units that are not about
images or megapixels (seconds of compute) get no per-image number either — the rate is shown and
the panel says the total depends on the run.

## What the row says while it works

fal's queue reports a *position*, and position 0 means "next in line" — which rendered as a bare
**0** on screen and looked like a failure. Every phase now carries words: `Sending to <model>…`,
`Waiting in the queue…` (or `— 3 requests ahead…`), `Generating image…`, `Saving image 1 of 1…`.
The renderer phrases anything that arrives without a label, so a raw number can never be shown on
its own again. Covered by `npm run test:pricing`, which drives a whole run against a stand-in that
reports position 0.

## Follow-ups: talking about the picture you just made

"make it bigger", "change the colours" — after a picture has been created or edited, the next
message is about *that* picture:

- The picture becomes the composer's reference the moment it is made, so an instruction like
  "make it bigger" goes straight to fal with your words as the prompt. No chat model sits in the
  middle describing it, so the change you typed is the change that is made.
- Asking *about* the picture goes to the chat model instead, which needs a model that reads
  pictures.

Two rules keep the conversation valid, both learned from real 400s from the relay:

1. **A picture is never put on an assistant turn.** The relay refuses it outright — *"Image in
   assistant message is not supported"* — and one such turn breaks the whole conversation. A
   picture the app made is recorded in that turn's text instead, so the model still knows a
   picture exists.
2. **A picture is only sent to a model confirmed to read pictures.** A model that cannot read one
   rejects the request, and because the picture stays in the conversation history, every later
   message fails the same way. `unknown` is not treated as a yes: if a model rejects a request
   that carried a picture, the request is retried with the picture described in words, a notice
   says why, and that model is remembered as text-only so it is never asked again.

Both rules live in `electron/messages.cjs` and are covered by `npm run test:messages`, which
replays a real conversation containing a picture against the configured model.

## Why local is still the interesting direction

1. **Local generation can keep the GPU free.** The thing that holds this GPU is a resident ComfyUI
   holding ~19–20 GB with an empty queue — not generation. A lazy-load worker costs ~14 s per
   warm-tier image (disk → RAM → VRAM → sample) and **~0 GB between requests**, because these
   pipelines genuinely release their memory. That is the whole design goal, met without spending
   anything per image.
2. **Do not buy schnell to save a busy GPU.** It costs money and loses to a model that runs locally
   for free. Paying for hosted only makes sense as a fallback when the GPU is busy with something
   else — and then it is worth paying for a real tier rather than the cheapest one.
3. **Flux 2 Klein 4B is the only candidate that produces architecture worth looking at** in this
   set, at ~4× the time and ~8 GB more VRAM than SANA-1.5. It also does instruction-based *editing*
   with reference images, not just text-to-image — which is what a photo-transform feature would
   actually need.
4. **Licences matter more than benchmarks.** SANA and Klein 4B are Apache-2.0. The Qwen-Image family
   is under a research/non-commercial licence and needs ~33 GB in bf16 (GGUF quants bring the
   transformer to ~4.6–7.6 GB but make it a ComfyUI-only route), so it is out on both size and
   licence grounds.
5. **The blocker is distribution, not capability.** A local tier means shipping or downloading a
   checkpoint *plus its text encoder and VAE*, and managing where all of it lands. That is a
   first-run experience of its own, which is why hosted went first.

## If local ships, the shape is

A small sidecar service in front of the models — `POST /generate {pipeline, prompt, size, steps,
seed} → PNG`, with pipelines described as data, a keep-warm timeout, and an honest "loading model…"
state in the UI so the first image of a session is never a silent 14-second stall. It would load on
demand and unload when idle, so the GPU is idle when you are not generating. The provider field in
the config (`imageGen.provider`, currently `'fal'`) exists so a local provider can sit beside the
hosted one rather than replacing it.

Still open: which tier is the default, whether the encoder is parked on CPU (~4 GB less resident,
slower), how a model download is offered and verified, and whether a per-provider fallback (local
unless the GPU is busy) is worth the complexity.
