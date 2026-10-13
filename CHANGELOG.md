# Changelog

Newest first. The version here is the one in `package.json`, which is the one the
build stamps on the files.

A version number is shared across platforms only once both have been built, so a
version can appear here before it is downloadable. The **Released** line on each
entry says whether there is anything to download, and for which platform.

## 1.1.0 — not published yet

**Electron 44.** The runtime moves from Electron 35 to 44: Chromium 134 to 152,
Node 22 to 24. Sixteen Chromium majors of rendering, JavaScript and security
fixes underneath the same app.

**Your own ComfyUI workflows become image models.** A workflow you already have
can be added beside the hosted ones, so a picture is drawn by your own machine
with the model and the steps you chose, and it appears in the same model list as
everything else. An agent turn that draws is handed back as a picture rather than
as the path to one.

**Gemini, both halves, on one key.** Chat and images through Gemini now run off a
single API key, and picture settings are provider-first rather than split across
two places that could disagree.

**Pictures are files, not text in every save.** They used to be stored inline, so
one image meant tens of megabytes rewritten into the store on every save. They are
files now, and the store stays small.

**Two things that made the app feel stuck.** The whole store was being cloned
across IPC while a reply streamed, and capture mode did not wait for the store
write. Both are gone.

**Two window faults fixed.** Maximising no longer shows stale frames, and coming
back from the taskbar no longer freezes the window while it is tucked away.

**Released:** no. `1.0.23` is still the newest download.

## 1.0.23 — 7 October 2026

**An update button, inside the app.** Settings → About has Updates. It asks GitHub
for the newest release, downloads the right file for the way the app is running,
checks it against the published `SHA256SUMS`, and only then offers the ending that
fits. A file that cannot be checked is never run, and the reason is said plainly.

**An answer arrives at a steady pace.** Bursts of words are revealed across a short
window, so a finished message is never left mid-sentence.

**The view stays where you put it.** The start of a reply comes into view once, and
after that nothing moves on its own.

**Thinking is one word.** The reasoning stream is not drawn unless you open it, and
the word beside "Thinking" is read off the thought rather than cycled on a timer.

**The Library and the agent list, fixed.** The Library lists every folder the app
writes to, and a turn that called seventy-five tools draws one line.

**Released:** Windows only. macOS stayed on `1.0.19`.

## Earlier

| Version | Date | Platform |
|---|---|---|
| 1.0.19 | 5 October 2026 | Windows, macOS |
| 1.0.17 | 3 October 2026 | Windows, macOS |
| 1.0.16 | 2 October 2026 | Windows, macOS |
| 1.0.15 | 2 October 2026 | Windows, macOS |
| 1.0.10 | 1 October 2026 | Windows |
| 1.0.9 | 1 October 2026 | Windows |

The full notes for each are on the [releases page](https://github.com/mesfeir/workburo/releases).
