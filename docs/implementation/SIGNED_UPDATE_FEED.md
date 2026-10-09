# Signed update feed

Packaged Axterm reads `AXTERM_UPDATE_FEED.json` from its signed application
Resources. The source of that file is
[`UPDATE_FEED_RECORD.json`](../../compliance/UPDATE_FEED_RECORD.json). An `active` record
pins the public HTTPS manifest URL and Ed25519 SPKI public key inside the
package; process environment cannot override either value. The current
record is `pending`, so ordinary local packages do **not** claim a configured
public updater. ADR-022 permits a later first Mac release with a verified public
HTTPS download page and manual updates while this record remains pending.
A missing or malformed packaged record reports
`UPDATE_CONFIGURATION_INVALID` rather than silently disabling the updater.

While the record is pending, an explicit local test environment may provide
both of these Desktop Host values for controlled fixtures:

```text
AXTERM_UPDATE_MANIFEST_URL=https://updates.example.com/stable/manifest.json
AXTERM_UPDATE_PUBLIC_KEY_BASE64=<Ed25519 SPKI DER encoded as Base64>
```

The public key is not a credential. The corresponding private signing key must
remain outside the repository and release runner logs. A partial local
configuration reports `UPDATE_CONFIGURATION_INVALID`; an absent one reports
`disabled` and performs no request. A later release that **enables automatic
updates** must fill the record with the real feed, public key and release-owner
approval, then pass `bun run release:updater-feed:active-check`. Ordinary `bun run check` accepts
the honest pending state but validates its shape. Neither check proves the
remote feed responds or that an installed signed upgrade succeeds.
The three installed-package gates and packaging CI also run
`release:updater-feed:package-check` against actual Resources. It rejects a
missing, linked or byte-different packaged record; after an active approval,
the release owner should additionally invoke that command with `--active`.

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

The `version` field follows [SemVer 2.0.0](https://semver.org/) and is capped at
128 characters. Axterm compares prerelease identifiers numerically or in ASCII
order as specified; a stable version ranks after its matching prereleases.
Build metadata is allowed in the signed string but does not affect update
precedence.

Sign this exact UTF-8 record, with LF separators and no trailing LF:

```text
version
publishedAt
artifact.fileName
artifact.size
artifact.sha256
artifact.url
JSON.stringify(notes)
```

The last line is the JSON string encoding of the `notes` value, including its
quotes and escaped newline characters (for example `"Fixes\nMore detail"`).
It prevents multiline release notes from changing the LF-delimited field
boundaries. A publisher must sign this **seven-line** record; the previous
six-line record is rejected. No production update feed has been approved or
published, so this format change does not migrate an active public signer.
The artifact signature field is the signature output and is not included in
the signed input.

The manifest is limited to 128 KiB. Manifest and artifact URLs require HTTPS, with loopback HTTP
allowed only for integration fixtures, and both URLs must have the same origin. Downloads use a
private mode-0600 `.part` file, enforce the declared size and 4 GiB ceiling, calculate SHA-256 while
streaming, and atomically rename only after verification. Axterm hashes the ready artifact again
immediately before asking the operating system to open it. Cancellation and every failure remove the
partial file when the filesystem permits cleanup; a cleanup failure is not evidence of a ready installer.

The artifact response may use chunked transfer encoding without `Content-Length`; when that header
is present, it must match the signed manifest size. The updater checks the actual streamed byte count
and retries short filesystem writes until each chunk is complete. A zero-progress write or failed
download-directory setup reports a stable error rather than marking an incomplete installer ready.

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
