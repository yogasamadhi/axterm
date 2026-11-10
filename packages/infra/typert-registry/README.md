# @axterm/infra-typert-registry

Private provider for the public SDK's `ctx.typert` contract. Host and Client entries
share the same Cordis-owned registry implementation. It indexes generated schemas,
reflection metadata, local/Remote descriptors, lookups, scope adapters and resource
kinds. Public contract definitions live in `@axterm/plugin-api` only.

Registration validates a whole contribution before committing it. Every contribution,
provider, configured resolver and observer belongs to its registering fiber and has
a disposer paired to both the caller and provider lifetimes. Provider unload drains
root-owned entries and rejects cached registration views. Duplicate ownership fails; stale/repeated disposal cannot withdraw a
later owner. Observer errors are contained without logging thrown values.

Host and Client are checked separately; the browser face has no ambient Node types.
The base Bundle includes this implemented provider. Automatic artifact loading,
Remote dispatch and the rest of the product still have separate migration work.
