# Agent mode — Pi in the backend, hands on the machine

**Status: wired into the app.** Settings → Agent installs Pi with one button; the composer's
**Agent** pill routes a turn to it, and switched off nothing changes at all. The installed build
needs a rebuild (`npm run dist`) before it carries this — the copy in the Start Menu is older.

## How it behaves

- **Install**: Settings → Agent → *Install Pi*. A checksum-verified download of Pi's own release,
  unpacked beside the app's data, with live progress; *Remove* deletes the folder and switches
  agent mode off. Nothing is downloaded, installed or scheduled until that button is pressed.
- **Workspace**: chosen in the same panel, and named in the composer pill's tooltip while agent
  mode is on, so what the agent may change is never a mystery.
- **Toggle**: greyed out with an explanation until Pi is really installed. With it on, the turn
  goes to Pi over the same request id, so its work lands in the existing stream — text, reasoning,
  tool rows with pass/fail, usage — and the same Stop button ends it.
- **Off**: no process is spawned, no config is generated, and the message costs exactly what it
  always did.
- **Model**: whatever is selected in the composer. Pi's provider config is regenerated from the
  app's own settings on every turn, so the two can never drift apart.


Agent mode is an opt-in toggle in the chat: when it is on, a turn is handed to
[Pi](https://pi.dev) — the agent harness — instead of going straight to the chat model. Pi runs the
loop, calls real tools (shell, read/write/edit file, grep, find, ls) and streams its work back into
the conversation. When it is off, nothing about the normal chat path changes: no process is
started, no agent overhead, same model, same latency.

The model is the one already selected in the composer. Pi is pointed at the same endpoint and key
the app already uses, so "which model" is never a second setting to keep in sync.

## What the spike proved (measured, on this machine)

| Question | Result |
|---|---|
| Does Pi install cleanly? | Yes — `npm install --ignore-scripts @earendil-works/pi-coding-agent`, **144 packages, 21 s**, v0.87.1 |
| Can it use our own relay? | Yes — a generated `models.json` with `api: "openai-completions"` and `apiKey: "$ENV"` listed our model: `zen · deepseek-v4.1-flash · 128K · thinking: yes` |
| Does the selected model drive the loop? | Yes — `deepseek-v4.1-flash` planned, called tools and finished unaided |
| Does it really have hands? | Yes — wrote `hello.txt` (verified byte-for-byte on disk) **and** ran a shell command, then reported the exact command it used. **7 s** for the whole turn |
| Structured progress? | Yes — `--mode json` streamed 95 JSONL events for that turn; the file `tiny.txt` was written and read back |
| Can Electron host it? | **No** — Electron 35 ships Node 22.16.0 and Pi requires **>= 22.19.0**. A real Node must be present (detected at install, never assumed) |

## The event stream maps onto what the UI already has

A real JSON-mode turn emits, in order: `session`, `agent_start`, `turn_start`, `message_start`,
`message_update` (x65, carrying `usage` and `assistantMessageEvent` deltas), `tool_execution_start`
(`toolName`, `args`), `tool_execution_end` (`result`, `isError`), `turn_end` (`toolResults`),
`agent_end` (`messages`, `willRetry`), `agent_settled`.

That is a near one-to-one fit with the existing `ChatEvent` surface:

| Pi event | What the app does |
|---|---|
| `message_update` → `assistantMessageEvent.*_delta` | append to the streaming reply (text, and reasoning into the collapsible "Thought for Ns" block) |
| `tool_execution_start` | open a tool row using the name and args |
| `tool_execution_end` | close it with the result, and mark `isError` rows red |
| `message_update.usage` | real token counts per turn, rather than a guess |
| `agent_settled` | mark the turn finished and idle the composer |
| process exit / kill | the Stop button |

So tool rows, sources, the reasoning block, usage and Stop all reuse existing machinery. What is
new is a process to run, a stream to parse and a workspace to scope.

## Architecture

- **Install**: one button in Settings → Agent. It runs the npm install into the app's own data
  directory (`%APPDATA%\zen-chat\pi`) so Pi is self-contained, pinned and removable — deleting the
  folder uninstalls it. First it checks for a Node >= 22.19 and says so plainly if there is none;
  it never pretends to be installed when it is not.
- **Configuration**: the app generates `<piRoot>/agent/models.json` from the live config — same
  `baseUrl`, `api: "openai-completions"`, and one `models` entry per model the relay advertises.
  The API key is passed as an environment variable at spawn (`$ZEN_RELAY_KEY`), so **no key is
  written to Pi's config directory**.
- **A turn**: spawn `pi --mode json --model zen/<selected>` with the workspace as the working
  directory, hand it the prompt, parse the JSONL with a hand-rolled LF splitter (Pi's docs warn
  Node's `readline` is not protocol-compliant — it splits on U+2028/9, which are legal inside JSON
  strings), and translate events into the app's chat events.
- **Session mapping**: v1 uses one Pi process per turn, with `--no-session` and the conversation
  history kept in the app's own store, so a conversation is never split across two sources of
  truth. Long-lived RPC mode (`steer`, `follow_up`, persistent session trees) is the upgrade path
  once the simple version is trusted.
- **Workspace**: a folder chosen in Settings → Agent, shown in the header while agent mode is on,
  because that is the folder the agent may change.

## Safety posture (non-negotiable, and disclosed in the UI)

Pi's own documentation is explicit: **it has no built-in permission system**, and by default it
runs with the permissions of whoever launched it. So:

- agent mode is **off by default** and switches on per conversation, deliberately;
- the active workspace is always visible while it is on, and the amber disclosure pattern already
  used for other caveats states that the agent can modify files there;
- the first version ships with a workspace folder rather than an implicit whole-disk scope, and
  nothing here ever installs background automation on the machine;
- anything riskier (Docker, WSL2, or Pi's Gondolin micro-VM) is a later, explicit choice.

## Build phases

1. **Engine** (`electron/pi.cjs`): status/detect, install with progress, config generation, one
   turn streamed as events. Tested standalone against the real relay (list-models must show the
   selected model; a real turn must produce a file on disk).
2. **Settings → Agent**: the install button, install state, Node warning, workspace picker.
3. **Chat toggle**: a composer switch, enabled only once installed, plus routing the turn to Pi and
   mapping events onto the existing tool rows.
4. **Honesty pass**: README, `docs/`, the amber banner, and self-test checks — including one that
   proves agent mode off means no process is spawned at all.
