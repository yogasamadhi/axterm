# IR-03 macOS arm64 native publication and package trial — 2026-09-24

Status: **macOS arm64 engineering verification passed; IR-03 and release adoption remain In progress**.

The worktree pins `@openclaw/fs-safe@0.13.1` for the Runtime and desktop
package. The Runtime's staged-file publisher first tries atomic `link()`;
on a filesystem hard-link rejection it calls the package's public
`publishFileExclusive({ strategy: 'rename-noreplace' })`. It no longer uses
the non-atomic `COPYFILE_EXCL` fallback. A missing native helper fails closed.
XMODEM, ZMODEM and TRZSZ tolerate a rename consuming the private staging
pathname. XMODEM defers EOT acknowledgement and completion until publication
settles and reports an indeterminate-durability error when the native receipt
says that the final file was created before a later sync failure.

## Local evidence

- Focused staged-publication tests cover actual macOS native success,
  collision preservation, native-unavailable failure, the hard-link fast
  path and the post-rename receipt classification. The bundled native helper
  was also exercised by the packaged Electron executable in Node mode:
  complete `000102ff` bytes appeared at the final path, the staging name was
  consumed, directory sync reported `synced`, and a second attempt raised
  `EEXIST` while preserving both files. A permanent packaged Playwright
  regression guards that behavior.
- A fresh unsigned macOS arm64 DMG was created in an isolated temporary
  output. `hdiutil verify` passed. The DMG was mounted, the app copied out,
  the mount detached, and the copied app passed **21 applicable packaged
  journeys, 11 platform/fixture skips, no failures**. These include actual
  local-PTY XMODEM, ZMODEM and TRZSZ binary roundtrips, notices, four locales,
  FTP Widget, updater fixture, UI/accessibility and old-data migration. A
  separate SSH fixture run passed the integration, development-desktop and
  packaged-app authentication journeys. The new bundled-native regression
  passed separately against the same DMG-built app.
- The exact packaged Resources matched a generated and verified SPDX 2.3
  sidecar: **102 packages, 248 files, 349 relationships**. Both the parent
  package and macOS arm64 native package are present; only the native `.node`
  is unpacked. The packaged legal-document journey passed. The source graph
  now has **140** production component entries and **132** archived root legal
  files; the native subpackage has an MIT manifest but no own root LICENSE and
  remains in the human attribution-review queue.
- `bun run check` passed after the implementation: **222 test files,
  1,133 passed, 33 skipped**; 360 architecture modules / 1,310 dependencies,
  267 Contract operations, source/license/SBOM gates, build layout and
  11 visual/accessibility journeys.
- `bun run candidate:check` also passed from a temporary new Git root and
  fresh clone without the Legacy Prototype submodule. Frozen Bun installation included
  the macOS native package, and the clone reran the same complete check.
  The snapshot guard reported 846 source files, no forbidden entries or
  dependency violations, and source-tree SHA-256
  `71de2529785baad251893045b986c3578aeec6a4294b220cd98aa0580d6191af`.
  This is local clean-checkout reproducibility, not the owner's future public
  repository or signed release.

## Real hard-link-limited macOS volume

A writable 64 MiB local disk image created with `hdiutil -fs MS-DOS` was
mounted as `/dev/disk4s1` (`diskutil`: **MS-DOS FAT16**, `msdos` bundle).
An actual `fs.link()` call between two paths in the same mounted directory
returned `ENOTSUP`. With
`AXTERM_REAL_NOHARDLINK_DIRECTORY` pointing to that mount, the focused
Runtime test passed **7/7**: complete native publication consumed staging,
and a collision preserved both the complete existing destination and new
staging bytes. The test first asserts that the supplied volume truly rejects
hard links, so an ordinary APFS run cannot masquerade as fallback coverage.

The same environment was used for the **DMG-built macOS arm64 app's** real
local-PTY TRZSZ, ZMODEM and XMODEM packaged journeys. Each test selected a
fresh download directory on the FAT16 volume, confirmed a same-directory
hard-link rejection, and then roundtripped binary bytes through the UI and
Runtime. All **3/3** passed, and the mounted volume contained no test files
after deterministic cleanup. This is real filesystem and packaged protocol
evidence for this particular macOS FAT16 implementation; it does not prove
crash durability, SMB/NFS behavior or Windows/Linux native primitives.

