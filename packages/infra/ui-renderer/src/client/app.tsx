// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/ui-renderer/src/client/app.tsx at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * Real-UI assembly closure. The whole layout tree hangs from the built-in
 * `root` slot, which is the only ctx-level slot render in the application.
 */
import type { ReactNode } from 'react';
import type { Context } from '@deepseek-ai/cordis';

/** Inputs available after the UI renderer's inject set activates. */
export interface AssemblyDeps {
  /** Client context carrying the renderer-owned Slot registry. */
  ctx: Context;
}

/**
 * Build the assembled application factory.
 * @param deps - Active UI-renderer dependencies.
 * @returns Factory producing the application React tree.
 */
export function buildRenderApp(deps: AssemblyDeps): () => ReactNode {
  const { ctx } = deps;
  return () => ctx.slots.renderSlot('root', {});
}
