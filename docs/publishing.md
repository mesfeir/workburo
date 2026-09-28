# Publishing checklist

Everything needed to take this repo from private to public, and the exact metadata to paste
into GitHub. Keep this file in the repo — it's the record of what the "About" box says and why.

## Repository

- **Slug:** `mesfeir/zenchat-desktop`
- **Visibility:** currently **private**. Flip with Settings → General → Danger Zone → *Change
  visibility* on the repo page, or `PATCH /repos/mesfeir/zenchat-desktop {"private": false}`.
- **Name rationale:** `zen-chat` collides with a lot of existing projects. `zenchat-desktop` is
  unique globally (checked via the GitHub search API), keeps the product name, and still
  carries the "chat" + "desktop" search terms.

## Description (the About box, 350 char max)

> Native Windows AI chat client for any OpenAI-compatible endpoint. Bring your own key: OpenCode Zen, OpenAI, LM Studio, Ollama, vLLM. Streaming, vision, live tools, global summon hotkey, tray, local-first storage.

## Topics

```
electron  typescript  react  ai-client  llm  openai-compatible  byo-api-key
chatgpt-alternative  desktop-app  windows  local-llm  ollama  lmstudio
tailwindcss  privacy  vite
```

## Social preview

Settings → Social preview → upload a 1280×640 image. The screenshot at
`docs/screenshots/readme-app.png` cropped to that ratio works well; a purpose-made card with the
icon on a dark background would be better.

## Before flipping to public

- [ ] **Choose a license.** There is deliberately no `LICENSE` file yet, so all rights are
      reserved. MIT or Apache-2.0 are the usual choices here; Apache-2.0 also grants a patent
      licence, which some contributors care about. Add `LICENSE`, then update the License
      section of the README and add a `license` field to `package.json`.
- [ ] **Run the secret scan.** `node scripts/check-secrets.cjs` — must report zero findings.
      Also confirm the config file (`%APPDATA%\zen-chat\zen-chat-store.json`) is not in the
      repo; it is gitignored, and it should never be copied in.
- [ ] **Check the screenshots.** They are captured from the real UI. Confirm the API key field
      is masked (it is `type=password` by default), that no session id other than the demo
      placeholder appears, and that no personal name is shown — the sidebar chip now shows the
      endpoint host and active model instead of a hardcoded name.
- [ ] **Decide about installers.** `release/` is gitignored. If you want downloadable builds,
      cut a release and attach the NSIS installer and portable exe — and note in the README that
      they are unsigned (SmartScreen will warn).
- [ ] **Re-read the README** for anything that reads as a work in progress.
- [ ] **Flip visibility** and add the description + topics above if they didn't carry over.

## Pushing

SSH is already authenticated on this machine as `mesfeir`, so no token is needed for pushes:

```bash
git remote add origin git@github.com:mesfeir/zenchat-desktop.git
git push -u origin main
```

The fine-grained token used to *create* the repo and set its metadata was only needed once. If
a token is ever required again, do not commit it and do not paste it into a chat — write it to a
file outside the repo and read it from there, then revoke it.
