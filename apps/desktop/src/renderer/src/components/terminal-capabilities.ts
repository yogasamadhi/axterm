import type { ITerminalAddon } from '@xterm/xterm';
import type { TerminalBehavior } from '@workspace/contracts';

interface Disposable {
  dispose(): void;
}

interface WebglAddonLike extends ITerminalAddon {
  onContextLoss(listener: () => void): Disposable;
}

interface CapabilityTerminal {
  readonly rows: number;
  readonly unicode: { activeVersion: string };
  loadAddon(addon: ITerminalAddon): void;
  refresh(start: number, end: number): void;
}

export interface TerminalCapabilityFactories {
  unicode11(): Promise<ITerminalAddon>;
  ligatures(): Promise<ITerminalAddon>;
  images(): Promise<ITerminalAddon>;
  webgl(): Promise<WebglAddonLike>;
}

export interface TerminalCapabilityState {
  ready: boolean;
  renderer: 'dom' | 'webgl';
  rendererFallback: boolean;
  unicodeVersion: '6' | '11';
  unicodeFallback: boolean;
  ligatures: 'disabled' | 'loading' | 'active' | 'unavailable';
  images: 'disabled' | 'loading' | 'active' | 'unavailable';
}

export interface TerminalCapabilityController extends Disposable {
  readonly ready: Promise<TerminalCapabilityState>;
  snapshot(): TerminalCapabilityState;
}

export type TerminalCapabilityFeedbackCode =
  | 'WEBGL_CONTEXT_LOST'
  | 'WEBGL_UNAVAILABLE'
  | 'UNICODE_11_UNAVAILABLE'
  | 'LIGATURES_UNAVAILABLE'
  | 'IMAGES_UNAVAILABLE';

/**
 * Fixed per-terminal limits. The image addon accounts decoded storage as RGBA pixels, so this
 * caps one decoded image at 16 MiB, retained images at 32 MiB and either escape payload at 4 MiB.
 */
export const TERMINAL_IMAGE_LIMITS = Object.freeze({
  enableSizeReports: false,
  pixelLimit: 4_194_304,
  storageLimit: 32,
  showPlaceholder: true,
  sixelSupport: true,
  sixelScrolling: true,
  sixelPaletteLimit: 256,
  sixelSizeLimit: 4_194_304,
  iipSupport: true,
  iipSizeLimit: 4_194_304,
});

const DEFAULT_FACTORIES: TerminalCapabilityFactories = {
  async unicode11() {
    const { Unicode11Addon } = await import('@xterm/addon-unicode11');
    return new Unicode11Addon();
  },
  async ligatures() {
    // 0.10.0 publishes only its ESM artifact while its package `main` still names a missing CJS file.
    const { LigaturesAddon } = await import('@xterm/addon-ligatures/lib/addon-ligatures.mjs');
    return new LigaturesAddon();
  },
  async images() {
    const { ImageAddon } = await import('@xterm/addon-image');
    return new ImageAddon(TERMINAL_IMAGE_LIMITS);
  },
  async webgl() {
    const { WebglAddon } = await import('@xterm/addon-webgl');
    return new WebglAddon();
  },
};

