import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { expect as browserExpect, type ElectronApplication } from '@playwright/test';
import { terminalProfileInputSchema } from '@axterm/plugin-api/terminals';
import { withLevel3ProductSeed } from '../fixtures/level3-product-seed.ts';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch.ts';

it.skipIf(process.platform === 'win32')(
  'starts the real Desktop from owned performance seed and exposes actual Host and parser metrics',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'axterm-performance-entry-'));
    let app: ElectronApplication | undefined;
    let child: ReturnType<ElectronApplication['process']> | undefined;
    try {
      await withLevel3ProductSeed(home, (ctx) => {
        const profile = ctx.terminalFacts.createProfile(
          randomUUID(),
          terminalProfileInputSchema.parse({
            name: 'Performance entry probe',
            shell: '/bin/sh',
            cwd: home,
            loginShell: false,
            env: { HOME: home, ENV: '/dev/null', PS1: '', AXTERM_SEED_PROBE: 'OWNED_PROFILE' },
          }),
        );
        const settings = ctx.configurationController.getSettings();
        ctx.configurationController.updateSettings(
          randomUUID(),
          { terminal: { defaultProfileId: profile.ids[0]! } },
          `"v${settings.version}"`,
        );
      });
      app = await launchLevel3Desktop({
        executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
        args: [resolve('apps/desktop'), `--user-data-dir=${home}`],
        env: { ...process.env },
        timeout: 12000,
      });
      child = app.process();
      const page = await app.firstWindow();
      page.setDefaultTimeout(7000);
      const terminal = page.locator('[data-terminal-channel=ready]:visible');
      await terminal.waitFor();
      const input = terminal.locator('.xterm-helper-textarea');
      await input.pressSequentially('printf \'SEED_%s\\n\' "$AXTERM_SEED_PROBE"');
      await input.press('Enter');
      await browserExpect(terminal.locator('.xterm-rows')).toContainText('SEED_OWNED_PROFILE');
      const canvas = terminal.locator('.terminal-canvas');
      await expect
        .poll(async () => Number(await canvas.getAttribute('data-output-pending-bytes')))
        .toBe(0);
      expect(Number(await canvas.getAttribute('data-output-received-bytes'))).toBeGreaterThan(0);
      expect(await canvas.getAttribute('data-output-received-bytes')).toBe(
        await canvas.getAttribute('data-output-consumed-bytes'),
      );
      await page.locator('[data-runtime-details-trigger]').first().click();
      const pid = Number(await page.getByTestId('runtime-process-id').innerText());
      expect(pid).not.toBe(child.pid);
      const rss = await app.evaluate(
        (_, pid) =>
          Number(
            process
              .getBuiltinModule('node:child_process')
              .execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' })
              .trim(),
          ),
        pid,
      );
      expect(rss).toBeGreaterThan(0);
      await page.keyboard.press('Escape');
      await page.locator('[data-terminal-new]').click();
      await browserExpect(
        page.locator('[data-workspace-global-tabs]').getByRole('tab'),
      ).toHaveCount(2);
      await closeLevel3Desktop(app);
      expect(child.exitCode).toBe(0);
      app = undefined;
    } finally {
      if (app) {
        if (child?.exitCode === null) child.kill('SIGKILL');
        await app.close().catch(() => {});
      }
      await rm(home, { recursive: true, force: true });
    }
  },
  30000,
);
