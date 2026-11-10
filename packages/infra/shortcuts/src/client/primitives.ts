// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/ui-primitives/src/keyboard-composition.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** Composition lifetime for local keyboard handlers, including a late closing keydown. */

/**
 * Observe composition until its closing key is released or consumed.
 * @param document - document whose input events belong to the caller.
 * @returns an event guard and a disposer for all listeners.
 */
export function observeComposition(document: Document): {
  guards(event: KeyboardEvent): boolean;
  dispose(): void;
} {
  let composing = false;
  let ended = false;
  const start = (): void => {
    composing = true;
  };
  const end = (): void => {
    composing = false;
    ended = true;
  };
  const release = (): void => {
    ended = false;
  };
  const blur = (): void => {
    composing = false;
    ended = false;
  };
  document.addEventListener('compositionstart', start, true);
  document.addEventListener('compositionend', end, true);
  document.addEventListener('keyup', release, true);
  document.defaultView?.addEventListener('blur', blur);
  return {
    guards: (event) => {
      // oxlint-disable-next-line typescript/no-deprecated -- IME 229 covers engines without isComposing.
      const guarded = composing || ended || event.isComposing || event.keyCode === 229;
      ended = false;
      return guarded;
    },
    dispose: () => {
      document.removeEventListener('compositionstart', start, true);
      document.removeEventListener('compositionend', end, true);
      document.removeEventListener('keyup', release, true);
      document.defaultView?.removeEventListener('blur', blur);
    },
  };
}

export const modalSelector = '[role="dialog"][aria-modal="true"], [role="menu"]';

/** Ignore closing or detached controls retained by portals/inactive panes. */
export function lastActiveShortcutModal(nodes: Iterable<HTMLElement>): HTMLElement | undefined {
  return [...nodes].findLast(
    (node) =>
      node.isConnected &&
      node.dataset.state !== 'closed' &&
      !node.closest('[hidden], [inert], [aria-hidden="true"]'),
  );
}
