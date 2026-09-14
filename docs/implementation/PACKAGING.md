# Desktop packaging and acceptance

Updated: 2026-09-14

## Targets

The electron-builder configuration in `apps/desktop/electron-builder.yml` defines:

| Platform | Architecture | Artifacts                    | Current evidence                                 |
| -------- | ------------ | ---------------------------- | ------------------------------------------------ |
| macOS    | arm64        | DMG, ZIP, `.app`             | Built, packaged journeys and archive checks pass |
| Windows  | x64          | NSIS installer, unpacked app | Configuration only; Windows run required         |
| Linux    | x64          | AppImage, deb, unpacked app  | Configuration only; Linux run required           |

The current macOS artifacts are unsigned development outputs. They are written to
`release/` and are not uploaded by any package command.

Packaged metadata declares the `axterm`, compatible `electerm`, `ssh`, `telnet`,
`vnc`, `rdp`, `spice`, `serial` and `ftp` session schemes. HTTP and HTTPS are not
claimed. The desktop uses a single-instance lock and forwards initial, macOS
`open-url` and second-instance links through the ADR-012 authenticated Runtime
ingress. Production Electron tests exercise those three handlers; installation-level
registration and activation still require evidence from each target operating system.

The source launcher uses a separate `Axterm Dev` application identity, user-data directory,
single-instance domain and Windows AppUserModelID. Running `bun run.ts` therefore cannot focus or
reuse an installed Axterm process, and development state never overwrites the packaged profile.
An explicit Electron `--user-data-dir` remains authoritative for isolated automation.

## Native modules

`node-pty` 1.1.0 carries the minimal macOS descriptor-close fix recorded in
`patches/node-pty@1.1.0.patch`. Development installation compiles that source for the current Node
ABI through `scripts/prepare-native.mjs`; a source-hash/ABI marker avoids redundant rebuilds.
`scripts/rebuild-native.mjs` then invokes `@electron/rebuild` for `node-pty` and
`@serialport/bindings-cpp` using the exact Electron version from the Desktop package before
electron-builder runs. `scripts/package-desktop.mjs` first snapshots the complete workspace
`node-pty/build` directory and restores it in `finally` after electron-builder has copied its
Electron artifacts, including when rebuild or packaging fails. Direct Electron rebuilds also
remove every Node ABI marker so the next preparation cannot trust a replaced binary. Unit tests
cover exact restoration, missing-build cleanup, idempotency and marker invalidation. The packaged
native binary and helper are unpacked from ASAR so the operating system can load/execute them.
Build tooling is never an end-user prerequisite.

`ssh2` works without its optional `cpu-features` accelerator. That accelerator is
excluded because its published package is incomplete for electron-builder's broad
rebuild path. SSH protocol behavior remains in ssh2's JavaScript implementation.
`ws` is also a packaged external dependency; bundling it changed the shape of its
optional `bufferutil` branch and caused binary terminal frames to crash the Runtime.

`zmodem2` 1.4.0, `trzsz2` 1.2.0 and the adapted Electerm XMODEM state machine are
pure JavaScript and are bundled into the separate Runtime artifact. The packaging
gate verifies all three protocol markers are present and that no copied source or
workspace dependency remains. `trzsz2` 1.2.0 declares a missing top-level type path;
the committed Bun patch redirects only that declaration to the shipped
`dist/esm/lib/index.d.ts` and does not change executable code.

The packaged tests are the ABI gate. They launch the copied application with a PATH
that contains no user Node/Bun installation, start a local PTY, and verify output.
The Docker variant also establishes a real SSH terminal from the packaged app. This is a
repository-only integration fixture: Docker is not shipped, invoked by the application or required
on an end-user machine. Fixture containers use Docker auto-remove plus an `EXIT`/interrupt trap and
have no restart policy or product-data mount.

## Commands

```sh
bun install --frozen-lockfile
bun run check
bun run test:e2e
bun run package:dir
bun run test:packaged
bun run test:dmg:macos
bun run test:ssh:packaged
bun run package
```

