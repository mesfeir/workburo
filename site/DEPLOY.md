# Deploying the WorkBuro site

This folder is the deployable copy of the WorkBuro landing page. Plain static files: no build step,
no dependencies, no server-side anything.

```
index.html                the page
assets/release.js         the one place a release lives
assets/warm.css           the styling
assets/elegant.js         the motion, and the download rows
assets/logo-898.png       the app mark
assets/favicon-256.png    favicon and apple touch icon
assets/fonts/             self hosted, no CDN
assets/screenshots/       the shots used on the page
```

## Where it goes

Cloudflare Pages, project name `workburo`, custom domain `workburo.dev`, this folder as the site root.

**The installers do not live here, and must not.** Cloudflare Pages caps a single file at 25 MiB, and
the Windows installer is about 105 MB with the macOS disk image about 134 MB. The page links to GitHub
Releases for those, which has no such cap. That is deliberate, not an oversight.

## What the page links to

Every download link is built from `RELEASE.repo` and the filenames in `assets/release.js`:

```
https://github.com/mesfeir/workburo/releases/latest/download/<filename>
```

`latest` resolves to the newest published release, so a new version means bumping `version` and the
four filenames in `assets/release.js` and uploading matching assets to that release. Nothing else on
the page needs touching: the rows, their labels, their sizes, the checksums filename, the JSON-LD
block and the `rel="canonical"` tag all follow from that one file.

The hard coded `href`s in `index.html` are a no-JavaScript fallback and are the only other place a
version number appears.

## Checks worth running after a deploy

```bash
curl -s -o /dev/null -w '%{http_code}\n' -L https://workburo.dev/          # expect 200
curl -s -o /dev/null -w '%{http_code}\n' -r 0-0 -L \
  https://github.com/mesfeir/workburo/releases/latest/download/WorkBuro-Setup-1.0.16.exe   # expect 206
```

Then load the page and confirm the four download rows resolve, the screenshots appear, and the browser
network panel shows no request leaving the domain.

## Rules

- No analytics, no cookies, no consent banner, no third-party requests, no external font CDN.
- Nothing from the marketing brief or internal notes goes on the site.
- HTTPS only, and it is not a preference: `.dev` is on the HSTS preload list, so the domain cannot be
  served over plain HTTP at all.
- "Not affiliated with OpenAI" stays in the footer.
