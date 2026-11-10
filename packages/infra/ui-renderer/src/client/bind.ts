// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- Include the shim declaration in both source-first and independent Client programs.
/// <reference path="./use-sync-external-store.d.ts" />
// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/ui-renderer/src/client/bind.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * uSES bridge: turns any bare observable snapshot source into a typed
 * selector hook. Client-side-rendered only, so no server snapshot is wired.
 * This is the ONE hook constructor in the client stack — engines and hosts
 * traffic in bare sources; binding happens on the React side.
 */
// Use the explicit ESM subpath covered by the package-owned shim declaration.
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector.js';
import type { HostObservable, SnapshotSelectorHook } from '@axterm/ui';

/**
 * Bind a bare observable source to a typed uSES selector hook.
 * subscribe/getSnapshot are captured once per source into stable closures
 * (also re-binds `this` for method-based sources), so components never
 * resubscribe across renders. Equality defaults to Object.is.
 * @param w - snapshot source (engine store, Session object, store instance).
 * @returns the selector hook.
 */
export function bindSnapshotSelector<T>(w: HostObservable<T>): SnapshotSelectorHook<T> {
  const subscribe = (fn: () => void) => w.subscribe(fn);
  const getSnapshot = () => w.getSnapshot();
  return function useSelector<S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean): S {
    return useSyncExternalStoreWithSelector(subscribe, getSnapshot, undefined, sel, eq);
  };
}
