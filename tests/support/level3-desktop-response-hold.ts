import type { ElectronApplication } from '@playwright/test';
interface HeldResponse {
  path: string;
  claimed: boolean;
  held: boolean;
  released: boolean;
  wait: Promise<void>;
  release(): void;
}
type Root = typeof globalThis & {
  __axtermTestResponseHold?: { current?: HeldResponse };
};
/** Hold one real, already committed Remote response. No business body or credential is inspected. */
export async function holdDesktopRemoteResponse(
  app: ElectronApplication,
  path: string,
): Promise<void> {
  if (!/^\/api\/[A-Za-z][A-Za-z0-9]*\/[A-Za-z][A-Za-z0-9]*$/u.test(path))
    throw Error('A generated Remote endpoint is required');
  await app.evaluate((_, path) => {
    const root = globalThis as Root;
    if (!root.__axtermTestResponseHold) {
      const state: NonNullable<Root['__axtermTestResponseHold']> = {};
      root.__axtermTestResponseHold = state;
      const original = globalThis.fetch.bind(globalThis);
      globalThis.fetch = async (request, init) => {
        const url = new URL(request instanceof Request ? request.url : String(request));
        const current = state.current;
        if (
          !current ||
          current.claimed ||
          current.released ||
          url.protocol !== 'http:' ||
          !['127.0.0.1', '[::1]'].includes(url.hostname) ||
          url.pathname !== current.path
        )
          return original(request, init);
        current.claimed = true;
        const response = await original(request, init);
        current.held = true;
        await current.wait;
        return response;
      };
    }
    if (root.__axtermTestResponseHold.current && !root.__axtermTestResponseHold.current.released)
      throw Error('A Remote response hold is already active');
    let release = () => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    root.__axtermTestResponseHold.current = {
      path,
      claimed: false,
      held: false,
      released: false,
      wait,
      release,
    };
  }, path);
}
export async function desktopRemoteResponseHeld(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(() => !!(globalThis as Root).__axtermTestResponseHold?.current?.held);
}
export async function releaseDesktopRemoteResponse(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const current = (globalThis as Root).__axtermTestResponseHold?.current;
    if (current) {
      current.released = true;
      current.release();
    }
  });
}
