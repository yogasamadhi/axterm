import type {} from '@axterm/ui/workspace';
import { Context } from '@deepseek-ai/cordis';
import type { AxtermWindow, ClientModuleCreateOptions } from '@axterm/infra-client-modules/client';
import { bootClient } from './boot-client.ts';
import { BootPage } from './boot-page.ts';
import { mountClient } from './mount.ts';
import { getStaticModules } from './seed.ts';
import { installWindowDragRecall } from './window-drag/recall.ts';
import '@axterm/infra-ui-theme/bootstrap.module.css';
import './base.module.css';
import { ScriptBundleTransport } from './script-transport.ts';

export type BootSeams = Pick<ClientModuleCreateOptions, 'loadBundle' | 'resolveAsset'>;
/** Owns only browser bootstrap; application UI arrives through Loader entries and Slots. */
export class AppWebEntry {
  private readonly page: BootPage;
  private readonly bundles: ScriptBundleTransport;
  private ctx: Context | undefined;
  private stopDragRecall: (() => void) | undefined;
  private stopped = false;
  private readonly cancellation = Promise.withResolvers<void>();
  private running: Promise<boolean> | undefined;
  constructor(
    private readonly container: HTMLElement,
    private readonly seams?: BootSeams,
  ) {
    this.page = new BootPage(container);
    this.bundles = new ScriptBundleTransport(container.ownerDocument);
  }
  run(): Promise<boolean> {
    return (this.running ??= this.start());
  }
  private async start(): Promise<boolean> {
    try {
      await Promise.race([
        (globalThis as { __AXTERM_BOOT_READY__?: { promise: Promise<void> } }).__AXTERM_BOOT_READY__
          ?.promise,
        this.cancellation.promise,
      ]);
      if (this.stopped) return false;
      const win = globalThis as AxtermWindow;
      if (!win.__ModuleLoader__) throw new Error('BOOT_FACADE_MISSING');
      const modules = win.__ModuleLoader__.create({
        boot: win.__AXTERM_BOOT__,
        staticModules: getStaticModules(),
        loadBundle: this.bundles.load,
        ...this.seams,
      });
      const ctx = new Context();
      this.ctx = ctx;
      const desktopWindow = (
        globalThis as { __AXTERM_TRANSPORT__?: { windowId?: string; presentationSlot?: string } }
      ).__AXTERM_TRANSPORT__?.windowId;
      if (
        desktopWindow &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(desktopWindow)
      ) {
        const slot = (globalThis as { __AXTERM_TRANSPORT__?: { presentationSlot?: string } })
          .__AXTERM_TRANSPORT__?.presentationSlot;
        ctx.provide(
          'desktopWindow',
          Object.freeze({
            id: desktopWindow,
            ...(slot && /^desktop_[0-9]{1,3}$/.test(slot) ? { presentationSlot: slot } : {}),
          }),
        );
      }
      const manifest = modules.manifest;
      this.page.setTotal(manifest.plugins.length);
      await bootClient({
        ctx,
        modules,
        manifest,
        onEntryState: (name, state) => {
          if (!this.stopped && state !== 'failed') this.page.setState(name, state);
        },
      });
      if (this.stopped) {
        await ctx.fiber.dispose();
        return false;
      }
      if (!ctx.slots || !ctx.slots.entries('root').length)
        throw new Error('APPLICATION_ROOT_UNAVAILABLE');
      this.stopDragRecall = installWindowDragRecall({ document: this.container.ownerDocument });
      await mountClient(ctx, this.container);
      return true;
    } catch {
      this.bundles.close();
      this.stopDragRecall?.();
      this.stopDragRecall = undefined;
      try {
        await this.ctx?.fiber.dispose();
      } catch {
        console.error('CLIENT_BOOT_CLEANUP_FAILED');
      }
      this.ctx = undefined;
      if (!this.stopped)
        this.page.fail('Axterm could not start. Restart the application or open recovery.');
      console.error('CLIENT_BOOT_FAILED');
      return false;
    }
  }
  async dispose(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cancellation.resolve();
    this.bundles.close();
    this.stopDragRecall?.();
    this.stopDragRecall = undefined;
    await this.ctx?.fiber.dispose();
    await this.running;
    this.ctx = undefined;
    this.page.dispose();
  }
}
