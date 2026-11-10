import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { expect as browserExpect, type ElectronApplication } from '@playwright/test';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch.ts';
it('boots actual Desktop factories and PTY under CSP while refusing unowned inline/eval and accepting its startup nonce', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-document-csp-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launchLevel3Desktop({
      executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
      args: [resolve('apps/desktop'), `--user-data-dir=${home}`],
      env: { ...process.env },
      timeout: 12000,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    await page.locator('[data-terminal-channel=ready]').waitFor();
    const result = await page.evaluate(() => {
      const root = globalThis as typeof globalThis & {
        __axtermInline?: boolean;
        __axtermNonce?: boolean;
        __axtermEvalBlocked?: boolean;
        __axtermProbeDone?: boolean;
      };
      const forbidden = document.createElement('script');
      forbidden.textContent = 'globalThis.__axtermInline=true';
      document.head.append(forbidden);
      const allowed = document.createElement('script');
      allowed.nonce =
        document.querySelector<HTMLMetaElement>('meta[name="axterm-csp-nonce"]')?.content ?? '';
      allowed.textContent =
        'globalThis.__axtermNonce=true;setTimeout(()=>{try{Function("return 1")();globalThis.__axtermEvalBlocked=false}catch{globalThis.__axtermEvalBlocked=true}globalThis.__axtermProbeDone=true},0)';
      document.head.append(allowed);
      forbidden.remove();
      allowed.remove();
      return {
        inline: root.__axtermInline ?? false,
        nonce: root.__axtermNonce ?? false,
        evalBlocked: root.__axtermEvalBlocked ?? false,
      };
    });
    expect(result.inline).toBe(false);
    expect(result.nonce).toBe(true);
    await page.waitForFunction(
      () =>
        (globalThis as typeof globalThis & { __axtermProbeDone?: boolean }).__axtermProbeDone ===
        true,
    );
    expect(
      await page.evaluate(
        () =>
          (globalThis as typeof globalThis & { __axtermEvalBlocked?: boolean }).__axtermEvalBlocked,
      ),
    ).toBe(true);
    const input = page.locator('.xterm-helper-textarea').first();
    await input.fill("printf '\\nAXTERM_CSP_PTY_OK\\n'");
    await input.press('Enter');
    await browserExpect(page.locator('.terminal-canvas').first()).toContainText(
      'AXTERM_CSP_PTY_OK',
    );
  } finally {
    if (app) await closeLevel3Desktop(app);
    await rm(home, { recursive: true, force: true });
  }
}, 20000);
