// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/ui-renderer/tests/ui-renderer.client.spec.tsx at 8bd073392eef6f54e921a093b95076248eb08cbb.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { Context } from '@deepseek-ai/cordis';
import type { SlotRegistry } from '../src/client/registry.ts';
import type { SlotScopeAdapter, StandardSourceBinding } from '../src/client/index.ts';
import { apply as nodeApply } from '@axterm/infra-ui-renderer';
import * as UiRenderer from '../src/client/index.ts';

const mounted: (() => void)[] = [];

afterEach(() => {
  act(() => {
    for (const unmount of mounted.splice(0)) unmount();
  });
  vi.restoreAllMocks();
  cleanup();
  document.body.innerHTML = '';
});

const stabilize = async (fn: () => void | Promise<void>): Promise<void> => {
  await act(async () => {
    await fn();
  });
};

async function bench() {
  const ctx = new Context();
  const fiber = ctx.plugin({ inject: [...UiRenderer.inject], apply: UiRenderer.apply });
  await fiber.await();
  const slots = ctx.get('slots') as SlotRegistry;
  const absentBinding: StandardSourceBinding = {
    key: undefined,
    hooks: {},
    keyedHooks: {},
    props: {},
  };
  const current = {
    getSnapshot: () => absentBinding,
    subscribe: () => () => {},
  };
  const adapter: SlotScopeAdapter = {
    current,
    bindingSource: () => current,
  };
  slots.installScope('session', adapter);
  return { ctx, slots, fiber };
}

function container(): HTMLElement {
  const el = document.createElement('div');
  document.body.append(el);
  return el;
}

describe('UI renderer plugin', () => {
  it('owns one shared controls stylesheet and removes it on unload and reload', async () => {
    const selector = 'style[data-plugin="@axterm/ui"]';
    const before = document.head.querySelectorAll(selector).length;
    const ctx = new Context();
    const first = ctx.plugin(UiRenderer);
    await first;
    expect(document.head.querySelectorAll(selector).length).toBe(before + 1);
    expect(document.head.querySelector(selector)?.textContent).toContain('--ax-color-primary');
    await first.dispose();
    expect(document.head.querySelectorAll(selector).length).toBe(before);
    const second = ctx.plugin(UiRenderer);
    await second;
    expect(document.head.querySelectorAll(selector).length).toBe(before + 1);
    await ctx.fiber.dispose();
    expect(document.head.querySelectorAll(selector).length).toBe(before);
  });

  it('mounts a root-only application without a Session scope adapter', async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(UiRenderer);
    await fiber;
    ctx.slots.register({ name: 'root' }, () => <main data-testid="neutral-root" />);
    const el = container();
    let stop: (() => void) | undefined;
    try {
      act(() => {
        stop = ctx.uiRenderer.mount(el);
      });
      expect(el.querySelector('[data-testid="neutral-root"]')).not.toBeNull();
    } finally {
      act(() => {
        stop?.();
      });
      await ctx.fiber.dispose();
    }
  });

  it('provides no host-side behavior', () => {
    expect(() => {
      nodeApply();
    }).not.toThrow();
  });

  it('installs the renderer and mounts the assembled application', async () => {
    const { ctx, slots } = await bench();
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />);
    const renderer = ctx.get('uiRenderer');
    expect(renderer).toBeDefined();
    const el = container();
    act(() => {
      mounted.push(renderer!.mount(el));
    });
    expect(el.querySelector('[data-testid="root-probe"]')).toBeTruthy();
  });

  it('hydrates the boot page before switching to the assembled application', async () => {
    const { ctx, slots } = await bench();
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />);
    const el = container();
    el.innerHTML =
      '<div class="boot" data-axterm-boot=""><div><div class="spinner" data-axterm-boot-spinner="" style="--axterm-boot-arc: 180deg"></div><div>Loading plugins…</div></div></div>';
    const boot = el.firstElementChild;
    const observer = new MutationObserver(() => {});
    observer.observe(el, { childList: true, subtree: true });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    act(() => {
      mounted.push(ctx.get('uiRenderer')!.mount(el));
    });

    const records = observer.takeRecords();
    observer.disconnect();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
    expect(el.querySelector('[data-testid="root-probe"]')).toBeTruthy();
    expect(records.some((record) => record.target === boot)).toBe(false);
  });

  it('returns an unmount disposer', async () => {
    const { ctx, slots } = await bench();
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />);
    const el = container();
    let unmount: () => void = () => {};
    act(() => {
      unmount = ctx.get('uiRenderer')!.mount(el);
    });
    act(() => {
      unmount();
    });
    expect(el.querySelector('[data-testid="root-probe"]')).toBeNull();
  });

  it('retracts the service and renderer with its fiber', async () => {
    const { ctx, slots, fiber } = await bench();
    await stabilize(() => fiber.dispose());
    expect(ctx.get('uiRenderer')).toBeUndefined();
    expect(() => slots.renderSlot('root', {})).toThrow('not installed');
  });
});
