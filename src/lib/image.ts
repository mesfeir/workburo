import type { Attachment } from '../types'

/** Downscale/compress an image data URL so chats stay fast and cheap to send. */
export function shrinkImage(dataUrl: string, max = 1536): Promise<Attachment> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      if (scale === 1 && dataUrl.length < 400_000) return resolve({ url: dataUrl })
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(img.width * scale))
      c.height = Math.max(1, Math.round(img.height * scale))
      const ctx = c.getContext('2d')
      if (!ctx) return resolve({ url: dataUrl })
      ctx.drawImage(img, 0, 0, c.width, c.height)
      // keep PNG for screenshots (text stays crisp), JPEG for photos
      const png = dataUrl.startsWith('data:image/png')
      resolve({ url: png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.88) })
    }
    img.onerror = () => resolve({ url: dataUrl })
    img.src = dataUrl
  })
}

/** A deterministic probe image: a vision model must read "ZEN 4729" back. */
export function probeImage(): string {
  const c = document.createElement('canvas')
  c.width = 360
  c.height = 130
  const d = c.getContext('2d')
  if (!d) return ''
  d.fillStyle = 'var(--text-faint)'
  d.fillRect(0, 0, c.width, c.height)
  d.fillStyle = 'var(--ok)'
  d.font = 'bold 38px monospace'
  d.fillText('ZEN 4729', 42, 80)
  return c.toDataURL('image/png')
}

export function readFilesAsImages(files: File[]): Promise<Attachment[]> {
  return Promise.all(
    files.map(
      (f) =>
        new Promise<Attachment>((resolve) => {
          const r = new FileReader()
          r.onload = async () => {
            const shrunk = await shrinkImage(String(r.result))
            resolve({ ...shrunk, name: f.name })
          }
          r.onerror = () => resolve({ url: '' })
          r.readAsDataURL(f)
        }),
    ),
  ).then((a) => a.filter((x) => x.url))
}
