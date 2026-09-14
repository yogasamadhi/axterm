# Signed update feed

Axterm leaves its updater disabled unless both of these Desktop Host environment values are present:

```text
AXTERM_UPDATE_MANIFEST_URL=https://updates.example.com/stable/manifest.json
AXTERM_UPDATE_PUBLIC_KEY_BASE64=<Ed25519 SPKI DER encoded as Base64>
```

The public key is not a credential. The corresponding private signing key must remain outside the
repository and release runner logs. A partial configuration reports
`UPDATE_CONFIGURATION_INVALID`; an absent configuration reports `disabled` and performs no request.

The manifest is strict JSON:

```json
{
  "version": "0.11.0",
  "publishedAt": "2026-09-14T00:00:00.000Z",
  "notes": "Release notes",
  "artifact": {
    "url": "https://updates.example.com/stable/Axterm-0.11.0-arm64.dmg",
    "fileName": "Axterm-0.11.0-arm64.dmg",
    "size": 123456789,
    "sha256": "<64 lowercase hexadecimal characters>",
    "signature": "<Base64 Ed25519 signature>"
  }
}
```

Sign this exact UTF-8 record, with LF separators and no trailing LF:

```text
version
publishedAt
artifact.fileName
artifact.size
artifact.sha256
artifact.url
```

The manifest is limited to 128 KiB. Manifest and artifact URLs require HTTPS, with loopback HTTP
allowed only for integration fixtures, and both URLs must have the same origin. Downloads use a
private mode-0600 `.part` file, enforce the declared size and 4 GiB ceiling, calculate SHA-256 while
streaming, and atomically rename only after verification. Axterm hashes the ready artifact again
immediately before asking the operating system to open it. Cancellation and every failure remove the
partial file.

The Settings → Common updater card exposes check, download, progress, cancel and installer handoff.
Runtime and Renderer receive only state, available version, percentage and stable error code. They
never receive the manifest URL, artifact URL, signing material or local installer path.

The local signed-feed unit/integration and production Electron journey can be run with:

```bash
bunx vitest run tests/unit/signed-release-updater.test.ts tests/unit/host-window-capability.test.ts tests/integration/window-capability.test.ts
bun run build
bunx playwright test --project=desktop -g 'H12 signed updater'
```

The local Ed25519 fixture proves protocol behavior. Release certification additionally requires a
controlled HTTPS feed, production signing identity, signed package and binary-to-binary installed
upgrade on macOS, Windows and Linux.
