// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/core/scope/src/index.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * Scoped-context primitive: mint a Cordis context that tags registrations with
 * an opaque identity and build routing-only event carriers for that identity.
 *
 * @module @axterm/infra-scope
 */

export * from './scope.ts';
export { AnonymousEntries, NamedEntries, ScopedLayers } from './store.ts';
export type { ScopeLayer } from './store.ts';
