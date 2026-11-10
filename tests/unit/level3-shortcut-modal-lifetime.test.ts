// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import {
  lastActiveShortcutModal,
  modalSelector,
} from '../../packages/infra/shortcuts/src/client/primitives.ts';
afterEach(() => {
  document.body.replaceChildren();
});
it('keeps the live top modal and excludes closed portals, hidden panes and stale cached nodes', () => {
  document.body.innerHTML =
    '<div role="dialog" aria-modal="true" id="live"></div><div role="menu" data-state="closed"></div><section hidden><div role="menu"></div></section>';
  const cached = document.querySelectorAll<HTMLElement>(modalSelector);
  expect(lastActiveShortcutModal(cached)?.id).toBe('live');
  document.getElementById('live')!.remove();
  expect(lastActiveShortcutModal(cached)).toBeUndefined();
  document.body.innerHTML =
    '<div aria-hidden="true"><div role="menu"></div></div><div inert><div role="menu"></div></div><div role="menu" id="open"></div>';
  expect(lastActiveShortcutModal(document.querySelectorAll<HTMLElement>(modalSelector))?.id).toBe(
    'open',
  );
});
