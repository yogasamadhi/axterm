import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchLocalOptimizationApp } from '../fixtures/local-optimization-launch';

const executablePath = createRequire(resolve('apps/desktop/package.json'))('electron') as string;
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

for (const redraw of ['screen', 'buffer', 'mouse'] as const) {
  test(`terminal context copy preserves the selected CLI text across focus-triggered ${redraw} redraws`, async () => {
    test.skip(process.platform === 'win32', 'This fixture uses a POSIX shell and raw PTY input.');
    test.skip(
      redraw === 'mouse' && process.platform !== 'darwin',
      'Native right-click word selection is the macOS xterm default.',
    );
    const directory = await mkdtemp(resolve(tmpdir(), 'axterm-cli-copy-'));
    const script = resolve(directory, 'cli.cjs');
    const redrawRecord = resolve(directory, 'redraw.txt');
    const mouseRecord = resolve(directory, 'mouse.txt');
    await writeFile(
      script,
      String.raw`const fs = require('node:fs');
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdout.write(${JSON.stringify(redraw === 'mouse' ? '\x1b[?1000h\x1b[?1006h' : '')} + '\x1b[?1049h\x1b[?1004h\x1b[2J\x1b[HCLI_SELECTED_ORIGINAL');
let pending = '';
let redraws = 0;
process.stdin.on('data', (data) => {
  pending += data;
  if (/\x1b\[<\d+;\d+;\d+[Mm]/.test(pending)) fs.writeFileSync(${JSON.stringify(mouseRecord)}, 'received');
  while (pending.includes('\x1b[O')) {
    pending = pending.slice(pending.indexOf('\x1b[O') + 3);
    fs.writeFileSync(${JSON.stringify(redrawRecord)}, String(++redraws));
    process.stdout.write(${JSON.stringify(redraw !== 'screen' ? '\x1b[?1049l\x1b[?1049h' : '')} + '\x1b[2J\x1b[HCLI_REDRAW_' + redraws);
  }
  pending = pending.slice(-16);
  if (data.includes('\x03')) process.exit(0);
});
`,
    );
    const app = await launchLocalOptimizationApp({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${resolve(directory, 'user-data')}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    });
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      const layer = page.locator('.terminal-session-layer:not([hidden])');
      const host = layer.locator('.terminal-host');
      const input = layer.locator('.xterm-helper-textarea');
      await expect(host).toHaveAttribute('data-connection-state', 'connected');
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (text: string) => {
              document.documentElement.dataset.clipboardWrite = text;
            },
          },
        });
      });
      await input.pressSequentially(`${shellQuote(process.execPath)} ${shellQuote(script)}`);
      await input.press('Enter');
      await expect.poll(() => host.getAttribute('data-output-pending-bytes')).toBe('0');

      // Select by dragging the rendered first row, without private xterm APIs.
      const screen = layer.locator('.xterm-screen');
      await expect(screen).toBeVisible();
      const bounds = await screen.boundingBox();
      if (!bounds) throw new Error('Missing terminal screen');
      const row = layer.locator('.xterm-rows > div').first();
      await expect(row).toHaveText('CLI_SELECTED_ORIGINAL');
      if (redraw === 'mouse')
        await expect(layer.locator('.xterm')).toHaveClass(/enable-mouse-events/u);
      const cell = await row.locator('span').first().boundingBox();
      if (!cell) throw new Error('Missing terminal row');
      const cellWidth = cell.width / 'CLI_SELECTED_ORIGINAL'.length;
      const select = async (startColumn: number, endColumn: number) => {
        const y = cell.y + cell.height / 2;
        await page.mouse.move(bounds.x + 1 + cellWidth * startColumn, y);
        await page.mouse.down();
        await page.mouse.move(bounds.x + 1 + cellWidth * endColumn, y, { steps: 8 });
        await page.mouse.up();
        await expect(layer.locator('.xterm-selection div')).not.toHaveCount(0);
      };
      const copiedText = () => page.evaluate(() => document.documentElement.dataset.clipboardWrite);
      if (redraw !== 'mouse') await select(0, 12);
      await host.click({ button: 'right', position: { x: 80, y: 10 } });
      const menu = page.getByRole('menu', { name: '终端菜单' });
      await expect(menu.getByRole('menuitem', { name: '复制', exact: true })).toBeEnabled();
      await expect.poll(() => readFile(redrawRecord, 'utf8').catch(() => '')).toBe('1');
      if (redraw === 'mouse')
        await expect.poll(() => readFile(mouseRecord, 'utf8').catch(() => '')).toBe('received');
      await expect(row).toHaveText('CLI_REDRAW_1');
      if (redraw !== 'screen') await expect(layer.locator('.xterm-selection div')).toHaveCount(0);
      await menu.getByRole('menuitem', { name: '复制', exact: true }).click();
      await expect(layer.locator('.terminal-action-feedback')).toContainText('已复制');
      expect(await copiedText()).toBe(
        redraw === 'mouse' ? 'CLI_SELECTED_ORIGINAL' : 'CLI_SELECTED',
      );
      await expect(input).toBeFocused();

      if (redraw === 'mouse') {
        // xterm still reports mouse input to the CLI, while the menu keeps the
        // word selected by its native macOS right-click handler.
        await host.click({ button: 'right', position: { x: 80, y: 10 } });
        await expect(menu.getByRole('menuitem', { name: '复制', exact: true })).toBeEnabled();
        await expect(row).toHaveText('CLI_REDRAW_2');
        await menu.getByRole('menuitem', { name: '复制', exact: true }).click();
        await expect(layer.locator('.terminal-action-feedback')).toContainText('已复制');
        expect(await copiedText()).toBe('CLI_REDRAW_1');
        await expect(input).toBeFocused();
        expect(errors).toEqual([]);
        return;
      }

      // Keyboard copy uses the live selection, never the previous menu snapshot.
      await select(0, 3);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+Shift+c');
      await expect.poll(copiedText).toBe('CLI');

      await select(4, 10);
      await host.click({ button: 'right', position: { x: 80, y: 10 } });
      await expect(menu.getByRole('menuitem', { name: '复制', exact: true })).toBeEnabled();
      await expect(row).toHaveText('CLI_REDRAW_2');
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      expect(await copiedText()).toBe('CLI');

      // Cancelling and reopening over empty space cannot resurrect old text.
      await host.click({ position: { x: 400, y: 80 } });
      await host.click({ button: 'right', position: { x: 400, y: 80 } });
      await expect(menu.getByRole('menuitem', { name: '复制', exact: true })).toBeDisabled();
      await expect(row).toHaveText('CLI_REDRAW_3');
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      expect(await copiedText()).toBe('CLI');

      // A new menu owns only its new selection, even after a cancelled menu.
      await select(4, 12);
      await host.click({ button: 'right', position: { x: 80, y: 10 } });
      await expect(menu.getByRole('menuitem', { name: '复制', exact: true })).toBeEnabled();
      await expect(row).toHaveText('CLI_REDRAW_4');
      await menu.getByRole('menuitem', { name: '复制', exact: true }).click();
      await expect(layer.locator('.terminal-action-feedback')).toContainText('已复制');
      expect(await copiedText()).toBe('REDRAW_3');
      await expect(input).toBeFocused();
      expect(errors).toEqual([]);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
