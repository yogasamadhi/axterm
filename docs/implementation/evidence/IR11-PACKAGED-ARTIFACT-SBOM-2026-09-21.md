# IR-11 packaged-artifact SPDX sidecar evidence

Updated: 2026-09-23  
State: **macOS directory-artifact tooling verified; IR-02/IR-11 remain unaccepted**

The source-level `AXTERM_PRODUCTION_DEPENDENCIES.spdx.json` describes the
frozen Bun production graph. It cannot prove the contents of a specific
electron-builder artifact. `bun run sbom:packaged` now creates a deterministic
SPDX 2.3 **sidecar** from a concrete directory containing `app.asar`:

```text
bun run sbom:packaged -- <Resources directory> --platform <platform-arch> --output <sidecar>
```

The platform label is required and constrained. The sidecar namespace contains
the product version, that label and the observed ASAR SHA-256. It records the
non-workspace ASAR package manifests and the hashes of the ASAR itself,
Renderer asset files, unpacked files, Axterm-provided legal material and
available Electron/Chromium legal files. It records package manifest license
claims only as comments and uses `NOASSERTION` for file/package conclusions.

The report is intentionally made **after** electron-builder finishes, so it
does not alter a signed application and create a self-referential artifact hash.
It must be preserved next to each release's installer hashes; it is not itself
inserted into the application and is not a source-to-binary conclusion.

## Earlier macOS arm64 directory-artifact result

The current local unsigned directory artifact was inspected with:

```text
bun run sbom:packaged -- release/mac-arm64/Axterm.app/Contents/Resources \
  --platform macos-arm64 \
  --output release/AXTERM_PACKAGED_ARTIFACTS.macos-arm64.spdx.json
```

| Field                    | Value                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `app.asar` SHA-256       | `055aa095fac2eb44a39d2711b0733c3f920356c0d4f44186570542d029acc74b`                                                      |
| Sidecar SHA-256          | `c5a17aca00ab1af652a4e7c4fb4fd0d2104c14c20c4d391af8174e5a56d9380b`                                                      |
| SPDX package records     | 87 (one Axterm artifact plus 86 non-workspace packaged manifests)                                                       |
| File records             | 233                                                                                                                     |
| `CONTAINS` relationships | 319                                                                                                                     |
| Namespace                | `https://axterm.dev/sbom/artifacts/0.10.0/macos-arm64/055aa095fac2eb44a39d2711b0733c3f920356c0d4f44186570542d029acc74b` |

The 233 files are the observed ASAR, emitted Renderer assets, `app.asar.unpacked`
files, external legal materials and Electron/Chromium legal files; they are not
an assertion that these are the only files in a signed installer or that every
binary has a complete source map.

## Current macOS arm64 directory-app sidecar — 2026-09-23

After the P-03 FTP change, a fresh `bun run package:dir` built the current
unsigned directory app. The earlier standard-named sidecar and DMG/ZIP hash
manifest remain attached to their older 2026-09-22 artifact; they were not
overwritten or re-labeled as evidence for this new directory app. The current
sidecar is separately preserved at
`release/AXTERM_PACKAGED_ARTIFACTS.macos-arm64.dir-2026-09-23.spdx.json`.

| Field                           | Current value                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `app.asar`                      | 101,556,447 bytes; SHA-256 `339af8aa667f87d106d473d4c8e30b0fe50e1e5e671d3489fd11d6b82746875e`                           |
| Sidecar SHA-256                 | `8a265b96757208767ab63adc3189c3444253bfadf134f50099ddbbadf1c5020a`                                                      |
| SPDX inventory                  | 87 package records, 233 file records, 319 `CONTAINS` relationships                                                      |
| Namespace                       | `https://axterm.dev/sbom/artifacts/0.10.0/macos-arm64/339af8aa667f87d106d473d4c8e30b0fe50e1e5e671d3489fd11d6b82746875e` |
| Packaged/source notices SHA-256 | `2e54be6ed3f48e0ada8fc145a03b98c6fab8b2c173fbe1cd6744058ab8c382cb`                                                      |

The inventory's `./Resources/app.asar` and `./THIRD_PARTY_NOTICES.txt`
checksums match the corresponding current packaged files. Running the sidecar
generator a second time to standard output produced the same SHA-256. The
older macOS release-artifact hash manifest still verifies against the older
DMG/ZIP bytes; it is not a hash manifest for this current directory app. The
complete current packaged journey passed 17 macOS-applicable tests with ten
platform/fixture skips. This is an artifact inventory, not a legal or
source-to-binary conclusion; IR-02/IR-11 remain **In progress**.

## Current macOS arm64 package and Legal/About check — 2026-09-24

