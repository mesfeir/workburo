/* The one place a release lives. Both pages load this before their own script.
 *
 * Bump version, bump the filenames, done. The row labels, sizes, download links,
 * checksums filename and JSON-LD on both pages follow from here.
 */

var WORKBURO_RELEASE = {
  version: '1.1.2',

  /* bytes, shown in decimal MB. Use mb only for a file not published yet. */
  files: {
    installer: { name: 'WorkBuro-Setup-1.1.2.exe',     bytes: 131076483 },
    portable:  { name: 'WorkBuro-1.1.2-portable.exe',  bytes: 130827266 },
    /* Both platforms are in this release, so no file needs a tag pin: `latest` resolves to a
     * release that carries every one of these. */
    dmg:       { name: 'WorkBuro-1.1.2.dmg',           bytes: 155486648 },
    maczip:    { name: 'WorkBuro-1.1.2-arm64-mac.zip', bytes: 155760580 }
  },

  /* What the app runs on, written into the structured data. Kept here so the page cannot drift
   * from what it claims, the way it did when this string lived in a script as well. */
  platforms: 'Windows 10, Windows 11, macOS 11 and later (Apple silicon)',

  repo: 'https://github.com/mesfeir/workburo',
  releases: 'https://github.com/mesfeir/workburo/releases',

  /* The canonical domain, bought and live. Empty meant no canonical tag was written. */
  canonical: 'https://workburo.dev/'
};