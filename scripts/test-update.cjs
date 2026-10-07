/**
 * The rules an update follows, tested against the real module.
 *
 * An updater is the one feature that runs an executable on the user's machine, so the rules that
 * decide *whether* to run one are worth more than the code that downloads it. The cases that matter
 * most are the refusals: no published checksum, a checksum that does not match, and a platform where
 * this app genuinely cannot replace itself.
 *
 * Offline: nothing here touches the network.
 */
const path = require('node:path')

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const u = require(path.join(__dirname, '..', 'electron', 'update.cjs'))

/* ----------------------------------------------------------- version order */

const order = [
  ['1.0.20', '1.0.19', 1],
  ['1.0.19', '1.0.20', -1],
  ['1.0.9', '1.0.10', -1],
  ['1.0.10', '1.0.9', 1],
  ['1.0.20', '1.0.20', 0],
  ['v1.0.20', '1.0.20', 0],
  ['v1.0.21', 'v1.0.20', 1],
  ['0.9.9', '1.0.0', -1],
  ['1.1.0', '1.0.99', 1],
  ['2.0.0', '1.99.99', 1],
]
for (const [a, b, want] of order) {
  const got = u.compareVersions(a, b)
  check(`${a} vs ${b} -> ${want}`, got === want, `got ${got}`)
}

check('a release is newer than its own pre-release', u.compareVersions('1.0.20', '1.0.20-beta.1') === 1)
check('a pre-release is older than its release', u.compareVersions('1.0.20-beta.1', '1.0.20') === -1)
check('rubbish parses as 0.0.0 instead of throwing', u.compareVersions('not-a-version', '0.0.0') === 0)
check('the same version is not an update', u.isNewer('1.0.20', '1.0.20') === false)
check('an older tag is not an update', u.isNewer('1.0.19', '1.0.20') === false)
check('a newer tag is an update', u.isNewer('1.0.21', '1.0.20') === true)

/* --------------------------------------------------------- picking a file */

/* the real asset names from the published release */
const release = {
  tag_name: 'v1.0.21',
  assets: [
    { name: 'WorkBuro-Setup-1.0.21.exe', browser_download_url: 'https://example/setup', size: 105 },
    { name: 'WorkBuro-1.0.21-portable.exe', browser_download_url: 'https://example/portable', size: 104 },
    { name: 'WorkBuro-1.0.21.dmg', browser_download_url: 'https://example/dmg', size: 133 },
    { name: 'WorkBuro-1.0.21-arm64-mac.zip', browser_download_url: 'https://example/zip', size: 128 },
    { name: 'SHA256SUMS-1.0.21.txt', browser_download_url: 'https://example/sums', size: 187 },
  ],
}

check(
  'windows gets the installer',
  u.pickAsset(release, { platform: 'win32' }).name === 'WorkBuro-Setup-1.0.21.exe',
)
check(
  'a portable build gets the portable file, not the installer',
  u.pickAsset(release, { platform: 'win32', portable: true }).name === 'WorkBuro-1.0.21-portable.exe',
)
check('macOS gets the disk image', u.pickAsset(release, { platform: 'darwin' }).name === 'WorkBuro-1.0.21.dmg')

const noDmg = { tag_name: 'v1.0.21', assets: [release.assets[3]] }
check('macOS falls back to the zip when there is no dmg', u.pickAsset(noDmg, { platform: 'darwin' }).name.endsWith('.zip'))
check('no assets means nothing to fetch', u.pickAsset({ tag_name: 'v1.0.21', assets: [] }, { platform: 'win32' }) === null)
check('an unknown platform gets nothing', u.pickAsset(release, { platform: 'linux' }) === null)
check(
  'a version in the tag cannot be mistaken for another',
  u.pickAsset(release, { platform: 'win32' }).name.includes('1.0.21'),
)

/* ------------------------------------------------------------- checksums */

