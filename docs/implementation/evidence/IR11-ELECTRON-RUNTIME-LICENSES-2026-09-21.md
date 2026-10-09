# IR-11 Electron runtime license materials — 2026-09-21

Release gate: [IR-11](../INDEPENDENT_RELEASE_MATRIX.md)  
Status: **partial macOS artifact evidence; not legal clearance**

## Scope

Electron is a platform runtime, not an Axterm workspace package in `app.asar`.
Its distribution carries two legal materials that electron-builder preserves in
the macOS app's `Contents/Resources` directory:

| Packaged path                      | Installed Electron 44.3.0 source path  | SHA-256                                                            |
| ---------------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `Resources/LICENSE.electron.txt`   | `electron/dist/LICENSE`                | `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d` |
| `Resources/LICENSES.chromium.html` | `electron/dist/LICENSES.chromium.html` | `a62dabd1c6ef1327365b2a3fdffb806222684a746dcb8f4afd1c1f690eba5535` |

`scripts/commercialization/packaged-license-inventory.mjs` now emits these as
`electronRuntimeLegalFiles`, separately from Axterm's externally copied legal
files. It searches both the `app.asar` Resources directory and the artifact
root, so the same check can recognize macOS, Windows and Linux layouts without
claiming that all platforms have been exercised.

## Reproduction and verification

The inspected local unsigned directory artifact is
`release/mac-arm64/Axterm.app`. The following succeeded on macOS arm64:

```text
bunx vitest run tests/unit/packaged-license-inventory.test.ts
bun run --cwd apps/desktop build
bunx playwright test tests/e2e/packaged.spec.ts --project=packaged --grep 'packaged app includes Axterm and transition third-party license notices'
```

The focused unit test covers the `Resources`/artifact-root layout and hashed
records. The packaged journey reads the two files from the directory artifact
and compares their SHA-256 values against the installed Electron distribution.
It passed one of one journey on 2026-09-21.

Settings → About now makes these two exact documents readable without copying
them into the Renderer bundle. Electron Main registers the fixed,
read-only `axterm-license://electron/` and `axterm-license://chromium/`
documents after app readiness. The resolver rejects a non-root path, query,
fragment, credentials, port or unknown host; packaged builds read only the two
files above from `process.resourcesPath`, and development builds read the
matching Electron distribution files. The Renderer loads a document only when
the corresponding disclosure is opened, in an empty-sandbox iframe with a
no-referrer policy. This is a static resource channel, not business IPC or a
caller-controlled file protocol.

The following focused checks passed against a freshly rebuilt macOS arm64
directory package on 2026-09-21:

```text
bunx vitest run tests/unit/legal-runtime-documents.test.ts
bunx playwright test tests/e2e/desktop.spec.ts --project=desktop --grep 'production workspace, utility isolation, reattachment, crash restart and cleanup'
bunx playwright test tests/e2e/packaged.spec.ts --project=packaged --grep 'packaged app includes Axterm and transition third-party license notices|packaged app exposes its exact license and notices in About'
```

The packaged About test starts a copied-outside-checkout app, reads the Electron
license document and verifies a `200` response plus a greater-than-1 MiB
content length for the Chromium notice. The Desktop check verifies that the
production Renderer CSP permits only `frame-src axterm-license:` for this
purpose; it retains the existing script and connection restrictions.

The subsequent complete source gate also passed: 197 test files passed with
one skipped (870 tests passed with one skipped), together with the Level 1
architecture gate (365 modules / 1,301 dependencies), 267 Contract operations,
source supply-chain/localization checks, production build and three
visual/accessibility journeys.

## Limits and follow-up

This evidence proves only that the two preserved Electron runtime documents in
this unsigned macOS directory artifact match Electron 44.3.0. It does not map
every Electron or Chromium binary/file to source, establish Electron's full
transitive notice obligations, expose runtime materials beyond these two fixed
documents, test Windows/Linux layouts or sign/notarize an installer. It
therefore does not change IR-02 or IR-11 from **In progress**.
