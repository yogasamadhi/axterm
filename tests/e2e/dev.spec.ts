import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { chromium, expect, test } from '@playwright/test';

test('bun run dev launches the desktop with the Vite renderer', async () => {
  test.skip(
    process.platform === 'win32',
    'POSIX process-group cleanup; Windows is covered by desktop and packaged E2E',
  );
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No debugging port');
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const child = spawn('bun', ['run', 'dev'], {
    detached: true,
    env: { ...process.env, REMOTE_DEBUGGING_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-16_000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  try {
    await expect
      .poll(
        async () => {
          if (child.exitCode !== null) throw new Error(`Dev exited: ${output}`);
          return fetch(`http://127.0.0.1:${port}/json/version`)
            .then((response) => response.ok)
            .catch(() => false);
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    try {
      const context = browser.contexts()[0]!;
      await expect.poll(() => context.pages().length).toBeGreaterThan(0);
      const page = context.pages()[0]!;
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      expect(page.url()).toBe('http://127.0.0.1:5173/');
      await expect(page.getByTestId('runtime-generation')).toHaveText(/^[\da-f-]{36}$/);
      await page.getByTitle('新建本地终端').click();
      await expect(page.locator('.terminal-host')).toHaveAttribute(
        'data-connection-state',
        'connected',
      );
    } finally {
      await browser.close();
    }
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already exited */
      }
    }
    child.stdout.off('data', collect);
    child.stderr.off('data', collect);
    child.stdout.destroy();
    child.stderr.destroy();
  }
});
