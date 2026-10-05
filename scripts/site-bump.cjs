/**
 * Move the site from the previous version to 1.0.19.
 *
 * The download links are `releases/latest/download/<name>`, so they follow the newest release
 * automatically — but the file NAME in the link carries the version, and a `latest` link to a file
 * that no longer exists is a 404 on the download button. So every link is rewritten and then checked
 * against the network, not against the file.
 */
const fs = require('node:fs')
const path = require('node:path')

const FROM = '1.0.17'
const TO = '1.0.19'
const site = path.join(__dirname, '..', 'site')

const targets = []
for (const dir of [site, path.join(site, 'assets')]) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isFile() && /\.(html|js|css|json|txt|xml)$/i.test(name)) targets.push(p)
  }
}

let total = 0
for (const p of targets) {
  const before = fs.readFileSync(p, 'utf8')
  if (!before.includes(FROM)) continue
  const n = before.split(FROM).length - 1
  fs.writeFileSync(p, before.split(FROM).join(TO))
  total += n
  console.log(`  ${path.relative(site, p)}: ${n} replaced`)
}
console.log(`${total} references moved ${FROM} -> ${TO}`)

/* Now check the thing that actually matters: does every download link resolve? */
const files = ['WorkBuro-Setup', 'WorkBuro', 'SHA256SUMS']
const urls = new Set()
for (const p of targets) {
  const text = fs.readFileSync(p, 'utf8')
  for (const m of text.matchAll(/https:\/\/github\.com\/mesfeir\/workburo\/releases\/[^\s"'<>]+/g)) {
    urls.add(m[0])
  }
}

;(async () => {
  let bad = 0
  for (const url of [...urls].sort()) {
    let status = 0
    try {
      const r = await fetch(url, { method: 'HEAD', redirect: 'follow' })
      status = r.status
    } catch (e) {
      status = -1
    }
    const ok = status === 200
    if (!ok) bad++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${status}  ${url.replace('https://github.com/mesfeir/workburo/', '')}`)
  }
  console.log(bad === 0 ? '\nevery download link resolves' : `\n${bad} link(s) do not resolve`)
  process.exit(bad === 0 ? 0 : 1)
})()
