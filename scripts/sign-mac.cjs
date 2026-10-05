/**
 * Sign the macOS app ad-hoc, after packing and before the dmg and zip are made.
 *
 * Without this, the build produces an app whose main executable carries only the signature the linker
 * gave it when Electron was built. The bundle around it has resources that signature knows nothing
 * about, so macOS reports:
 *
 *     code has no resources but signature indicates they must be present
 *
 * and refuses to launch it — the user sees "WorkBuro is damaged and should be moved to the bin",
 * which sounds like a corrupt download and is actually a build that was never signed. On Apple
 * silicon a valid signature is not optional: the kernel will not execute an unsigned arm64 binary.
 *
 * Ad-hoc ("-") rather than a Developer ID, because there is no certificate to sign with; this makes
 * the app run, and Gatekeeper still asks the first time (right-click, Open). Removing that prompt
 * altogether needs a Developer ID and notarisation.
 *
 * It runs in afterPack so the dmg and zip targets copy an app that is already signed — signing after
 * they are built would leave both artifacts holding the broken copy.
 */
const path = require('node:path')
const { execFileSync } = require('node:child_process')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const app = path.join(context.appOutDir, `${appName}.app`)

  const codesign = (args) =>
    execFileSync('codesign', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  try {
    // --force replaces the linker signature; --deep covers the helper apps inside Frameworks, which
    // macOS validates separately.
    codesign(['--force', '--deep', '--sign', '-', app])
  } catch (err) {
    throw new Error(`[sign-mac] could not sign ${app}: ${err.stderr || err.message}`)
  }

  try {
    codesign(['--verify', '--strict', '--verbose=2', app])
  } catch (err) {
    throw new Error(`[sign-mac] signed, but the signature does not verify: ${err.stderr || err.message}`)
  }

  // Say what actually landed rather than assuming the call was enough.
  let detail = ''
  try {
    detail = codesign(['-dv', '--verbose=2', app])
  } catch (err) {
    detail = err.stderr || ''
  }
  const id = (detail.match(/Identifier=(\S+)/) || [])[1] || 'unknown'
  const flags = (detail.match(/flags=(\S+)/) || [])[1] || 'unknown'
  console.log(`[sign-mac] ad-hoc signed and verified: ${appName}.app (identifier ${id}, flags ${flags})`)
}
