// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/web/src/mount.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * Application mount through a dependency fiber, so replacing `uiRenderer`
 * remounts the application. Shared by `AppWebEntry` and the test carrier.
 * @module @axterm/web/src/mount
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@axterm/infra-ui-renderer/client';

/**
 * Mount the UI renderer into `container` through a dependency fiber on
 * `uiRenderer`: the mount effect installs when the service is provided and
 * reinstalls when it is replaced.
 * @param ctx - booted root Context.
 * @param container - application mount point.
 * @returns resolves once the dependency fiber exists; with `uiRenderer`
 * already provided (as after `bootClient`) the mount effect is installed by
 * then, otherwise it installs when the service arrives.
 */
export async function mountClient(ctx: Context, container: HTMLElement): Promise<void> {
  const mounted = ctx.inject(['uiRenderer'], (scope) => {
    scope.effect(() => scope.uiRenderer.mount(container), 'web boot: application mount');
  });
  await mounted;
}
