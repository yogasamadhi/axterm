# IR-08 legacy remote-sync backup evidence

Date: 2026-09-20  
Scope: P-06 migration-period backup of an existing remote sync document  
State: partial IR-08 evidence; **not** migration-release acceptance

## Implemented boundary

The authenticated REST operation `POST /api/v1/sync/profiles/{id}/remote-backups`
requires a Desktop Host `save-target` File Grant. Runtime loads the existing
provider object, bounds it at 24 MiB, and writes its UTF-8 payload to a
same-directory temporary file opened with mode `0600`. It syncs and atomically
renames that file, cleaning up the temporary file on failure/cancellation. The
result exposes byte count and SHA-256, not a path, token, password or document
body. No remote `save`, decryption, sync-profile state change or preview discard
occurs. The Renderer obtains and revokes the grant and warns that a plaintext
sync backup can contain readable private data.

## Verified here

- `bun run check`: 839 unit tests passed, one skipped; Level 1 architecture,
  262-operation Contract, production build, license/localization gates and
  three visual/accessibility tests passed.
- `bunx playwright test tests/e2e/desktop.spec.ts --grep 'H-09/H-10 setting sync' --project=desktop`:
  one source Electron test passed with a real loopback WebDAV fixture. The save
  dialog grant wrote exactly the remote UTF-8 document and did not mutate it.
- `bunx vitest run packages/runtime/src/application/data-sync-service.test.ts`:
  eleven tests passed. Besides cancellation, grant, local-write and encrypted
  content cases, one test uses controlled HTTP responses from the actual
  GitHub Gist, Gitee Gist, WebDAV and Custom adapters. Each provider payload
  crosses the same Runtime save-grant boundary byte-for-byte, performs exactly
  one GET and keeps its access secret out of the URL. This is deterministic
  adapter/service coverage; it does not use real provider accounts.
- `bun run --cwd apps/desktop package:dir`: unsigned macOS arm64 app generated.
  `app.asar` SHA-256:
  `39b14c4f0394285f8e159d8cfedb811cff383412138df2c98957f38dff25a225`.
- `bunx playwright test --project=packaged`: 14 passed, nine conditional
  skips. The packaged migration test copies the app outside the source checkout,
  uses a real loopback WebDAV GET and Host save dialog, verifies the saved
  encrypted-marker document and displayed SHA-256, and observes zero remote
  writes.

The complete packaged suite and focused migration journey above were both
rerun against this final unsigned directory app after the displayed-hash
assertion was added.

## Byte-preservation revalidation (2026-09-24)

The provider port now has a dedicated read-only byte path for migration backups;
it does not pass the selected object through sync-document decoding. WebDAV and
raw Custom endpoints are streamed with the existing 24 MiB response bound and
their response bytes are written unchanged, including invalid UTF-8. The
ordinary Custom sync loader rejects invalid UTF-8 rather than silently
substituting replacement characters. GitHub/Gitee Gist and named-file Custom
APIs expose the file body as a JSON string, so their backup is the UTF-8
encoding of that provider-returned content field; the API does not expose the
provider's underlying stored byte stream.

Focused verification on 2026-09-24:

- `bunx vitest run packages/runtime/src/adapters/data-sync/http-sync-providers.test.ts packages/runtime/src/application/data-sync-service.test.ts`:
  2 files / 34 tests passed. Regressions prove byte-identical WebDAV and raw
  Custom backups through the provider and Application boundaries, strict
  rejection of invalid UTF-8 by the normal Custom sync loader, response-size
  rejection and SHA-256/byte-count reporting.
- `bun run typecheck`: passed.
- No provider mutation is performed by the backup path. Controlled tests do not
  establish real-account behavior or the provider's internal representation of
  Gist/named-file text.
- A fresh unsigned macOS arm64 directory app was built to an isolated temporary
  output after the change. The packaged migration/WebDAV recovery journey and
  packaged GitHub/Gitee/named-file Custom migration journey passed **2/2**;
  `app.asar` SHA-256:
  `f2b1c15017e32b0cf98a3751966541a10df459435ee99b2627b8f0325b591eee`.
  These packaged cases exercise normal UTF-8 documents and the native save-grant
  UI; the invalid-byte edge itself is verified at provider and Application
  layers. This is unsigned local package evidence, not a signed install or a
  live provider account.
- The final `bun run check` after the code and documentation edits passed **220
  test files** (1,085 passed, 33 skipped), 358 architecture modules / 1,307
  dependencies, 267 Contract operations, the independent-snapshot check, build
  and package-layout gates, nine visual journeys and two accessibility
  journeys.

## GitHub Gist truncation handling (2026-09-24)

GitHub's Gist REST API returns at most 1 MiB of each file in its JSON `content`
field and marks larger API fields as `truncated`; its documentation directs
clients to the file's `raw_url`, and says files above 10 MiB require cloning
the Gist: [official truncation guidance](https://docs.github.com/en/rest/gists/gists#truncation).
The provider previously rejected every truncated file, including while making
a local migration backup, and could report failure after a successful PATCH
whose response was truncated.

The adapter now reads the raw URL only for GitHub Gists and only if it is HTTPS
on `gist.githubusercontent.com`, has the requested Gist ID and filename, and
matches the expected revision path. It sends no API Authorization header,
disables redirects, streams under the 24 MiB cap, and preserves the raw bytes
for backup. Ordinary sync applies strict UTF-8 decoding. If a PATCH response
is truncated, the adapter reports the exact content it just uploaded rather
than treating a successful write as failed. Gitee remains fail-closed when its
response marks content truncated because its raw URL behavior has not been
verified. The documented GitHub >10 MiB Git-clone route is not implemented.

Focused verification on 2026-09-24:

- `bunx vitest run packages/runtime/src/adapters/data-sync/http-sync-providers.test.ts packages/runtime/src/application/data-sync-service.test.ts`:
  2 files / 39 tests passed. New adapter cases cover truncated-file load,
  byte-preserving backup, untrusted host rejection, Gitee fail-closed behavior,
  oversized raw response refusal and successful PATCH responses that return a
  truncated file field. The existing Application-boundary provider matrix now
  exercises GitHub's two-request truncated response through the save File
  Grant, checks the written bytes and SHA-256, and verifies the raw request has
  no Authorization header.
- `bun run typecheck`: passed.
- No live GitHub/Gitee account was used; these are controlled HTTP responses.
  No new packaged-app or cross-platform evidence is claimed for this follow-up.
- The subsequent full `bun run check` passed after the code and documentation
  edits: 220 test files passed, five skipped; 1,090 tests passed, 33 skipped;
  358 architecture modules / 1,307 dependencies; 267 Contract operations;
  production build/package layout and all 11 visual/accessibility journeys.

## Still open

The adapter/service tests do not replace live GitHub, Gitee or custom-provider account evidence; their packaged
backup paths, Windows/Linux packages, installed-app upgrade, old-version
conversion, independent Axterm export/sync formats, public stable migration
release, window duration and later compatibility removal remain unverified. No
remote object is deleted by this change. IR-08 stays In progress; IR-09 stays
Open.