## ExFAT fail-closed portability follow-up

A separate writable 128 MiB local ExFAT image was mounted on macOS arm64
(`diskutil`: **ExFAT**, `exfat` bundle). On this real volume, same-directory
`link()` rejects with `ENOTSUP`, and the pinned native `rename-noreplace`
helper also rejects with `ENOTSUP` (`Operation not supported`, OS error 45).
The FAT16 success above therefore must not be generalized to all removable
filesystem formats. Copying to the final name with `COPYFILE_EXCL` would expose
partial destination bytes, so the Runtime continues to fail closed.

New environment-gated `AXTERM_REAL_NO_REPLACE_DIRECTORY` tests cover the
real-volume publisher and each of the XMODEM, ZMODEM and TRZSZ receive paths.
All four targeted tests passed on this ExFAT mount: no final payload or
transfer staging file remained, an existing final file retained its bytes,
and all three protocols reported the fixed path-free
`TRANSFER_DESTINATION_UNSUPPORTED` code instead of completion. The adapter
allowlists that code, the Application maps it to transfer state, and the
Renderer now explains in all four supported languages that the user should
choose a different destination and retry. The unit suite also tests that
other filesystem failures are not mislabeled. macOS ExFAT creates `._`
AppleDouble metadata sidecars; the payload assertions exclude these OS
sidecars but do not exclude application staging names.

The current source was rebuilt into an isolated macOS arm64 directory app,
then into a fresh unsigned DMG/ZIP. `hdiutil verify` passed; the DMG was
mounted and its app copied out, and the copied `app.asar` matched the mounted
image byte-for-byte. Against both the directory app and the DMG-copied app,
the three new packaged local-PTY ExFAT journeys passed **3/3**: each protocol
displayed the localized unsupported-destination guidance, reached `failed`
without `file-complete`, and left no final payload or `.part` file in the
selected real ExFAT directory. The DMG-copied app also passed the ordinary
packaged suite **22 applicable, 14 conditional platform/fixture skips**,
including successful APFS protocol roundtrips and readable About notices.
The exact DMG-copied Resources matched a **102-package, 285-file,
386-relationship** SPDX sidecar. The mounted DMG was detached after copying.

| New macOS artifact                                           | SHA-256                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `Axterm-0.10.0-arm64.dmg`                                    | `8b5f2462375c84af25c0585441008cb666c7fc47f1e8879aafdacda4983de917` |
| `Axterm-0.10.0-arm64-mac.zip`                                | `8a5f57a0b23b9a340815c864c87d03531af54df1b498d6ab4e48d3c692958661` |
| DMG-copied `app.asar`                                        | `c2e5386d665859d341eb163fe0f98305db9c1337f5a53793446ce043bb3232f7` |
| DMG-copied `fs-safe-native.node`                             | `78ca69b52d05da239bf50a6768867134265aace0195c8494f64f65b6d1ba6db0` |
| DMG-copied `AXTERM_PACKAGED_ARTIFACTS.macos-arm64.spdx.json` | `c6a61a7f2f9c84fd562dfbf5361dc7482355f711baa49982680b8fc55fedd4e2` |

This is a verified **fail-closed ExFAT** behavior, not a claim that ExFAT
downloads succeed. The package remains unsigned and unnotarized; there is no
crash-durability, network-volume, public update, source-rights or real-user
upgrade acceptance. IR-03 remains In progress. The test image and package
outputs under `/tmp/axterm-exfat-ir03-jGEesw`,
`/tmp/axterm-exfat-dmg-ZJv4NB` and `/tmp/axterm-dmg-copied-DhetNQ` are
ephemeral local evidence, not public release artifacts.
After the four-locale catalog and its pending-review ledger were updated to
2,585 keys, the complete `bun run check` passed: **235 unit/integration
files, 1,177 tests passed, 38 skipped**, 360 architecture modules / 1,310
dependencies, 267 Contract operations, source/license/SBOM/build gates and
11 visual/accessibility journeys. This does not replace human release
approvals.

## Historical package upgrade against this candidate

