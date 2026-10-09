# IR-11 xterm headless embedded VS Code MIT notice

Date: 2026-09-23  
Scope: installed production dependency `@xterm/headless@6.0.0`  
Result: a separately readable Microsoft MIT notice was added; IR-02/IR-11 remain **In progress**

Axterm's Runtime imports the package's CommonJS
`lib-headless/xterm-headless.js` for terminal recording, and the production
`packages/runtime/dist/headless.js` contains that dependency. The installed
manifest declares MIT and pins xterm.js commit
`f447274f430fd22513f6adbf9862d19524471c04`. The installed bundle has
SHA-256 `17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed`
and names its adjacent source map. That map has SHA-256
`780e782badc8189491a469c9277b783e01911882ea84417b31e71294ea927d98`.

The publisher's map embeds 57 source entries. Eleven are
`out/vs/base/common/*.js`; each includes the Microsoft Corporation copyright
header and explicitly points to the MIT `License.txt` in its source project.
The other map entries are xterm.js sources or webpack bootstrap. This is
direct published-package evidence of a separately credited source chain, not
an inference from the package's MIT manifest. The exact xterm.js root MIT text
was already retained in `licenses/xterm-addon-serialize-LICENSE.txt`, but it
does not name Microsoft for these modules.

The official [xterm.js 6.0.0 source commit](https://github.com/xtermjs/xterm.js/tree/f447274f430fd22513f6adbf9862d19524471c04)
was independently retrieved from the publisher's `6.0.0` tag. Its fixed-commit
GitHub source tarball has SHA-256
`82337f91a9df63998d89ba906389d5152a2e8278b558ea72c5dec25ec93a591e`.
For every one of the map's 45 `src/**/*.ts` entries, removing the
`webpack://@xterm/xterm/./` prefix gives a file in that source commit whose
UTF-8 bytes equal the embedded `sourcesContent` bytes: **45 equal, zero
missing, zero different**. All eleven `out/vs/base/common/*.js` map entries
also have corresponding `src/vs/base/common/*.ts` paths in that commit, each
with the same Microsoft copyright header. The latter is a path/header match,
not byte identity between compiled JavaScript and TypeScript.

[`microsoft/vscode`'s MIT license](https://github.com/microsoft/vscode/blob/dd35b1a25b6a4096e50ca2af18d9f82b41925b5a/LICENSE.txt)
at fixed commit `dd35b1a25b6a4096e50ca2af18d9f82b41925b5a` has SHA-256
`9480271317925265e806a9a196aaa33410a962fa9d4d1e248a4a5187bc8c9df9`.
That exact 1,088-byte text is now
`licenses/xterm-headless-vscode-LICENSE.txt`, and
`THIRD_PARTY_NOTICES.txt` names both the embedded source headers and the new
file. The existing legal-text directory is copied into packages and indexed
in About. The focused source test pins the installed bundle/map hashes,
source-entry count, all eleven headers, and notice/license references.

The source map and tagged xterm source do **not** identify the exact upstream
VS Code commit from which those eleven modules were drawn. A current official
MIT text with a fixed hash provides the permission wording; the 45 byte-matched
sources and eleven corresponding tagged paths narrow publisher provenance but
do not establish complete file-level lineage, a reproducible compiled bundle,
or qualified rights clearance.
The attribution-review ledger entry for `@xterm/headless` remains `pending`.

Local verification on 2026-09-23:

- `bun run check` passed 1,014 tests (33 conditional skips), the 358-module
  Level 1 gate, 267 Contract operations, production build/layout and nine
  visual/accessibility journeys.
- The source and unsigned macOS arm64 directory app contain byte-identical
  `licenses/xterm-headless-vscode-LICENSE.txt` and
  `THIRD_PARTY_NOTICES.txt`. The latter has SHA-256
  `45b153c0c9ae06814f8a2ef22999bcbf9ba92951a05fef29c8d980a9f6ce4332`.
- The app's `app.asar` SHA-256 is
  `e2826c8c7ef100ce6a0957ff5d70b38f9bdebd86fc70d1671f897d4d307835ce`.
  A regenerated, independently verified packaged SPDX sidecar has SHA-256
  `8e3d630e1339b4a16fc6423e7a95c6612df1fbfe8c655f2e89976110c2148958`.
- The packaged legal-file journey passed, and a separate packaged About-page
  journey read and compared every current `licenses/*.txt` document, including
  the new file. Both single-test invocations exited successfully.

These are local unsigned macOS engineering results, not a signed/notarized
release, native Windows/Linux evidence or qualified legal approval.
