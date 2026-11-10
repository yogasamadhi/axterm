// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/ui-renderer/src/client/index.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * Browser UI renderer. It installs the slot renderer after its Cordis
 * dependencies activate and exposes the mount operation used by the web boot
 * kernel after the complete client roster settles.
 */
import { createElement, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { controlsCssText } from '@axterm/ui/controls';
import type { Context } from '@deepseek-ai/cordis';
import { createSlotRenderer } from './scoped-slots.tsx';
import { buildRenderApp } from './app.tsx';
import { SlotRegistry } from './registry.ts';

export { SlotRegistry } from './registry.ts';
export type { RootOwnerProps } from './registry.ts';

export type {
  ChainRenderOpts,
  HostObservable,
  RenderOpts,
  SnapshotSelectorHook,
  SlotRenderer,
  ScopedStandardSourceBinding,
  SlotRendererHost,
  SlotScopeAdapter,
  StandardSourceBinding,
  StoreInstanceLike,
} from '@axterm/ui';

/** Mount operation exposed to the framework-free boot kernel. */
export interface UiRendererService {
  /**
   * Mount the assembled application into the supplied element.
   * @param container - Application mount point.
   * @returns Disposer that unmounts the React root.
   */
  mount: (container: HTMLElement) => () => void;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Mount face provided after the UI renderer activates. */
    uiRenderer: UiRendererService;
  }
}

/** Services required before application assembly. */
export const inject: string[] = [];

interface BootSnapshot {
  className: string;
  html: string;
}

const noBootSubscription = () => () => {};
const clientReady = () => true;
const serverBoot = () => false;

/** Hydrate the kernel-owned loading DOM before replacing it with the application. */
function BootHandoff(props: { app: () => ReactNode; boot: BootSnapshot }): ReactNode {
  // React hydrates the server snapshot first, then switches to the committed client snapshot.
  const ready = useSyncExternalStore(noBootSubscription, clientReady, serverBoot);
  if (ready) return props.app();
  return createElement('div', {
    className: props.boot.className,
    'data-axterm-boot': '',
    dangerouslySetInnerHTML: { __html: props.boot.html },
  });
}

/** Mount React while preserving the framework-free boot DOM through hydration. */
function mountApp(container: HTMLElement, app: () => ReactNode): Root {
  const boot = container.querySelector<HTMLElement>(':scope > [data-axterm-boot]');
  if (boot !== null) {
    return hydrateRoot(
      container,
      createElement(BootHandoff, {
        app,
        boot: { className: boot.className, html: boot.innerHTML },
      }),
    );
  }
  const root = createRoot(container);
  flushSync(() => {
    root.render(app());
  });
  return root;
}

/**
 * Install the slot renderer and provide the application mount face.
 * @param ctx - Plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {};
    const style = document.createElement('style');
    style.dataset.plugin = '@axterm/ui';
    style.textContent = controlsCssText;
    document.head.append(style);
    return () => style.remove();
  });
  const slots = new SlotRegistry(ctx);
  slots.install(createSlotRenderer());
  ctx.reflect.provide('uiRenderer', {
    mount: (container: HTMLElement): (() => void) => {
      const root = mountApp(container, buildRenderApp({ ctx }));
      return () => {
        root.unmount();
      };
    },
  });
}
