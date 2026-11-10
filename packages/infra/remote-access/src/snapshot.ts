// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/api/remote-access/src/snapshot.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * The index global carrying a page's first access snapshot, shared by the
 * Host row that writes it and the Client mount that reads it.
 * @module @axterm/infra-remote-access/src/snapshot
 */

/** `globalThis` property an index injection row assigns to the page's opening baseline. */
export const REMOTE_ACCESS_SNAPSHOT_KEY = '__AXTERM_REMOTE_ACCESS__';
