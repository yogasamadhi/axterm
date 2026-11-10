# @axterm/plugin-market

Private Host Controller, generated Remote and Client model for Profile market
indexes. UI is composed through the workspace toolbar Slot and public controls.
Defaults contain no public index URL and make no index request.

Indexes use format 1: title, plugins (name, optional localized title/description),
and versions (exact SemVer, publishTimestamp, source, optional engines.axterm).
An npm source accepts an optional HTTP(S) registry. Git source metadata is displayed
with an unsupported install action. Index text is advisory data, never HTML or
execution authority. The actual package manager checks package compatibility.

Configuration has revision preconditions and durable idempotent receipts. Reads
reject redirects and URL credentials, query and fragments. Limits are eight sources,
four concurrent reads, 2 MiB per document, 512 entries, 32 versions, 15 seconds,
ten-minute cache and 1 MiB per reply. Pagination pins one cached document; replacement
requires a fresh search. Caller cancellation and unload join actual body cleanup.

Install requires explicit trust and uses the existing plugin command owner and
embedded pnpm. Build approval is separate. Recovery excludes this Bundle.
