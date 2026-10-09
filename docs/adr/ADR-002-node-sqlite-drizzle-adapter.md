# ADR-002: Stable Drizzle adapter for node:sqlite

Status: Accepted
Date: 2026-09-10

## Context

The Runtime must use SQLite through Node's built-in `node:sqlite` module and keep
Drizzle as the schema/query layer. Drizzle 0.45.2 is the current stable release,
but it does not export the newer `drizzle-orm/node-sqlite` entry described by the
development documentation. It does export the supported `sqlite-proxy` callback
adapter.

## Decision

Use `node:sqlite` as the authoritative connection and migration executor. Define
the product schema with Drizzle and expose a `sqlite-proxy` Drizzle instance backed
by the same `DatabaseSync` connection. Repository classes own all SQL access and
transactions; Domain and Application code never import either library.

Migrations are forward-only, checksum protected, preceded by an integrity check,
and retain the database on failure. Business mutations and their domain events
commit in the same SQLite transaction.

## Consequences

The Runtime remains portable between Electron's embedded Node and the standalone
Node entry without native SQLite dependencies. The proxy is in-process and never
opens an HTTP listener. Repository integration tests exercise the real database.

## Alternatives considered

- Use an unpublished Drizzle adapter export: rejected because installs would not
  be reproducible from a stable package.
- Use a native SQLite addon: rejected because `node:sqlite` is the required
  baseline and an additional native ABI would complicate packaging.

## Migration / rollback

When a stable Drizzle release exports `node-sqlite`, replace only the adapter in a
dedicated change. Keep the repository interfaces and migration files unchanged,
then rerun persistence, headless and packaged tests.