/* the names actually published for 1.0.19, so this test breaks if the naming drifts */
check('the windows checksum file is named as published', u.sumsAssetName('1.0.19', 'win32') === 'SHA256SUMS-1.0.19.txt')
check('the mac checksum file is named as published', u.sumsAssetName('1.0.19', 'darwin') === 'SHA256SUMS-1.0.19-mac.txt')
check('a v prefix does not break the name', u.sumsAssetName('v1.0.19', 'win32') === 'SHA256SUMS-1.0.19.txt')
check(
  'the checksum url points at the release download',
  u.sumsUrl('1.0.21', 'win32') === 'https://github.com/mesfeir/workburo/releases/download/v1.0.21/SHA256SUMS-1.0.21.txt',
)

const sums = [
  '710426753d8dc19e1fc4d2302dbde7f05f9c83f7b596609f9d9e6d15e3772165 *WorkBuro-1.0.19.dmg',
  '2ba61d2e303bdcda28f382fbb50cb2e7edce87d5a6e791d9cbe158e9e6496682 *WorkBuro-1.0.19-arm64-mac.zip',
].join('\n')
check('a listed file is found', u.checksumFor(sums, 'WorkBuro-1.0.19.dmg').startsWith('71042675'))
check('a file that is not listed comes back empty', u.checksumFor(sums, 'WorkBuro-1.0.20.dmg') === '')
check('windows line endings do not break it', u.checksumFor(sums.replace(/\n/g, '\r\n'), 'WorkBuro-1.0.19.dmg').length === 64)
check(
  'uppercase hex digits are accepted',
  u.checksumFor(
    sums.split('\n').map((l) => l.slice(0, 64).toUpperCase() + l.slice(64)).join('\n'),
    'WorkBuro-1.0.19.dmg',
  ).startsWith('71042675'),
)
check('an empty file has no checksum', u.checksumFor('', 'anything') === '')

/* ------------------------------------------------------- what happens next */

const file = { path: 'C:/tmp/x.exe', sha256: 'a'.repeat(64) }

check(
  'a verified windows download runs the installer',
  u.installPlan({ platform: 'win32', hasChecksum: true, checksumOk: true, file }).action === 'run-installer',
)
check(
  'a verified mac download opens the disk image instead of pretending to install',
  u.installPlan({ platform: 'darwin', hasChecksum: true, checksumOk: true, file }).action === 'open-dmg',
)
check(
  'a portable build is handed to the user, never silently replaced',
  u.installPlan({ platform: 'win32', portable: true, hasChecksum: true, checksumOk: true, file }).action === 'open-folder',
)

/*
 * The three refusals. An updater that runs an executable is the one place where being helpful is the
 * wrong instinct: without a published checksum there is nothing to check against, and a mismatch
 * means the bytes are not the ones that were published.
 */
const noSum = u.installPlan({ platform: 'win32', hasChecksum: false, checksumOk: false, file })
check('nothing is installed when no checksum was published', noSum.action === 'open-release')
check('and the person is told why', /checksum/i.test(noSum.why))

const mismatch = u.installPlan({ platform: 'win32', hasChecksum: true, checksumOk: false, file })
check('nothing is installed when the checksum does not match', mismatch.action === 'none')
check('and the mismatch is said plainly', /does not match/i.test(mismatch.why))

check('nothing is installed with no file', u.installPlan({ platform: 'win32', file: null }).action === 'none')

/* every ending must carry an explanation, because the window shows it as-is */
const endings = [
  u.installPlan({ platform: 'win32', hasChecksum: true, checksumOk: true, file }),
  u.installPlan({ platform: 'darwin', hasChecksum: true, checksumOk: true, file }),
  u.installPlan({ platform: 'win32', portable: true, hasChecksum: true, checksumOk: true, file }),
  noSum,
  mismatch,
]
check(
  'every ending explains itself in words',
  endings.every((e) => typeof e.why === 'string' && e.why.length > 20),
)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
