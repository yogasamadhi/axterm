# @axterm/remote-generator

Source-first Remote reflection, codecs and declarations adapted from the pinned
DSH compiler. Generated artifacts import the canonical `@axterm/plugin-api` SDK.
The compiler runtime uses TypeScript 6.0.3; the application checker remains 5.9.3.

Use `WorkspaceTypertGenerator(root).generateContributors()` followed by
`writeWorkspaceArtifacts(root, artifacts)`, or `typertPlugin()` from the `./tsdown`
entry. The workspace has separate `tsconfig.host.json` / `tsconfig.client.json`
aggregates referencing package face projects. Map workspace imports to source.
The generator rejects compiled workspace dependencies by default, including in its
workspace worker. Published SDK declarations outside the workspace are supported.

A contributing package explicitly exports `./typert` (or `./client/typert`), lists
the corresponding `lib/typert.<face>.js` and `.d.ts` files, and exports `./remote`
with `lib/typert.remote-client.js` / `.d.ts` when it owns Remote methods. Import that
Remote subpath into the Client program to activate its typed namespaces. Keep the
SDK/Cordis peers external and declare `zod` 4.4.3 as a direct dependency of packages
whose generated codecs import it; a transitive dependency is insufficient under
pnpm. Host objects use SDK lookup declarations and resolve only in the Host.

The package includes executable worker code, declarations, provenance and MIT
license. Source-only development of the tsdown plugin uses its declared tsx dev
dependency; the installed package runs emitted JavaScript without a TS loader.
No application business implementation is public. This tool does not complete M6
or replace the current product entry; no public publication is performed here.
