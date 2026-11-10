// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/ui-renderer/src/client/use-sync-external-store.d.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * Local typings for use-sync-external-store: the runtime package ships no
 * types. Mirrors the shim's with-selector build (the only entry this package
 * consumes).
 */
declare module 'use-sync-external-store/shim/with-selector.js' {
  export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => Snapshot,
    getServerSnapshot: undefined | null | (() => Snapshot),
    selector: (snapshot: Snapshot) => Selection,
    isEqual?: (a: Selection, b: Selection) => boolean,
  ): Selection;
}
