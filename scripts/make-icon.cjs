// Renders the WorkBuro mark to a PNG, for the installer, the exe and the taskbar.
//
// Electron is already in this project and can rasterise SVG, so this avoids pulling in an image
// toolchain just to draw one icon. The brain is lucide's, at the same stroke weight the app uses
// for its own icons, so the mark outside the app is the same drawing as the icon inside it.
//
//   npx electron scripts/make-icon.cjs
//
// Then scripts/make-icons.py packs the results into build/icon.ico.
//
// Two variants are drawn, not one scaled down. The full brain carries seven short fold strokes and
// below about 32px they merge into a smear: at 16px the mark stops reading as a brain at all and
// looks like a crosshair. So the small sizes get a deliberately simpler drawing — the two
// hemispheres and the central fissure only, with a heavier stroke to keep its weight.

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const BUILD = path.join(__dirname, '..', 'build')
const ASSETS = path.join(__dirname, '..', 'electron', 'assets')

// lucide's Brain, verbatim
const BRAIN = [
  'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z',
  'M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z',
  'M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4',
  'M17.599 6.5a3 3 0 0 0 .399-1.375',
  'M6.003 5.125A3 3 0 0 0 6.401 6.5',
  'M3.477 10.896a4 4 0 0 1 .585-.396',
  'M19.938 10.5a4 4 0 0 1 .585.396',
  'M6 18a4 4 0 0 1-1.967-.516',
  'M19.967 17.484A4 4 0 0 1 18 18',
]

// The two hemispheres and the fissure: the parts that survive being 16 pixels wide.
const SIMPLE = [BRAIN[0], BRAIN[1], BRAIN[2]]

// 32-unit tile, the brain drawn in a 24-unit box centred with 4 units to each side, so it keeps the
// proportions lucide gives it rather than being an enlarged copy of something meant for 16px.
function html(paths, strokeWidth) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden}
</style></head><body>
<svg width="100%" height="100%" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="32" height="32" rx="7" fill="#16150f"/>
  <g transform="translate(4 4)" fill="none" stroke="#f6f4ef" stroke-width="${strokeWidth}"
     stroke-linecap="round" stroke-linejoin="round">
    ${paths.map((d) => `<path d="${d}"/>`).join('\n    ')}
  </g>
</svg></body></html>`
}

async function openWindow(size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, backgroundThrottling: false },
  })
  return win
}

async function capture(win, svg) {
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(svg))
  // a couple of frames for the SVG to actually paint
  await new Promise((r) => setTimeout(r, 500))
  const img = await win.webContents.capturePage()
  return img.toPNG()
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  // One window loaded twice, rather than a window per drawing: a second offscreen window created
  // while the previous one is still tearing down has its load aborted, and only the first render
  // would ever come back.
  const win = await openWindow(512)
  const drawings = [
    ['icon-full-512', html(BRAIN, 2)],
    ['icon-small-256', html(SIMPLE, 2.6)],
  ]
  console.log('rendering the mark:')
  for (const [name, svg] of drawings) {
    let png = null
    for (let attempt = 1; attempt <= 3 && !png; attempt++) {
      try {
        png = await capture(win, svg)
      } catch (err) {
        console.log(`   ${name} attempt ${attempt} failed: ${err && err.message}`)
        await new Promise((r) => setTimeout(r, 700))
      }
    }
    if (!png) throw new Error(`could not render ${name}`)
    fs.mkdirSync(BUILD, { recursive: true })
    fs.writeFileSync(path.join(BUILD, `${name}.png`), png)
    console.log(`   ${name}.png  ${png.length} bytes`)
  }
  win.destroy()
  app.exit(0)
})