The conditional packaged upgrade journey passed **1/1** against a preserved
application built from commit `657b3cc1552cd3b0dc3b0f73df1c1a4a5a8a6a6e`
and this DMG-built current app. The historical `app.asar` SHA-256 was
`5dc53bcc5997016a33e8fa41d588462a7b441cde759b181c95e4df6f91c916b0`;
the current one was
`805273cab7feebddc1144711797967e485f7b42b0d2aa1cc7b9e9df3a664f638`.
The ignored machine-readable test receipt SHA-256 was
`2dfa44fde1c56db5d8b6f5278798cc6a65491f0d06b3f6193be308b3ce940bea`.
It reports migration 33→38, a pre-upgrade database backup byte-identical to
the closed source, byte-identical Vault files with successful credential
roundtrips, preserved Host/Bookmark/Profile/Quick Command relationships,
legacy theme remapping, old WebDAV configuration and encrypted/plaintext
remote recovery without silent remote writes. Both applications report
version `0.10.0`; the historical one is a source rebuild, not an archived
signed public installer or actual customer profile. This does not start the
public migration window or accept IR-08.

### Latest DMG-copied app revalidation

The preserved historical-source application was byte-checked again against
the `657b3cc` `app.asar` SHA-256 above. With the newest DMG-copied application
(`app.asar` SHA-256
`c2e5386d665859d341eb163fe0f98305db9c1337f5a53793446ce043bb3232f7`),
the conditional packaged upgrade passed **1/1**. Its ignored structured
receipt, `test-results/packaged-evidence/historical-package-upgrade.json`,
has SHA-256
`b2542154f2851c547d0d721ab92c8b95d3868c47e6dbc832209e3b728968c2a3`.
It reports migration 33→38, the pre-migration backup identical to the closed
old database, Vault files byte-identical across the upgrade with credential
roundtrips, preserved Host/Bookmark/Profile/Quick Command relationships,
legacy theme mapping, and encrypted/plaintext WebDAV recovery after explicit
confirmation without recovery-side writes. The fixture is synthetic and the
old application is a source rebuild with the same `0.10.0` version, so this
does not establish a real public-version/customer-data upgrade.

The same newest DMG-copied app passed the controlled Docker OpenSSH
`test:ssh:packaged` route: Runtime integration **1/1**, source Electron
save-and-connect **1/1**, and packaged SSH authentication, Host Key, PTY,
SFTP and persistence **1/1**. The wrapper's labeled containers and private
network were absent after exit. This is a controlled peer, not an
independently operated external SSH service or a source-rights conclusion.

## Artifact identities

| Artifact                                          | SHA-256                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `Axterm-0.10.0-arm64.dmg`                         | `c79b573a90c5ecebe4d269e921f2cb999d450e526915da87fa2a58b3c01e51ab` |
| `Axterm-0.10.0-arm64-mac.zip`                     | `497c2efcfaf2a714b03c9dcd56322837cf04806e03e30f40d5a0ebfac1cb9fdf` |
| `app.asar`                                        | `805273cab7feebddc1144711797967e485f7b42b0d2aa1cc7b9e9df3a664f638` |
| `fs-safe-native.node`                             | `78ca69b52d05da239bf50a6768867134265aace0195c8494f64f65b6d1ba6db0` |
| `AXTERM_PACKAGED_ARTIFACTS.macos-arm64.spdx.json` | `17a6c580e6697bc6ab7d3415f623ef5a625ccf8c87761b0edbbdac936400eb9d` |

The trial output is under `/tmp/axterm-fs-safe-mac-dmg-qo6TKx`; it is
ephemeral local evidence, not a public release artifact. The app is **unsigned
and unnotarized**. The packaged updater test uses a local signed fixture, not
an active public HTTPS service. The native unit test also forces the fallback at the
Adapter boundary and invokes the packaged helper directly; the FAT16 test
adds a real local hard-link-limited volume, but no networked/removable volume
or crash-interruption guarantee. Exact source-line rights, native binary build reproducibility, the
subpackage's missing root LICENSE, and Windows/native-Linux packages remain
open. None of IR-02, IR-03, IR-11 or IR-13 is promoted by this record.
