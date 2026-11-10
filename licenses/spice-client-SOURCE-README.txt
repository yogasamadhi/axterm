spice-client 1.2.0 source copy supplied with Axterm

Archive: licenses/spice-client-1.2.0-source.tar
SHA-256: a30adf3706f5a03ede1fdcd0785cea4330f86af2c9bbbc75165384ccfcfd9a26
Source repository: https://github.com/zxdong262/spice-js
Pinned source commit: aed3b4f841db65a9ab015e174d69ff4fccbb197f

The archive contains the publisher's library source, build configuration,
package manifest and lockfile, tests and LICENSE from that fixed commit. It
omits the publisher's README files and unrelated web-demo files. Extract it
with a standard tar reader. The archive is also present beside this document
inside Axterm's installed licenses directory.

To rebuild the library after extraction (from spice-client-1.2.0/):
  npm ci --ignore-scripts --no-audit --no-fund
  npm run build
  ./node_modules/.bin/tsc --project build/tsconfig.types.json
  npm test

The publisher's build script masks a failing declaration-generation command
with "|| true", so run the tsc command separately when verifying the build.
On macOS arm64 with Node 24.18.0 and npm 11.16.0, the rebuilt ESM index.js
and index.js.map matched the installed npm package byte-for-byte; the separate
tsc command and 72 publisher unit tests passed. Rebuilds on other platforms
and future toolchain versions are not established by this local result.

All 30 source texts embedded in the installed spice-client 1.2.0 ESM source
map match the corresponding files in this archive byte-for-byte. The installed
package.json and LICENSE also match. Axterm's production build maps that ESM
input to its SPICE JavaScript chunk; the exact hashes are recorded in
spice-client-SOURCE-NOTICES.txt and the packaged provenance manifest.

The package and its ported library code are third-party software, not Axterm
code licensed by Axterm under Apache-2.0. See spice-client-LICENSE.txt,
LGPL-3.0.txt and GPL-3.0.txt for the available license texts. This source copy
does not itself establish that Axterm's bundled distribution satisfies every
LGPL source, modification, relinking or installation-information condition.
Those duties, the build recipe and final three-platform artifacts still need
qualified review before release approval.