export function installTerminalCapabilities(
  terminal: CapabilityTerminal,
  behavior: TerminalBehavior,
  options: {
    factories?: TerminalCapabilityFactories;
    feedback?(code: TerminalCapabilityFeedbackCode): void;
    onState?(state: TerminalCapabilityState): void;
  } = {},
): TerminalCapabilityController {
  const factories = options.factories ?? DEFAULT_FACTORIES;
  const addons = new Set<ITerminalAddon>();
  let contextLossSubscription: Disposable | undefined;
  let webglAddon: WebglAddonLike | undefined;
  let disposed = false;
  const state: TerminalCapabilityState = {
    ready: false,
    renderer: 'dom',
    rendererFallback: false,
    unicodeVersion: '6',
    unicodeFallback: false,
    ligatures: behavior.ligaturesEnabled ? 'loading' : 'disabled',
    images: behavior.imageSequencesEnabled ? 'loading' : 'disabled',
  };

  const snapshot = () => ({ ...state });
  const emit = () => {
    if (!disposed)
      try {
        options.onState?.(snapshot());
      } catch {
        // A UI observer cannot own or interrupt the addon lifecycle.
      }
  };
  const feedback = (code: TerminalCapabilityFeedbackCode) => {
    if (!disposed)
      try {
        options.feedback?.(code);
      } catch {
        // Feedback is best effort; addon cleanup and fallback still have to run.
      }
  };
  const disposeSafely = (resource: Disposable | undefined) => {
    try {
      resource?.dispose();
    } catch {
      // Continue releasing the remaining terminal-owned resources.
    }
  };
  const disposeAddon = (addon: ITerminalAddon | undefined) => {
    if (!addon) return;
    addons.delete(addon);
    disposeSafely(addon);
  };
  const activate = async (factory: () => Promise<ITerminalAddon>) => {
    let addon: ITerminalAddon | undefined;
    try {
      addon = await factory();
      if (disposed) {
        disposeAddon(addon);
        return undefined;
      }
      terminal.loadAddon(addon);
      if (disposed) {
        disposeAddon(addon);
        return undefined;
      }
      addons.add(addon);
      return addon;
    } catch {
      disposeAddon(addon);
      return undefined;
    }
  };
  const fallBackFromWebgl = (reason: 'initialization' | 'context-loss') => {
    if (disposed || (!webglAddon && state.rendererFallback)) return;
    disposeSafely(contextLossSubscription);
    contextLossSubscription = undefined;
    disposeAddon(webglAddon);
    webglAddon = undefined;
    state.renderer = 'dom';
    state.rendererFallback = true;
    emit();
    feedback(reason === 'context-loss' ? 'WEBGL_CONTEXT_LOST' : 'WEBGL_UNAVAILABLE');
    try {
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
    } catch {
      // A terminal may already be closing while the browser reports context loss.
    }
  };

  emit();
  const ready = (async () => {
    if (behavior.unicodeVersion === '11') {
      const addon = await activate(factories.unicode11);
      if (!disposed && addon) {
        try {
          terminal.unicode.activeVersion = '11';
          state.unicodeVersion = '11';
        } catch {
          state.unicodeFallback = true;
          try {
            terminal.unicode.activeVersion = '6';
          } catch {
            // Keep xterm's built-in provider when an implementation rejects explicit selection.
          }
          disposeAddon(addon);
          feedback('UNICODE_11_UNAVAILABLE');
        }
      } else if (!disposed) {
        state.unicodeFallback = true;
        feedback('UNICODE_11_UNAVAILABLE');
      }
      emit();
    } else {
      try {
        terminal.unicode.activeVersion = '6';
      } catch {
        // Unicode 6 is xterm's built-in width provider; retain the state if a test double omits it.
      }
      emit();
    }

    if (behavior.ligaturesEnabled && !disposed) {
      const addon = await activate(factories.ligatures);
      if (!disposed) {
        state.ligatures = addon ? 'active' : 'unavailable';
        if (!addon) feedback('LIGATURES_UNAVAILABLE');
        emit();
      }
    }

    if (behavior.imageSequencesEnabled && !disposed) {
      const addon = await activate(factories.images);
      if (!disposed) {
        state.images = addon ? 'active' : 'unavailable';
        if (!addon) feedback('IMAGES_UNAVAILABLE');
        emit();
      }
    }

    if (behavior.rendererPreference === 'webgl' && !disposed) {
      let addon: WebglAddonLike | undefined;
      try {
        addon = await factories.webgl();
        if (disposed) {
          disposeAddon(addon);
          return snapshot();
        }
        webglAddon = addon;
        contextLossSubscription = addon.onContextLoss(() => fallBackFromWebgl('context-loss'));
        terminal.loadAddon(addon);
        if (disposed) {
          disposeSafely(contextLossSubscription);
          contextLossSubscription = undefined;
          disposeAddon(addon);
          webglAddon = undefined;
          return snapshot();
        }
        if (webglAddon === addon) {
          addons.add(addon);
          state.renderer = 'webgl';
        } else {
          disposeAddon(addon);
        }
      } catch {
        if (addon) {
          disposeSafely(contextLossSubscription);
          contextLossSubscription = undefined;
          disposeAddon(addon);
          webglAddon = undefined;
        }
        fallBackFromWebgl('initialization');
      }
      emit();
    }

    if (!disposed) {
      state.ready = true;
      emit();
    }
    return snapshot();
  })();

  return {
    ready,
    snapshot,
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeSafely(contextLossSubscription);
      contextLossSubscription = undefined;
      webglAddon = undefined;
      for (const addon of [...addons].reverse()) disposeAddon(addon);
    },
  };
}
