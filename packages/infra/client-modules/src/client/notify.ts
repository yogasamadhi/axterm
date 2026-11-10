// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/modules/src/client/notify.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** Subscriber notification for the page controller's observable sources. */

/**
 * Call every subscriber; one throwing subscriber must not skip the rest.
 * @param listeners - current subscribers; copied before dispatch.
 * @param label - diagnostic owner named in the error log.
 */
export function notifySubscribers(listeners: ReadonlySet<() => void>, label: string): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // The page controller has no owning plugin Context for a scoped logger.
      console.error(`client-modules: ${label} subscriber failed`);
    }
  }
}
