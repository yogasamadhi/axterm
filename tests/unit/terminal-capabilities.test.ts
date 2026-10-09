import { describe, expect, it, vi } from 'vitest';
import type { ITerminalAddon, Terminal } from '@xterm/xterm';
import { DEFAULT_TERMINAL_BEHAVIOR } from '../../packages/contracts/src';
import {
  installTerminalCapabilities,
  TERMINAL_IMAGE_LIMITS,
  type TerminalCapabilityFactories,
} from '../../apps/desktop/src/renderer/src/components/terminal-capabilities';

class TestAddon implements ITerminalAddon {
  activations = 0;
  disposals = 0;

  activate(): void {
    this.activations += 1;
  }

  dispose(): void {
    this.disposals += 1;
  }
}

class TestWebglAddon extends TestAddon {
  listener: (() => void) | undefined;
  subscriptionDisposals = 0;

  onContextLoss(listener: () => void) {
    this.listener = listener;
    return { dispose: () => (this.subscriptionDisposals += 1) };
  }
}

function terminalFixture() {
  const loaded: ITerminalAddon[] = [];
  const refresh = vi.fn();
  const terminal = {
    rows: 24,
    unicode: { activeVersion: '6', versions: ['6', '11'] },
    loadAddon(addon: ITerminalAddon) {
      loaded.push(addon);
      addon.activate(terminal as unknown as Terminal);
    },
    refresh,
  };
  return { terminal, loaded, refresh };
}

function factoriesFixture() {
  const unicode = new TestAddon();
  const ligatures = new TestAddon();
  const images = new TestAddon();
  const webgl = new TestWebglAddon();
  const calls: string[] = [];
  const factories: TerminalCapabilityFactories = {
    unicode11: async () => {
      calls.push('unicode');
      return unicode;
    },
    ligatures: async () => {
      calls.push('ligatures');
      return ligatures;
    },
    images: async () => {
      calls.push('images');
      return images;
    },
    webgl: async () => {
      calls.push('webgl');
      return webgl;
    },
  };
  return { factories, calls, unicode, ligatures, images, webgl };
}

describe('terminal addon capability lifecycle', () => {
  it('loads configured addons in a stable order and disposes every owned resource', async () => {
    const { terminal, loaded } = terminalFixture();
    const fixture = factoriesFixture();
    const controller = installTerminalCapabilities(
      terminal,
      {
        ...DEFAULT_TERMINAL_BEHAVIOR,
        rendererPreference: 'webgl',
        imageSequencesEnabled: true,
      },
      { factories: fixture.factories },
    );

    expect(await controller.ready).toEqual({
      ready: true,
      renderer: 'webgl',
      rendererFallback: false,
      unicodeVersion: '11',
      unicodeFallback: false,
      ligatures: 'active',
      images: 'active',
    });
    expect(fixture.calls).toEqual(['unicode', 'ligatures', 'images', 'webgl']);
    expect(loaded).toEqual([fixture.unicode, fixture.ligatures, fixture.images, fixture.webgl]);
    expect(terminal.unicode.activeVersion).toBe('11');

    controller.dispose();
    controller.dispose();
    expect(fixture.unicode.disposals).toBe(1);
    expect(fixture.ligatures.disposals).toBe(1);
    expect(fixture.images.disposals).toBe(1);
    expect(fixture.webgl.disposals).toBe(1);
    expect(fixture.webgl.subscriptionDisposals).toBe(1);
  });

  it('does not import disabled optional addons and keeps the built-in renderer', async () => {
    const { terminal } = terminalFixture();
    const fixture = factoriesFixture();
    const controller = installTerminalCapabilities(
      terminal,
      {
        ...DEFAULT_TERMINAL_BEHAVIOR,
        unicodeVersion: '6',
        ligaturesEnabled: false,
      },
      { factories: fixture.factories },
    );

    expect(await controller.ready).toMatchObject({
      ready: true,
      renderer: 'dom',
      unicodeVersion: '6',
      ligatures: 'disabled',
      images: 'disabled',
    });
    expect(fixture.calls).toEqual([]);
    controller.dispose();
  });

  it('falls back to safe built-ins and reports each unavailable capability', async () => {
    const { terminal } = terminalFixture();
    const feedback: string[] = [];
    const failure = async () => {
      throw new Error('unsupported');
    };
    const controller = installTerminalCapabilities(
      terminal,
      {
        ...DEFAULT_TERMINAL_BEHAVIOR,
        rendererPreference: 'webgl',
        imageSequencesEnabled: true,
      },
      {
        factories: {
          unicode11: failure,
          ligatures: failure,
          images: failure,
          webgl: failure,
        },
        feedback: (message) => feedback.push(message),
      },
    );

    expect(await controller.ready).toEqual({
      ready: true,
      renderer: 'dom',
      rendererFallback: true,
      unicodeVersion: '6',
      unicodeFallback: true,
      ligatures: 'unavailable',
      images: 'unavailable',
    });
    expect(feedback).toEqual([
      'UNICODE_11_UNAVAILABLE',
      'LIGATURES_UNAVAILABLE',
      'IMAGES_UNAVAILABLE',
      'WEBGL_UNAVAILABLE',
    ]);
  });

  it('disposes a lost WebGL context and deterministically falls back to DOM', async () => {
    const { terminal, refresh } = terminalFixture();
    const fixture = factoriesFixture();
    const feedback: string[] = [];
    const controller = installTerminalCapabilities(
      terminal,
      { ...DEFAULT_TERMINAL_BEHAVIOR, rendererPreference: 'webgl' },
      { factories: fixture.factories, feedback: (message) => feedback.push(message) },
    );
    await controller.ready;

    fixture.webgl.listener?.();
    expect(controller.snapshot()).toMatchObject({
      renderer: 'dom',
      rendererFallback: true,
    });
    expect(fixture.webgl.disposals).toBe(1);
    expect(fixture.webgl.subscriptionDisposals).toBe(1);
    expect(refresh).toHaveBeenCalledWith(0, 23);
    expect(feedback).toEqual(['WEBGL_CONTEXT_LOST']);
    controller.dispose();
    expect(fixture.webgl.disposals).toBe(1);
  });

  it('disposes an addon that resolves after the terminal owner has closed', async () => {
    const { terminal, loaded } = terminalFixture();
    const lateAddon = new TestAddon();
    let resolveAddon: ((addon: ITerminalAddon) => void) | undefined;
    const controller = installTerminalCapabilities(terminal, DEFAULT_TERMINAL_BEHAVIOR, {
      factories: {
        ...factoriesFixture().factories,
        unicode11: () =>
          new Promise<ITerminalAddon>((resolve) => {
            resolveAddon = resolve;
          }),
      },
    });
    controller.dispose();
    resolveAddon?.(lateAddon);
    await controller.ready;

    expect(loaded).toEqual([]);
    expect(lateAddon.disposals).toBe(1);
  });

  it('keeps image decoding, retained RGBA data and input sequences explicitly bounded', () => {
    expect(TERMINAL_IMAGE_LIMITS).toMatchObject({
      pixelLimit: 4_194_304,
      storageLimit: 32,
      sixelSizeLimit: 4_194_304,
      iipSizeLimit: 4_194_304,
      sixelPaletteLimit: 256,
    });
    expect(TERMINAL_IMAGE_LIMITS.pixelLimit * 4).toBe(16 * 1024 * 1024);
  });
});
