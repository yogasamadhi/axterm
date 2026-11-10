import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import type { ElectronApplication } from '@playwright/test';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch.ts';
import { remoteDesktopWire } from '../fixtures/remote-desktop-wire.ts';
import { openLevel3Bookmark } from '../support/level3-workspace-actions.ts';

it('initializes the official IronRDP WASM from the actual default Client factory under production CSP and frees an800x600 size', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-ironrdp-owned-ui-'));
  const peer = await remoteDesktopWire('rdp');
  let application: ElectronApplication | undefined;
  try {
    application = await launchLevel3Desktop({
      executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
      args: [resolve('apps/desktop'), `--user-data-dir=${home}`],
      env: { ...process.env },
      timeout: 12000,
    });
    const page = await application.firstWindow();
    page.setDefaultTimeout(6000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await page.evaluate(() => {
      const actual = WebAssembly.instantiateStreaming.bind(WebAssembly);
      WebAssembly.instantiateStreaming = async (...args) => {
        const result = await actual(...args);
        // Observe the actual production instantiation without replacing any module or result.
        (
          globalThis as typeof globalThis & { __ownedRdpWasm?: WebAssembly.Exports }
        ).__ownedRdpWasm = result.instance.exports;
        return result;
      };
    });
    await openLevel3Bookmark(page);
    await page.locator('[data-bookmark-protocol=rdp]').click();
    const form = page.locator('form[data-protocol=rdp]');
    await form.locator('input[name=name]').fill('Official IronRDP initialization');
    await form.locator('input[name=hostname]').fill('127.0.0.1');
    await form.locator('input[name=port]').fill(String(peer.port));
    await form.locator('input[name=username]').fill('fixture');
    await form.locator('input[name=password]').fill('RDP_INIT_PRIVATE_CANARY');
    await form.locator('button[value=save]').click();
    await form.waitFor({ state: 'hidden' });
    await page.locator('[data-activity-item=bookmarks]').click();
    await page
      .locator('[data-bookmark-title="Official IronRDP initialization"]')
      .filter({ visible: true })
      .dblclick();
    await page.locator('[data-rdp-session]').waitFor();
    await page.waitForFunction(
      () =>
        typeof (globalThis as typeof globalThis & { __ownedRdpWasm?: WebAssembly.Exports })
          .__ownedRdpWasm?.desktopsize_create === 'function',
    );
    const size = await page.evaluate(() => {
      const exports = (globalThis as typeof globalThis & { __ownedRdpWasm?: WebAssembly.Exports })
        .__ownedRdpWasm!;
      const create = exports.desktopsize_create as (width: number, height: number) => number;
      const width = exports.__wbg_get_desktopsize_width as (pointer: number) => number;
      const height = exports.__wbg_get_desktopsize_height as (pointer: number) => number;
      const free = exports.__wbg_desktopsize_free as (pointer: number, flag: number) => void;
      const pointer = create(800, 600);
      try {
        return { width: width(pointer), height: height(pointer) };
      } finally {
        free(pointer, 0);
      }
    });
    expect(size).toEqual({ width: 800, height: 600 });
    expect(await page.locator('body').innerText()).not.toContain('RDP_INIT_PRIVATE_CANARY');
    expect(errors).toEqual([]);
  } finally {
    if (application) await closeLevel3Desktop(application);
    await peer.close();
    await rm(home, { recursive: true, force: true });
  }
}, 25000);
