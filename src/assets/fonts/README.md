# Bundled fonts

These faces travel inside the app rather than being fetched, because the renderer's CSP is
`default-src 'self'` and a webfont CDN is blocked in the real window.

They are the **variable** faces, requested from Google Fonts with a weight range
(`wght@400..700`). Asking for discrete weights instead returns the same static 400 file once per
weight, and every `font-semibold` or `font-bold` in the interface then renders as synthesised bold.

| File | Family | Weight axis | Licence |
|---|---|---|---|
| `ArchivoBlack.woff2` | Archivo Black | 400 (static) | SIL Open Font License 1.1 |
| `Inter.woff2` | Inter | 400-700 | SIL Open Font License 1.1 |
| `JetBrainsMono.woff2` | JetBrains Mono | 400-700 | SIL Open Font License 1.1 |

All three are open-licensed and redistributable. To refresh them, request
`family=Inter:wght@400..700` (note the range) with a desktop browser user agent, keep the `latin`
subset, and re-check that the returned CSS says `font-weight: 400 700` rather than a single weight.