`test:dmg:macos` is the macOS installation gate. It verifies the sole DMG in `release/`, mounts it read-only, copies `Axterm.app` with preserved framework links, detaches the image, and runs the packaged suite only from the independent installation directory. An explicit DMG may be supplied as the first argument or with `AXTERM_DMG_PATH`; every exit path detaches and removes its temporary directories.

`test:ssh:packaged` requires Docker and an existing current-platform unpacked app.
It starts the digest-pinned OpenSSH fixture, runs the headless SSH/SFTP/tunnel suite,
then tests Host Key approval and SSH PTY output through the packaged UI. The script
always removes its fixture container.

On Linux, run Electron smoke tests in a graphical session or under `xvfb-run`. The
CI matrix in `.github/workflows/check.yml` contains the platform-specific commands,
but a workflow definition is not acceptance evidence until that runner passes.

## Signing boundary

electron-builder owns platform signing. The repository contains the macOS hardened
runtime entitlements and Windows executable-signing configuration, while identities
remain external secrets supplied by the release environment. Standard
electron-builder signing inputs such as `CSC_LINK` and `CSC_KEY_PASSWORD` may be set
by a protected release job. No certificate, password, Apple credential or private
key belongs in this repository.

The package wrapper always sets `CSC_IDENTITY_AUTO_DISCOVERY=false`, so a local
build never scans the developer's login keychain for a signing identity. A release
job can still provide an explicit certificate file through `CSC_LINK`; it must also
perform notarization and platform installation checks before it can become Desktop
1.0 evidence.

## Updater boundary

The default package has no update publisher/server, so Desktop Host reports
`state: disabled` and the Settings UI accurately shows that state. A controlled
release job can configure `AXTERM_UPDATE_MANIFEST_URL` and
`AXTERM_UPDATE_PUBLIC_KEY_BASE64`; the Desktop Host then owns signed manifest
checks, bounded streaming download, progress, cancellation, SHA-256/Ed25519
verification, private temporary files and OS installer handoff. Runtime and Renderer
only receive safe status metadata and actions through the authenticated Host boundary;
they never receive the feed URL or installer path. The exact manifest and signing
record are defined in [SIGNED_UPDATE_FEED](SIGNED_UPDATE_FEED.md) and the architecture
decision is [ADR-015](../adr/ADR-015-signed-desktop-update-provider.md).

Production Electron already passes a signed loopback check/download/cancel/retry/install
journey. The freshly copied macOS arm64 package also passes its equivalent
check/download/ready/install flow and proves the local installer path does not cross into Renderer.
The same journey is present for every platform. Official HTTPS publishing, production signing
identity, rollback metadata and installed binary-to-binary upgrade evidence remain release requirements.

## Acceptance record

On macOS arm64, version `0.10.0` produced:

- `Axterm-0.10.0-arm64.dmg`;
- `Axterm-0.10.0-arm64-mac.zip`;
- `mac-arm64/Axterm.app`.

The 2026-09-14 artifacts have these SHA-256 digests:

- DMG: `496bf7e712639d1dc265db28ac0065a57535318410e335b3b2c290311813aa99`;
- ZIP: `fca121500f70b18eda5cd88d8f9fef0d0d685e88237b417e516d151bd5e74d25`.

`hdiutil verify` accepts the DMG and `unzip -tq` reports no ZIP error. The DMG was then mounted read-only;
its `.app` was copied into an independent temporary installation directory and passed all five runnable
package journeys: checkout-independent Runtime/local PTY/SQLite/native SerialPort, Phase 12 shell/workspace
behavior, H-11 localization plus cold restart, old-schema/local-Vault upgrade, and the signed updater flow.
The mount and installation directory were removed after the run. The SSH package journey is conditionally
separated and its earlier macOS OpenSSH terminal/SFTP evidence remains valid. A post-package Node ABI smoke
confirms that native-build snapshot restoration leaves development node-pty usable. Windows x64, Linux x64
and installed binary-to-binary upgrade checks remain pending, so Phase 10 and the Desktop 1.0 Definition of
Done remain open.
