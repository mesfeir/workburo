# Changelog

Newest first. The version here is the one in `package.json`, which is the one the
build stamps on the files.

A version number is shared across platforms only once both have been built, so a
version can appear here before it is downloadable. The **Released** line on each
entry says whether there is anything to download, and for which platform.

## 1.1.6 — 25 October 2026

**The app no longer dies a few seconds after opening on a long history.** Pictures were being read
from disk and turned into base64 for every image of every conversation, every time the store was
read — hundreds of megabytes on a real history, and the process was killed building them. Pictures
now load when they are on screen, once each, and startup costs nothing.

## 1.1.5 — 25 October 2026

**No more pairing codes.** Press **Copy a pairing link** in Settings, Server and open that link on the
phone: it pairs on the spot. The link carries the key, so it goes on the clipboard and never on screen,
and the page takes the key back out of the address bar as soon as it has stored it. `/pair` explains
where the link comes from instead of asking for six digits.

## 1.1.4 — 25 October 2026

**Pressing "Picture" on a phone wiped the screen.** The model picker's Picture tab asks the app for
the state of ComfyUI as it mounts, and the phone's bridge had no ComfyUI surface at all -- so the
call threw while the page was rendering. An exception there does not cost you one list; React tears
down the whole tree, which is why the screen went blank rather than showing an empty tab.

Two changes, because either alone would have hidden the other fault. The bridge now answers for
ComfyUI the way it answers for every other surface that lives on the computer: honestly, and with
a refusal rather than silence. And the picker no longer assumes the surface is there -- a missing or
incomplete one now means "nothing to show", never "the page is gone".

Found by driving the real page at phone width against the real server and watching the console,
which is also where the exception gave up the exact line.

**Released:** Windows and macOS.

## 1.1.3 — 25 October 2026

**A device that is not paired now goes straight to the pairing page.** Opening the address on a phone
that had never paired, or that held a key the computer no longer accepts (a rotated key, or one from
a different install), drew the app anyway: the page keeps its last view in its own storage, so it
rendered old conversations with empty lists and every action failing quietly. That looked like a
stale or broken build, and it was the thing sending people looking for a bug in the providers list.

A refused key now means exactly what it says -- this device is not paired -- so the key is dropped
and the page goes to `/pair` to fetch a new one. A refused request on the chat stream does the same,
rather than failing mid-sentence. Pairing on success already returned to the app; this is the other
half of that journey.

**Released:** Windows and macOS.

## 1.1.2 — 25 October 2026

**The phone's Settings had no providers in it.** Server mode was sending the page a config with an
empty `profiles` list, so Settings → API showed no provider buttons and no key fields at all — the
list had nowhere to come from. The host was asked for its config, and the answer simply left the
providers out.

The providers now travel, with every key replaced by the marker `held-on-the-pc`; the real keys
never leave the computer. Saving is wired up as well, because a pane that renders and cannot save
is worse than one that is missing: the store handler accepts an explicit list of the fields the pane
owns and refuses everything else — including `protocol`, which only the desktop should set. A save
that carries the marker keeps the stored key rather than overwriting it with the word.

Two layout faults were behind the second half of the complaint. The settings modal was a fixed
740 px wide, which is wider than the 480 px desktop window and much wider than a phone, so the key
field was off the side of the screen; it now fits whatever it is drawn on. And a provider row put a
fixed 168 px name beside a flexible input, so in a narrow pane the input was squeezed to nothing —
it wraps onto its own line instead.

**Released:** Windows and macOS.

## 1.1.1 — 22 October 2026

**The phone stopped showing a blank screen.** Server mode was serving the page and every asset
correctly, but the window never painted. The interface asks the updater for its state as it
mounts, and a page served over the network has no updater, so the request threw before anything
had been drawn. All that was left was the page background: the grey screen. The web bridge now
provides that surface, and the window skips it when it is absent, so one missing capability can
no longer take the whole interface down with it.

**Released:** Windows and macOS.

## 1.1.0 — 13 October 2026

**Electron 44.** The runtime moves from Electron 35 to 44: Chromium 134 to 152,
Node 22 to 24. Eighteen Chromium majors of rendering, JavaScript and security
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

**Released:** Windows and macOS. The first release since 1.0.19 to carry both.

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
| 1.1.0 | 13 October 2026 | Windows, macOS |
| 1.0.19 | 5 October 2026 | Windows, macOS |
| 1.0.17 | 3 October 2026 | Windows, macOS |
| 1.0.16 | 2 October 2026 | Windows, macOS |
| 1.0.15 | 2 October 2026 | Windows, macOS |
| 1.0.10 | 1 October 2026 | Windows |
| 1.0.9 | 1 October 2026 | Windows |

The full notes for each are on the [releases page](https://github.com/mesfeir/workburo/releases).
