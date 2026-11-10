import '@fontsource/maple-mono/400.css';
import { prepareBundledTerminalFont } from './terminal-font.ts';
import { AppWebEntry } from './boot.ts';
import { applyIndexInjections } from './apply-injections.ts';
import { ScriptBundleTransport } from './script-transport.ts';
import type {} from './bootstrap.ts';
const container = document.getElementById('root');
if (!container) throw new Error('APP_MOUNT_MISSING');
const desktop = window.axtermDesktopBoot;
const gate = desktop
  ? ((
      globalThis as { __AXTERM_BOOT_READY__?: PromiseWithResolvers<void> }
    ).__AXTERM_BOOT_READY__ ??= Promise.withResolvers<void>())
  : undefined;
const entry = new AppWebEntry(container);
const injections = new ScriptBundleTransport(document);
let stopped = false;
window.addEventListener(
  'pagehide',
  () => {
    stopped = true;
    injections.close();
    void entry.dispose();
  },
  { once: true },
);
if (desktop && gate) {
  void desktop
    .ready()
    .then(async (payload) => {
      if (stopped) return;
      (
        globalThis as {
          __AXTERM_TRANSPORT__?: {
            ownsHost: boolean;
            streamBaseUrl: string;
            windowId?: string;
            presentationSlot?: string;
          };
        }
      ).__AXTERM_TRANSPORT__ = {
        ownsHost: true,
        streamBaseUrl: payload.streamBaseUrl,
        ...(payload.windowId ? { windowId: payload.windowId } : {}),
        ...(payload.presentationSlot ? { presentationSlot: payload.presentationSlot } : {}),
      };
      document.documentElement.dataset.platform = payload.platform;
      await applyIndexInjections(payload.injections, injections.load);
      injections.close();
      gate.resolve();
    })
    .catch(() => {
      injections.close();
      gate.reject(new Error('DESKTOP_BOOTSTRAP_FAILED'));
    });
}
void prepareBundledTerminalFont(document.fonts)
  .then((state) => {
    if (stopped) return false;
    document.documentElement.dataset.terminalFontState = state;
    return entry.run();
  })
  .then((ready) => {
    if (!ready && !stopped) void desktop?.failed().catch(() => {});
  });
