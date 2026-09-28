<div align="center">

<img src="build/icon.png" alt="Zen Chat — Windows AI chat client icon" width="96" height="96">

# Zen Chat

**A native Windows desktop client for any OpenAI-compatible API — bring your own key.**

[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4?logo=windows&logoColor=white)](#install)
[![Electron](https://img.shields.io/badge/Electron-35-47848F?logo=electron&logoColor=white)](#architecture)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](#architecture)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](#architecture)
[![Telemetry](https://img.shields.io/badge/telemetry-none-brightgreen)](#privacy--your-api-key)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-blueviolet)](#contributing)

[Features](#features) · [Install](#install) · [First run](#first-run) · [Tools](#tools-so-the-model-can-reach-the-real-world) · [Privacy](#privacy--your-api-key) · [Build](#build-from-source) · [FAQ](#faq)

</div>

If you've used a modern AI chat app, you already know the shape of this one: a dark sidebar
full of your recents, a pill-shaped composer, answers that stream in with tables, syntax-
highlighted code and a collapsible *Thought for Ns* block. Zen Chat is that experience with
one thing changed — **no account, no subscription, no bundled model**. It runs on whichever
endpoint you point it at, using your own API key.

Everything you'd expect from a modern AI chat client is here, and **nothing is faked**: any
feature that isn't finished is disabled and labelled *coming soon* rather than stubbed out to
look complete.

![Zen Chat answering a question with streamed markdown, a syntax-highlighted code block with a copy button, a rendered table, and a collapsed thinking block](docs/screenshots/readme-app.png)

---

## Features

**Bring your own everything**

- **Any OpenAI-compatible endpoint** — OpenCode Zen (Go), OpenAI, Azure, OpenRouter, Groq,
  Together, DeepSeek, Mistral, LM Studio, Ollama, vLLM, llama.cpp, LocalAI, or your own
  gateway. One base URL field, with presets for the common ones.
- **No account, no subscription, no telemetry.** The app has no server of its own. Your key,
  your endpoints, your data, on your disk.
- **Model discovery** — pulls `/models` from your endpoint and lets you switch model per
  conversation from the header.
- **Live capability probing** — the ⚡ button runs a real text call *and* a real image call to
  find out whether a model accepts images, whether it reasons, and which wire protocol it
  wants. Results are remembered per model, and the picker shows an eye, a brain and a `resp`
  badge. No more guessing which of three similarly-named models can actually see.

**It keeps working when the endpoint is awkward**

- **Two protocols, auto-negotiated.** Chat Completions first; on `ModelProtocolUnsupported` it
  transparently retries over the **Responses** API. Some relays require it, and you shouldn't
  have to know which.
- **Reasoning-aware.** `reasoning_content` streams into a collapsed *Thought for Ns* block, a
  `max_tokens` floor stops hidden thinking from silently eating the answer, and a model that
  rejects the `reasoning_effort` knob is retried without it.
- **Relay quirks handled, not documented at you.** Missing session headers, branding checks on
  the User-Agent, `/v1` pasted twice, a full `/chat/completions` path pasted instead of the
  root — all normalised, with readable errors instead of mystery HTML.

**A real chat client**

- **Streaming markdown** — GFM tables, lists, and syntax-highlighted code blocks with
  per-block copy.
- **Images in** — paste from the clipboard, drag & drop, or use the `+` button. Downscaled
  before they're sent.
- **Regenerate, stop, copy, vote** on any answer. Search, rename, pin and delete chats.
- **Token usage** per message, when you want to see it.
- **Local-first storage** — every conversation in one JSON file you can open, back up, or
  hand-edit. No database, no cloud sync, no lock-in.

**Made to be summoned, not opened**

- **Global summon hotkey** (default `Alt+Space`, rebindable) shows and hides the window like a
  launcher. If Windows refuses the shortcut because another app holds it, Zen Chat walks a
  fallback list and then *tells you* which key is live — it never fails silently.
- **Tray icon always present**, so a hidden window is never a lost window.
- **Small by default** — opens at 485×663 so it can sit beside your work. Size and position are
  remembered, the sidebar collapses to a drawer at narrow widths, and it springs back when you
  widen the window again.
- **Start with Windows**, optionally, and quietly in the tray — no window stealing focus at
  login.
- **Input rail** — small ticks down the right edge, one per message you sent. Hover one to
  preview it, click it to jump straight back to that point in the conversation. It only appears
  when the transcript actually scrolls, and sits beside the scrollbar rather than over it.
- **Instructions** — standing instructions ("Keep it short", "Answer directly", "Be friendly")
  applied in every conversation, with one-click presets. They take effect from your next
  message; no new chat needed.
- **Keyboard-first** — see [keyboard shortcuts](#keyboard).

## Tools, so the model can reach the real world

The model can call tools, then answer from what came back. Every call is shown above the reply
with what it asked for and what it returned, and cited pages are listed underneath.

| Tool | What it does | Needs a key? |
|---|---|---|
| **Web search** | Queries your own SearXNG endpoint | No |
| **Read a page** | Fetches a URL and extracts the text | No |
| **Weather** | Live conditions and forecast via Open-Meteo | No |
| **Time** | Current date and time | No |

Some models additionally have **genuine server-side search** on the relay; Zen Chat uses that
when it's available, and hides its own duplicate so the request doesn't 400.

All networking and tool execution happens in the **main process** — one place holding the key,
no CORS to fight, nothing executing in the page. The whole system, individual tools and the
search backend are all toggleable in Settings → Tools, which also has a live test button so
"search is broken" can be diagnosed in one click.

![Zen Chat calling a weather tool, showing the tool row, its result and the cited source](docs/screenshots/readme-tools.png)

## Install

There is **no prebuilt binary published yet** — `release/` is gitignored and no GitHub release
has been cut. Build the installer yourself:

```bash
git clone git@github.com:mesfeir/zenchat-desktop.git
cd zenchat-desktop
npm install
npm run dist     # -> release/Zen-Chat-Setup-<version>.exe
```

`npm run dist` produces an NSIS installer and a portable `.exe`. The installer is **unsigned**,
so SmartScreen will show "unknown publisher" until you sign it with your own certificate.

## First run

1. Open **Settings** (gear, bottom-left, or `Ctrl+,`) → **API & key**.
2. Pick a preset or paste a base URL — for example `https://opencode.ai/zen/go/v1`.
3. Paste your key and hit **Test connection**. The model list loads on success.
4. In **Models**, hit ⚡ on the models you care about so their real capabilities are recorded.

![Zen Chat settings, showing endpoint presets, the base URL and a masked API key field](docs/screenshots/readme-settings.png)

## Keyboard

| Key | Action |
|---|---|
| *your summon shortcut* | Show/hide Zen Chat from anywhere in Windows (default `Alt+Space`) |
| `Ctrl+N` | New chat |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+K` | Search chats |
| `Ctrl+,` | Settings |
| `Enter` / `Shift+Enter` | Send / newline |
| `Esc` | Close the sidebar drawer, or stop generating |

### Why your summon shortcut might not be `Alt+Space`

Windows gives a global shortcut to whoever asks first, and `Alt+Space` is already taken on
plenty of machines (PowerToys Run takes it by default). Zen Chat handles that honestly: it
tries your shortcut, walks a fallback list (`Ctrl+Alt+Space`, `Alt+Shift+Space`, `Ctrl+Alt+K`,
`Ctrl+Shift+A`), and shows an amber banner telling you which key is actually live, with a button
straight to the setting. Settings → General shows what is live separately from what you asked
for. If nothing registers at all, the app shows its window rather than starting hidden — you
can't get locked out of it.

## Works with

Anything that speaks the OpenAI API shape. Reported working configurations include OpenCode
Zen / Go, OpenAI and OpenAI-compatible gateways, OpenRouter, Groq, Together, DeepSeek, Mistral,
Azure OpenAI, LM Studio, Ollama, vLLM, llama.cpp's server, LocalAI, and self-hosted
`text-generation-webui`.

If your endpoint has a quirk this app doesn't handle, that's a bug worth filing.

## Architecture

```
electron/main.cjs      window + bounds persistence, global shortcut, tray, login item,
                       on-disk store, streaming network layer, protocol negotiation
electron/tools.cjs     tool definitions per protocol + the execution registry
electron/capture.cjs   regenerates the README screenshots from the real UI
electron/selftest.cjs  end-to-end harness: drives the real UI, writes screenshots + a report
electron/preload.cjs   narrow contextBridge surface (no Node in the page)
src/App.tsx            state orchestration, rAF-batched streaming into React, compact layout
src/components/        Sidebar, ChatView, Message, Composer, ModelPicker, SettingsModal
src/lib/Markdown.tsx   react-markdown + rehype-highlight + copy button
src/lib/image.ts       downscaling, clipboard/file image intake, probe image
```

**All network calls run in the main process.** That isn't an optimisation: many relays send no
CORS headers on `POST /chat/completions`, so a renderer-side `fetch` can never reach them.
Proxying through main also keeps your API key out of the page. The renderer gets a narrow,
explicit IPC surface and a real Content-Security-Policy with `connect-src 'self'`.

## Privacy & your API key

- **No telemetry, no analytics, no phone-home.** The app has no backend.
- **Your key never leaves your machine** except as an `Authorization` header to the endpoint
  *you* configured. It's held in the main process and never exposed to the page.
- **Prompt content goes only to your endpoint** — plus, when you enable tools, to the search
  endpoint you configured and to Open-Meteo for weather. Nothing else is contacted.
- **Storage:** config and every conversation live in one JSON file at
  `%APPDATA%\zen-chat\zen-chat-store.json` (Settings → About → *Open folder*). Window size and
  position are kept separately in `window-state.json`. Nothing is written anywhere else.
- **Honest caveat: that file stores the API key in plain text on your own disk.** It's a
  deliberate trade for transparency and hand-editability, and it's the one thing worth knowing
  before you file a security issue. Encrypting that field with Windows DPAPI is an open
  enhancement.

## Build from source

```bash
npm install
npm run dev      # Vite dev server + Electron with devtools
npm run build    # type-check + bundle the renderer into dist/
npm run dist     # full Windows installer + portable exe into release/
```

## Self-test and screenshots

The app ships with an end-to-end harness that drives the **real** window — typing into the real
composer, pasting a real image, switching models, reloading — and asserts on what actually
rendered. It covers the shell, the compact layout, model discovery, a streamed completion,
markdown and table rendering, image input on a vision model, protocol fallback, error
surfacing, the settings modal, persistence across a reload, the summon shortcut (registered /
disclosed / toggled / rebound / restored) and the start-with-Windows round trip.

```bash
# with the dev server running
npx electron . --selftest <api-key>
```

It writes screenshots plus a `report.json` to `ZEN_SHOT_DIR` (default `%TEMP%\..\zen-shots`),
and leaves the start-with-Windows registry entry **disabled** on purpose.

The README screenshots are regenerated the same way, from the real UI, against an isolated
seeded profile:

```bash
npx electron . --capture <api-key>
```

## Roadmap

- **Image generation** — researched and measured, not shipped. Local Sana-Sprint / Flux 2 Klein
  and a hosted fallback were benchmarked for speed, VRAM and quality; the full write-up,
  including why the hosted option was rejected, is in
  [`docs/image-generation.md`](docs/image-generation.md). The **Images** entry in the sidebar
  stays disabled until this is real.
- **Encrypted key storage** (Windows DPAPI).
- **Voice input**, and the **Library / Scheduled / Plugins / Projects** entries — currently
  disabled and labelled *coming soon*.

## Known limitations

- **The installer is unsigned.** SmartScreen will warn until it's signed.
- **Windows only.** The code is cross-platform-shaped but only packaged and tested for Windows.
- **The API key is stored in plain text** in the app's own JSON file. See
  [Privacy](#privacy--your-api-key).
- **"Start with Windows" writes a normal per-user `Run` entry**, so it also appears in Task
  Manager → Startup apps. It can be turned off from either place.
- **Token counts and costs are whatever your endpoint reports.** Some report nothing, in which
  case the app shows nothing rather than inventing a number.

## FAQ

**Is this a clone of some other chat app?**
No. Zen Chat doesn't ship a model, an account or a subscription, and it has no server. It's an
endpoint-agnostic desktop client: the interface will feel immediately familiar, but everything
underneath is yours — your key, your endpoint, your files. If you already have an API key or a
local model server, this is the front end for it.

**Do I need an API key?**
Yes for a hosted endpoint — the app provides no model of its own. Or point it at a local server
(LM Studio, Ollama, vLLM, llama.cpp) and run entirely offline with no key at all.

**Which endpoint do you recommend?**
Any. The app is deliberately not tied to one — that's the point of it. Presets exist for the
common ones purely to save you typing.

**Can it see images?**
Yes, if the model can. Hit ⚡ next to a model in Settings → Models to find out for real, then
paste or drag an image into the composer. If the model can't take images, the app says so
clearly instead of silently dropping the attachment.

**Can it search the web?**
Yes — through your own SearXNG instance, or with a model that has server-side search on the
relay. Both are configurable, and every tool call is shown in the transcript.

**Does it phone home?**
No. There's no telemetry, and no backend to phone.

**Why is the window so small?**
Because it's built to be summoned over your work and dismissed, not to be a full-screen
destination. It resizes, remembers its size and position, and collapses its sidebar when narrow.

## Contributing

Issues and pull requests are welcome. Two rules this project holds itself to:

1. **Never fake a capability.** If something doesn't work yet, disable it and label it — don't
   stub it and let it look finished.
2. **Never silently degrade.** If a fallback kicks in, say so in the UI.

Before opening a PR, please run `npm run build` (which type-checks) and the self-test above.

**Never commit an API key.** Config lives outside the repo by design, and
`scripts/check-secrets.cjs` scans the tree for key-shaped literals. Wire it in as a pre-commit
hook so it can't happen by accident:

```bash
node scripts/check-secrets.cjs                  # scan the working tree
node scripts/check-secrets.cjs --staged         # scan only staged files
node scripts/check-secrets.cjs --install-hook   # install as .git/hooks/pre-commit
```

## License

**Not yet chosen.** No `LICENSE` file has been added yet, so for now all rights are reserved.
Pick one (MIT and Apache-2.0 are the usual choices for a project like this) before relying on
this for anything.
