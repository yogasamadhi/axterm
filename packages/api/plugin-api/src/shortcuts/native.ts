import type { ShortcutDefinition } from './configuration.ts';
import type { ShortcutConfigSnapshot } from './persistence.ts';
// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/shortcuts/src/native.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** Trusted product-window input exchanged with Electron's top-frame preload. */
import type { ShortcutRevision } from './persistence.ts';
import type { ShortcutCommandId } from './binding.ts';

/** Native input carries the accepted configuration identity; frame names identify the focused iframe or browser guest embedding element. */
export type DesktopShortcutInput = {
  readonly revision: ShortcutRevision;
} & (
  | { readonly kind: 'menu'; readonly commandId: ShortcutCommandId }
  | {
      readonly kind: 'keyboard' | 'iframe' | 'webview';
      readonly frameName: string;
      readonly code: string;
      readonly secondCode?: string;
      readonly control: boolean;
      readonly alt: boolean;
      readonly shift: boolean;
      readonly meta: boolean;
      readonly repeat: boolean;
    }
);

/** Window-scoped capabilities exposed only to the product main frame. */
export interface DesktopKeyboardApi {
  /** Subscribe to verified native input. @param listener - current document consumer. @returns listener disposer. */
  subscribe(listener: (input: DesktopShortcutInput) => void): () => void;
  /**
   * Close the owning window if its configuration is still current.
   * @param revision - accepted configuration identity.
   * @returns IPC completion.
   */
  closeWindow(revision: ShortcutRevision): Promise<void>;
}

/** Axterm shell owns only transient native routing; durable preferences remain in Host storage. */
export interface AxtermKeyboardApi extends DesktopKeyboardApi {
  configure(
    generation: string,
    definitions: readonly ShortcutDefinition[],
    snapshot: ShortcutConfigSnapshot,
  ): Promise<void>;
  recording(active: boolean): Promise<void>;
  clear(): Promise<void>;
  windowAction(generation: string, action: NativeWindowAction): Promise<void>;
  windowState(generation: string): Promise<DesktopWindowPresentationState>;
}
export type NativeWindowAction = 'fullscreen' | 'minimize' | 'toggle-maximize';
/** Transient native presentation only, matching the frozen capability state. */
export interface DesktopWindowPresentationState {
  readonly minimized: boolean;
  readonly maximized: boolean;
  readonly fullScreen: boolean;
  readonly focused: boolean;
  readonly visible: boolean;
  readonly canMinimize: boolean;
  readonly canMaximize: boolean;
  readonly canClose: boolean;
}

export type AxtermKeyboardRequest =
  | {
      type: 'configure';
      generation: string;
      definitions: readonly ShortcutDefinition[];
      snapshot: ShortcutConfigSnapshot;
    }
  | { type: 'recording'; active: boolean }
  | { type: 'close'; revision: ShortcutRevision }
  | { type: 'clear' }
  | { type: 'window'; generation: string; action: NativeWindowAction }
  | { type: 'window-state'; generation: string };