A fresh unsigned directory app was built in the isolated temporary output
`/private/tmp/axterm-ir11-current.lotYE2/`; the existing repository `release/`
artifacts were not touched. Its `Resources/app.asar` is 101,690,179 bytes with
SHA-256
`a8cc37512b542acabe3cc1c6b6f14d0663ef9c14c885ae43ba04bfdabcb52dce`. The
packaged SPDX 2.3 sidecar has SHA-256
`97e211d6c03e3a472d52bee058e3685b23e52b28760db0e5096e73987bc8ed5b` and
contains 87 package records, 246 file records and 332 relationships. Its
namespace binds to the exact ASAR hash. The packaged
`Contents/THIRD_PARTY_NOTICES.txt` SHA-256 is
`45b153c0c9ae06814f8a2ef22999bcbf9ba92951a05fef29c8d980a9f6ce4332`, equal
to the source notice file.

`bun run sbom:packaged:check` regenerated and byte-verified that sidecar against
the concrete app resources, then wrote a local verification receipt with
SHA-256
`e96e90f359f95240386deb4153b1f414a7781cad1c3dfb699c05463783658457`. The
focused packaged Electron run passed both the archive-file equality test and
the Legal/About UI test (**2/2**); it compared the displayed Apache license,
third-party notice, per-component license texts, component index, production
SBOM and Electron/Chromium legal documents with the repository/package
sources. These are current unsigned local macOS directory-package results,
not a signed release or an independent legal/source-rights review. IR-02/IR-11
remain **In progress**; Windows package evidence, native Linux acceptance and
qualified rights review remain outstanding.

## Isolated current DMG candidate sidecar — 2026-09-23

The newer unsigned installed-DMG candidate was built in
`release/axterm-dmg-candidate-zhnYLDEW/` so the earlier release artifacts and
directory-app sidecar remained untouched. Its 101,556,447-byte `app.asar`
SHA-256 is `ae2a3caa580f912625bcb83fe9307ec0a762e1017857b7903dc4c0e669e4dace`;
the candidate's `AXTERM_PACKAGED_ARTIFACTS.macos-arm64.spdx.json` SHA-256 is
`7fbe37e96b849ed9ed241ca6361ac87858777fa4e8b10cbc92e76f498ec05de2`.
The namespace ends in that exact ASAR hash. The sidecar retains 87 package
records, 233 file records and 319 relationships, including the source-matching
third-party notices SHA-256
`2e54be6ed3f48e0ada8fc145a03b98c6fab8b2c173fbe1cd6744058ab8c382cb`.
The DMG passed a full copied-install packaged journey (17 passed, 10 skipped)
and its DMG/ZIP hash manifest verified; see the
[installation evidence](IR13-MACOS-DMG-2026-09-21.md).

The new `bun run sbom:packaged:check` regenerated the sidecar directly from
this candidate's packaged Resources and required byte-for-byte equality with
the retained `7fbe37…` SPDX file. It reported that exact sidecar SHA-256 and
the candidate `app.asar` SHA-256 above. CI now applies the same post-install,
pre-upload check to macOS, Windows and Linux package resources. A unit
regression rejects changed ASAR bytes, changed packaged notices and a wrong
platform identity. This closes a sidecar-staleness gap, not the unsolved
source-to-binary or legal-review work.

The verifier can also write a non-overwriting receipt after a successful
comparison. Against this local candidate it wrote
`release/axterm-dmg-candidate-zhnYLDEW/AXTERM_SPDX_LOCAL_VERIFICATION.macos-arm64.json`
with SHA-256 `b8829e9cc1bac142298ea463a85c613404cd2aecbdc1e428f33805bf3f177946`.
Its 297,340-byte sidecar and `app.asar` hashes match this section. A repeat
attempt refused to overwrite that receipt. This is **local verification**,
not an artifact-download receipt. The CI workflow is now configured to
download each platform's uploaded SPDX sidecar and rerun the verifier against
the packaged resources before issuing a separately named SPDX round-trip
receipt; no green remote CI receipt is asserted here.
All three installed-package gates now require the matching sidecar next to the
installer and compare it with the installed app before packaged journeys. The
current macOS DMG was rerun through that gate: its copied-outside-checkout app
matched the candidate sidecar byte-for-byte, then passed 17 journeys with ten
conditional skips. The Windows NSIS gate change has unit and shell-syntax
coverage but still awaits that platform's installed-package run. The Linux DEB
gate has since run; its exact evidence is recorded below.

This is a separate inventory from the directory app above, whose equal-length
ASAR has a different hash. Neither inventory establishes complete file-level
rights or signed cross-platform distribution; IR-02/IR-11 remain **In progress**.

## Automation and limits

`tests/unit/packaged-artifact-sbom.test.ts` verifies deterministic SPDX
identities, package/file coverage, the unsafe-path rejection boundary,
sidecar-staleness rejection, receipt content and the three configured CI
generation/check/download invocations. `.github/workflows/check.yml`
generates, post-install verifies, uploads and downloads a
`packaged-sbom-<runner OS>` sidecar on macOS, Windows and Linux.
A future green CI artifact is platform-specific engineering evidence, not
signing/notarization, source-rights or legal acceptance.

