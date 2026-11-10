import type { Page } from '@playwright/test';
interface FaultHarness {
  set(endpoint: string, enabled: boolean, canary: string): void;
  opens(endpoint: string): number;
}
/** Failure injection touches only selected control frames on a real authenticated socket. */
export async function installLevel3StreamFaults(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const root = globalThis as typeof globalThis & { __axtermTestStreamFaults?: FaultHarness };
    if (root.__axtermTestStreamFaults) return;
    const Native = globalThis.WebSocket;
    const rules = new Map<string, { enabled: boolean; canary: string }>(),
      counts = new Map<string, number>(),
      sockets = new Set<ControlledSocket>();
    class ControlledSocket extends Native {
      readonly entries = new Map<string, string>();
      readonly blocked = new Set<string>();
      private injecting = false;
      private readonly mux: boolean;
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.mux = new URL(String(url), location.href).pathname === '/api/remote.mux';
        if (!this.mux) return;
        if (sockets.size >= 32) {
          super.close();
          throw Error('Test stream socket capacity');
        }
        sockets.add(this);
        super.addEventListener(
          'close',
          () => {
            sockets.delete(this);
            this.entries.clear();
            this.blocked.clear();
          },
          { once: true },
        );
        super.addEventListener('message', (event) => {
          if (this.injecting || typeof event.data !== 'string') return;
          let frame: { type?: string; streamId?: string };
          try {
            frame = JSON.parse(event.data) as typeof frame;
          } catch {
            return;
          }
          const id = frame.streamId;
          if (!id) return;
          if (this.blocked.has(id)) {
            event.stopImmediatePropagation();
            if (frame.type === 'end' || frame.type === 'error') this.blocked.delete(id);
            return;
          }
          if (frame.type === 'end' || frame.type === 'error') this.entries.delete(id);
        });
      }
      override send(data: Parameters<WebSocket['send']>[0]): void {
        let opened: string | undefined;
        if (this.mux && typeof data === 'string') {
          let frame: { type?: string; streamId?: string; endpoint?: string };
          try {
            frame = JSON.parse(data) as typeof frame;
          } catch {
            super.send(data);
            return;
          }
          if (frame.type === 'open' && frame.streamId && frame.endpoint) {
            if (this.entries.size >= 64) throw Error('Test stream fixture capacity');
            if (counts.size >= 128 && !counts.has(frame.endpoint))
              throw Error('Test stream endpoint capacity');
            this.entries.set(frame.streamId, frame.endpoint);
            counts.set(frame.endpoint, (counts.get(frame.endpoint) ?? 0) + 1);
            opened = frame.streamId;
          } else if (frame.type === 'cancel' && frame.streamId) this.entries.delete(frame.streamId);
        }
        super.send(data);
        if (opened) this.fail(opened);
      }
      fail(id: string): void {
        const endpoint = this.entries.get(id),
          rule = endpoint ? rules.get(endpoint) : undefined;
        if (!rule?.enabled || this.readyState !== Native.OPEN) return;
        if (this.blocked.size >= 64) throw Error('Test stream failure fixture capacity');
        this.entries.delete(id);
        this.blocked.add(id);
        super.send(JSON.stringify({ type: 'cancel', streamId: id }));
        this.injecting = true;
        try {
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'error',
                streamId: id,
                error: {
                  code: 'fixture/observation-failure',
                  message: rule.canary,
                  details: { reason: 'unavailable', canary: rule.canary },
                },
              }),
            }),
          );
        } finally {
          this.injecting = false;
        }
      }
    }
    globalThis.WebSocket = ControlledSocket;
    root.__axtermTestStreamFaults = {
      set(endpoint, enabled, canary) {
        if (
          !/^[A-Za-z][A-Za-z0-9]*\/[A-Za-z][A-Za-z0-9]*$/u.test(endpoint) ||
          (rules.size >= 32 && !rules.has(endpoint))
        )
          throw Error('Invalid test observation endpoint');
        rules.set(endpoint, { enabled, canary });
        if (enabled)
          for (const socket of sockets)
            for (const [id, current] of socket.entries) if (current === endpoint) socket.fail(id);
      },
      opens(endpoint) {
        return counts.get(endpoint) ?? 0;
      },
    };
  });
  await page.reload();
  await page.locator('[data-workspace-presentation=ready]').waitFor();
}
export async function setLevel3StreamFault(
  page: Page,
  endpoint: string,
  enabled: boolean,
  canary: string,
): Promise<void> {
  await page.evaluate(
    ({ endpoint, enabled, canary }) => {
      const harness = (
        globalThis as typeof globalThis & { __axtermTestStreamFaults?: FaultHarness }
      ).__axtermTestStreamFaults;
      if (!harness) throw Error('Observation fault fixture was not installed');
      harness.set(endpoint, enabled, canary);
    },
    { endpoint, enabled, canary },
  );
}
export async function level3StreamOpens(page: Page, endpoint: string): Promise<number> {
  return page.evaluate(
    (endpoint) =>
      (
        globalThis as typeof globalThis & { __axtermTestStreamFaults?: FaultHarness }
      ).__axtermTestStreamFaults?.opens(endpoint) ?? 0,
    endpoint,
  );
}
