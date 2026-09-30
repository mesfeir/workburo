# Publishing checklist

Everything needed to take this repo from private to public, and the exact metadata to paste
into GitHub. Keep this file in the repo — it's the record of what the "About" box says and why.

## Repository

- **Slug:** `mesfeir/workburo`
- **Visibility:** currently **private**. Flip with Settings → General → Danger Zone → *Change
  visibility* on the repo page, or `PATCH /repos/mesfeir/workburo {"private": false}`.
- **Name rationale:** the repo is named after the product. `mesfeir/workburo` was free when we
  renamed to it; the repo used to be `mesfeir/zenchat-desktop`, and GitHub redirects the old URL so
  existing clones keep working. Worth knowing: `workburo.com` belongs to an unrelated design studio
  in Seoul, and the `workburo` GitHub org and npm package name are still unclaimed. Two old names
  remain on purpose, because changing them is a migration rather than a rename: the app's own store
  file is still `zen-chat-store.json`, and the local checkout folder is still `zen-chat`.

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
      Also confirm the config file (`%APPDATA%\WorkBuro\zen-chat-store.json`) is not in the
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
git remote add origin git@github.com:mesfeir/workburo.git
git push -u origin main
```

The fine-grained token used to *create* the repo and set its metadata was only needed once. If
a token is ever required again, do not commit it and do not paste it into a chat — write it to a
file outside the repo and read it from there, then revoke it.