## Current Linux x64 installed-DEB sidecar — 2026-09-23

A new `linux/amd64` AppImage/DEB candidate was built from an audited source-only
snapshot under macOS arm64 emulation. Its packaged-resources sidecar has
SHA-256 `27f80994aa6260c98fdc5e2cfb4affa4427003b1d0a29559c99fd334de281047`
and binds the 101,556,187-byte `app.asar` with SHA-256
`a09ab63bbcf4e4e099612fd70b45e39099d4bc900758a245aa997995992a7764`.
It contains 87 package, 232 file and 318 relationship records.
`sbom:packaged:check` passed against the unpacked build and, separately,
against `/opt/Axterm/resources` after APT installed the exact DEB. The
installed-app gate then passed 19 applicable journeys with eight conditional
skips. The sidecar and installer hash manifest remain with the ignored local
candidate at `release/axterm-linux-candidate-hQGbuTZQ/`. See the
[Linux installed-package evidence](IR13-LINUX-X64-INSTALL-ATTEMPT-2026-09-22.md)
for the exact artifacts, environment, check limitation and remaining gates.
This adds one reproducible installed-resource check; it does not promote
IR-02, IR-11 or IR-13 to acceptance.

The **AppImage itself** was then opened as SquashFS on the macOS arm64 audit
host without running its x64 launcher. Its valid superblock begins at byte
188,392. The extracted payload includes `LICENSE.axterm`,
`THIRD_PARTY_NOTICES.txt`, `THIRD_PARTY_COMPONENTS.json`,
`THIRD_PARTY_LICENSE_TEXTS.json`, `AXTERM_PRODUCTION_DEPENDENCIES.spdx.json`,
the `licenses/` directory and Electron/Chromium license files. Its `app.asar`
hash is the same `a09ab63…` above. Running
`bun run test:appimage:linux -- --artifact-dir release/axterm-linux-candidate-hQGbuTZQ`
regenerated the complete packaged inventory from the extracted AppImage and
matched the retained sidecar SHA-256 `27f809…` byte-for-byte. CI now runs the
same static payload check before upload and against the downloaded AppImage
and sidecar. No remote green CI run or native AppImage launch is claimed.

The current result covers local unsigned macOS directory-app and installed-DMG
candidate plus emulated Linux x64 installed-DEB evidence. Windows sidecars,
signed/notarized installers, complete installed-product file maps,
Electron/Chromium component/source mapping, exact file-level copyright notices,
and qualified LGPL/MPL/source-rights review remain required for IR-02/IR-11.

## noVNC provenance file and SPDX file-type correction — 2026-09-23

The real Vite/Rollup noVNC module-to-chunk map is emitted at
`out/renderer/axterm-novnc-bundle-provenance.json`, outside the `assets/`
subdirectory. The older packaged inventory enumerated renderer assets under
`assets/` but did not give this JSON a separate file record; only the enclosing
ASAR hash covered it. The inventory and sidecar now record its individual
SHA-256 `4da93a3f9e2e4dc3cc7f0c830290d99f63e574f9139c1a6e2f2b592276f43bca`
as `./Resources/app.asar/out/renderer/axterm-novnc-bundle-provenance.json`.
A unit regression checks both inventory extraction and sidecar mapping, plus
rejection when the packaged provenance bytes change.

The same pass corrected obvious SPDX 2.3 file-type misclassifications:
`app.asar` is `ARCHIVE`, text renderer assets and provenance JSON are `TEXT`,
images are `IMAGE`, the source dependency sidecar is `SPDX`/`TEXT`, and legal
texts are `TEXT`; native and other binary material retain `BINARY`. These
categories follow the [SPDX 2.3 file-type definitions](https://spdx.github.io/spdx-spec/v2.3/file-information/)
and remain conservative metadata rather than license conclusions.

An isolated unsigned macOS arm64 directory app has `app.asar` SHA-256
`cf8e2bf64542ba65b1200961cac60465aba247031868ba4243cd91ac7172731b`.
The regenerated 87-package / 237-file sidecar SHA-256 is
`43e881b3dc1167a65029cf159baf38028afaaa10feec93087b5fd1e65c73f93b`;
`sbom:packaged:check` reproduced it byte-for-byte from that app. The packaged
legal/About journeys passed 2/2 and the package inventory independently
reported the provenance file hash. This current sidecar supersedes neither the
older retained candidate sidecars nor their bytes; those remain historical
artifact-specific receipts. The inspected app was a local unsigned directory
build, not Windows/Linux installed or a signed public release. IR-02/IR-11
remain **In progress**. The isolated package and its two generated sidecars
were moved to Trash after verification; the recorded hashes remain in this
evidence and no retained release candidate was overwritten.
