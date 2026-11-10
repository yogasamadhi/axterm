import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch';
const executablePath = createRequire(resolve('apps/desktop/package.json'))('electron') as string;

test('active terminal tab has a distinct background and accent that follow the selection', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-active-tab-color-e2e-'));
  const app = await launchLevel3Desktop({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await page.locator('[data-terminal-new]').click();
    const tabs = page.locator('[data-workspace-global-tabs] [role=tab]');
    await expect(tabs).toHaveCount(2);

    const tabAppearance = () =>
      tabs.evaluateAll((elements) =>
        elements.map((element) => {
          const painted = element.closest('.workspace-tab-entry')!;
          const style = getComputedStyle(painted);
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d')!;
          // The new wrapper paints the complete tab, including its close control.
          // Resolve its opaque ancestor for an inactive transparent entry.
          for (let node: Element | null = painted; node; node = node.parentElement) {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = getComputedStyle(node).backgroundColor;
            context.fillRect(0, 0, 1, 1);
            if (context.getImageData(0, 0, 1, 1).data[3] === 255) break;
          }
          const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
          const accentChannels = style.boxShadow.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          return {
            brightness: red! * 0.2126 + green! * 0.7152 + blue! * 0.0722,
            colorSpread: Math.max(red!, green!, blue!) - Math.min(red!, green!, blue!),
            accent: style.boxShadow,
            accentSpread: accentChannels
              ? Math.max(...accentChannels.slice(1, 4).map(Number)) -
                Math.min(...accentChannels.slice(1, 4).map(Number))
              : null,
          };
        }),
      );

    await expect(tabs.nth(1)).toHaveClass(/active/);
    let appearance = await tabAppearance();
    expect(appearance[1]!.brightness - appearance[0]!.brightness).toBeGreaterThan(55);
    expect(appearance[1]!.colorSpread).toBeLessThanOrEqual(3);
    expect(appearance[1]!.accent).toContain('inset');
    expect(appearance[1]!.accentSpread).toBeLessThanOrEqual(3);
    expect(appearance[0]!.accent).toBe('none');

    await tabs.first().click();
    await expect(tabs.first()).toHaveClass(/active/);
    appearance = await tabAppearance();
    expect(appearance[0]!.brightness - appearance[1]!.brightness).toBeGreaterThan(55);
    expect(appearance[0]!.colorSpread).toBeLessThanOrEqual(3);
    expect(appearance[0]!.accent).toContain('inset');
    expect(appearance[0]!.accentSpread).toBeLessThanOrEqual(3);
    expect(appearance[1]!.accent).toBe('none');
  } finally {
    await closeLevel3Desktop(app);
    await rm(userData, { recursive: true, force: true });
  }
});

test('trusted desktop renderer can read and write the system clipboard', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-system-clipboard-e2e-'));
  const app = await launchLevel3Desktop({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await page.bringToFront();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-terminal-channel=ready]').waitFor();

    const pasteMarker = `AXTERM_NATIVE_PASTE_${Date.now()}`;
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), pasteMarker);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(pasteMarker);

    const copyMarker = `AXTERM_RENDERER_COPY_${Date.now()}`;
    await page.evaluate((text) => navigator.clipboard.writeText(text), copyMarker);
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(copyMarker);
  } finally {
    await closeLevel3Desktop(app);
    await rm(userData, { recursive: true, force: true });
  }
});
