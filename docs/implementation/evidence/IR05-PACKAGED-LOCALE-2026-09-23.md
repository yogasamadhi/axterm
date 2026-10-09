# IR-05 macOS packaged four-locale evidence — 2026-09-23

State: **unsigned local directory-package evidence; IR-05 and IR-10 remain In progress**

## Artifact identity

After localizing the language-card eyebrow, the current worktree was packaged
into a newly created temporary output directory, leaving existing release
artifacts untouched. The tested bundle was Axterm `0.10.0`, macOS arm64,
Electron `44.3.0`, built by electron-builder `26.16.1` on Darwin `27.0.0`. The
executable is an ad-hoc local build, not a Developer ID signed or notarized
release.

| Evidence                           | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| Packaged `app.asar`                | `2c6b78a0d075e624e60121189966b33cc5392cea212ae28472a27d49edc428ca` |
| Packaged SPDX 2.3 sidecar          | `895d37beccc3a138265dc9d9449bcfa6c10a2f2bbec635b34cd98ef0c262f74c` |
| Packaged SPDX verification receipt | `4f361cf0871b2b1a04da948fcbfb576ec113d07f3656444bda9237b41b0296c0` |

The verified SPDX inventory covers 87 package records, 246 artifact files and
332 relationships. These hashes identify this local candidate only; the
temporary package and sidecar were removed after verification and are not a
published or retained release artifact.

## Checks performed

The package was built with:

```sh
node scripts/package-desktop.mjs --dir --output /tmp/axterm-packaged-locale-current.USWnYM
```

The packaged-resource SBOM was generated and verified against that exact
bundle. The following focused test run passed **2/2**:

```sh
AXTERM_PACKAGED_APP=/tmp/axterm-packaged-locale-current.USWnYM/mac-arm64/Axterm.app \
  ./node_modules/.bin/playwright test --project=packaged \
  --grep 'packaged app keeps only the four selected Electron runtime locale families|packaged H-11 localization switches immediately and survives a cold restart'
```

The tests verify that the packaged selector exposes exactly four choices; the
English setting survives a cold restart; the bundled navigation catalog
switches through `en`, `ja`, `zh-CN` and `zh-TW`; the active document locale and
direction update; and the packaged Electron runtime contains only the four
selected locale families. H-11 also asserts the packaged Settings eyebrow is
`SETTINGS`, `設定`, `设置` and `設定` for those locales and checks
representative localized copy and product surfaces.

## Limits

This is a local directory package, not a mounted DMG or installed signed
release. It does not provide Windows/native-Linux evidence, independent
translation or rights review, a comprehensive visible-copy audit, trademark
or design approval, or final release acceptance. It improves packaged macOS
evidence but does not promote IR-05, IR-10, IR-11 or IR-13 to Accepted.
