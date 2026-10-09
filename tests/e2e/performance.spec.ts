import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { terminalProfileInputSchema } from '../../packages/contracts/src';
import { ProductDatabase } from '../../packages/runtime/src/adapters/sqlite/database';
import {
  ProductRepository,
  etagFor,
} from '../../packages/runtime/src/adapters/sqlite/product-repository';

import { launchLocalOptimizationApp } from '../fixtures/local-optimization-launch';

const require = createRequire(resolve('apps/desktop/package.json'));
const executablePath = require('electron') as string;
const timestamp = '2026-09-14T00:00:00.000Z';
const groupId = '00000000-0000-4000-8000-000000000001';

const terminalProfileBytes = 8 * 1024 * 1024;
const terminalQueueCeilingBytes = 512 * 1024;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function outputMetrics(page: Page) {
  return page.locator('.terminal-host').evaluateAll((hosts) =>
    hosts.map((host) => {
      const element = host as HTMLElement;
      const read = (name: string) => {
        const value = element.dataset[name];
        if (value === undefined || !Number.isFinite(Number(value)))
          throw new Error(`Missing terminal consumption metric: ${name}`);
        return Number(value);
      };
      return {
        id: element.dataset.testid!.replace('terminal-', ''),
        receivedBytes: read('outputReceivedBytes'),
        consumedBytes: read('outputConsumedBytes'),
        pendingBytes: read('outputPendingBytes'),
        peakPendingBytes: read('outputPeakPendingBytes'),
        peakCallbackMs: read('outputPeakCallbackMs'),
        writeCalls: read('outputWriteCalls'),
        completedWrites: read('outputCompletedWrites'),
      };
    }),
  );
}

for (const terminalCount of [1, 4, 8]) {
  test(`OP03 visible native PTY consumption with ${terminalCount} terminal(s)`, async () => {
    test.skip(process.platform === 'win32', 'This fixed native PTY profile requires /bin/sh.');
    test.setTimeout(120_000);
    const userData = await mkdtemp(resolve(tmpdir(), `axterm-output-${terminalCount}-`));
    const payloadFile = resolve(userData, 'fixed-output.bin');
    const barrierFile = resolve(userData, 'begin-output');
    const row = Buffer.from(`${'OP03_FIXED_ROW_'.padEnd(62, 'x')}\r\n`);
    const payload = Buffer.alloc(terminalProfileBytes);
    for (let offset = 0; offset < payload.length; offset += row.length) row.copy(payload, offset);
    const report: Record<string, unknown> = {
      measuredAt: new Date().toISOString(),
      environment: {
        platform: platform(),
        arch: arch(),
        release: release(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        memoryGiB: totalmem() / 1024 ** 3,
        loadAverage: loadavg(),
      },
      terminalCount,
      bytesPerTerminal: terminalProfileBytes,
      rowBytes: row.length,
      payloadSha256: createHash('sha256').update(payload).digest('hex'),
      rssSamplingIntervalMs: 100,
      queueCeilingBytes: terminalQueueCeilingBytes,
      measurement:
        'native PTY -> Runtime Binary WS -> xterm public write callback; painted DOM checked separately',
    };
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    let memoryTimer: ReturnType<typeof setInterval> | undefined;
    let sampleInFlight = Promise.resolve();
    let sampling = false;
    let samplingError: unknown;
    let peakWorkingSetMiB = 0;
    let maxProcessCount = 0;
    let memorySampleCount = 0;
    try {
      await writeFile(payloadFile, payload);
      const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
      try {
        const repository = new ProductRepository(database);
        const profile = repository.createJson(
          'terminal_profiles',
          terminalProfileInputSchema.parse({
            name: 'OP03 fixed native shell',
            shell: '/bin/sh',
            cwd: userData,
            loginShell: false,
            env: { PS1: '', ENV: '/dev/null' },
          }),
          'terminal-profile',
        );
        const settings = repository.getSettings();
        repository.updateSettings(
          { terminal: { defaultProfileId: profile.id } },
          etagFor(settings.version),
        );
      } finally {
        database.close();
      }
      app = await launchLocalOptimizationApp({
        executablePath,
        args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
        env: { ...process.env, ELECTRON_RENDERER_URL: '', AXTERM_E2E_HIDDEN_WINDOW: '0' },
      });
      const page = await app.firstWindow();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await expect(page.locator('html')).toHaveAttribute('data-terminal-font-state', 'ready');
      report.window = await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.setSize(1440, 900);
        window.webContents.setZoomFactor(1);
        window.show();
        window.focus();
        return {
          visible: window.isVisible(),
          minimized: window.isMinimized(),
          zoom: window.webContents.getZoomFactor(),
        };
      });
      report.viewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        visibility: document.visibilityState,
      }));
      expect(report.window).toMatchObject({ visible: true, minimized: false, zoom: 1 });
      const tabs = page.locator('.pane-tabbar .terminal-tab');
      const activeLayer = page.locator('.terminal-session-layer:not([hidden])');
      for (let index = 1; index < terminalCount; index += 1) {
        await page.keyboard.press('Alt+Q');
        await expect(tabs).toHaveCount(index + 1);
      }
      const ids = await tabs.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-terminal-id')!),
      );
      for (const [index, terminalId] of ids.entries()) {
        const script = resolve(userData, `burst-${index}.sh`);
        await writeFile(
          script,
          [
            'stty -echo -onlcr',
            `printf '\\r\\nOP03_ARMED_${index}\\r\\n'`,
            `while [ ! -f ${shellQuote(barrierFile)} ]; do sleep 0.01; done`,
            `cat ${shellQuote(payloadFile)}`,
            `printf '\\r\\nOP03_DONE_${index}\\r\\n'`,
            'stty echo onlcr',
          ].join('\n') + '\n',
        );
        await page.locator(`.pane-tabbar .terminal-tab[data-terminal-id="${terminalId}"]`).click();
        await expect(activeLayer.locator('.terminal-host')).toHaveAttribute(
          'data-connection-state',
          'connected',
        );
        const input = activeLayer.locator('.xterm-helper-textarea');
        await input.pressSequentially(`sh ${shellQuote(script)}`);
        await input.press('Enter');
        await expect
          .poll(() => activeLayer.locator('.xterm-rows').textContent())
          .toContain(`OP03_ARMED_${index}`);
      }
      const baseline = await outputMetrics(page);
      const memory = async () => {
        const values = await app!.evaluate(({ app }) =>
          app
            .getAppMetrics()
            .map((metric) => ({ type: metric.type, workingSetKiB: metric.memory.workingSetSize })),
        );
        if (
          !values.length ||
          values.some((value) => !Number.isFinite(value.workingSetKiB) || value.workingSetKiB <= 0)
        )
          throw new Error('Working-set measurement is unavailable');
        return {
          workingSetMiB: values.reduce((sum, value) => sum + value.workingSetKiB, 0) / 1024,
          processes: values,
        };
      };
      const memoryBaseline = await memory();
      report.memoryBaseline = memoryBaseline;
      peakWorkingSetMiB = memoryBaseline.workingSetMiB;
      memoryTimer = setInterval(() => {
        if (sampling) return;
        sampling = true;
        sampleInFlight = memory()
          .then((value) => {
            peakWorkingSetMiB = Math.max(peakWorkingSetMiB, value.workingSetMiB);
            maxProcessCount = Math.max(maxProcessCount, value.processes.length);
            memorySampleCount += 1;
          })
          .catch((error: unknown) => {
            samplingError = error;
          })
          .finally(() => {
            sampling = false;
          });
      }, 100);
      const startedAt = performance.now();
      await writeFile(barrierFile, 'start');
      await expect
        .poll(
          async () => {
            const values = await outputMetrics(page);
            return values.every(
              (value) =>
                value.pendingBytes === 0 &&
                value.consumedBytes -
                  baseline.find((item) => item.id === value.id)!.consumedBytes >=
                  terminalProfileBytes,
            );
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      const burstMs = performance.now() - startedAt;
      const burstMetrics = await outputMetrics(page);
      report.burst = {
        durationMs: burstMs,
        aggregateMiBPerSecond:
          (terminalCount * terminalProfileBytes) / 1024 ** 2 / (burstMs / 1000),
        terminals: burstMetrics,
        baseline,
      };
      const recovered: Array<{ index: number; activationMs: number; searchMs: number }> = [];
      for (const [index, terminalId] of ids.entries()) {
        const activatedAt = performance.now();
        await page.locator(`.pane-tabbar .terminal-tab[data-terminal-id="${terminalId}"]`).click();
        await expect
          .poll(() => activeLayer.locator('.xterm-rows').textContent())
          .toContain(`OP03_DONE_${index}`);
        const activationMs = performance.now() - activatedAt;
        const searchAt = performance.now();
        await activeLayer
          .locator('.xterm-helper-textarea')
          .press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
        const search = activeLayer.getByRole('textbox', { name: '查找终端输出' });
        await search.fill(`OP03_DONE_${index}`);
        await expect(activeLayer.locator('.terminal-search-count')).toHaveText(/\d+\/1/);
        const searchMs = performance.now() - searchAt;
        await search.press('Escape');
        recovered.push({ index, activationMs, searchMs });
      }
      report.retainedTabs = recovered;
      await page.locator(`.pane-tabbar .terminal-tab[data-terminal-id="${ids[0]}"]`).click();
      const input = activeLayer.locator('.xterm-helper-textarea');
      const rows = activeLayer.locator('.xterm-rows');
      const backgroundScript = resolve(userData, 'background-burst.sh');
      const backgroundBarrier = resolve(userData, 'background-begin');
      await writeFile(
        backgroundScript,
        [
          'stty -echo -onlcr',
          "printf '\\r\\nOP03_BACKGROUND_ARMED\\r\\n'",
          `while [ ! -f ${shellQuote(backgroundBarrier)} ]; do sleep 0.01; done`,
          `cat ${shellQuote(payloadFile)}`,
          "printf '\\r\\nOP03_BACKGROUND_DONE\\r\\n'",
          'stty echo onlcr',
        ].join('\n') + '\n',
      );
      await input.pressSequentially(`sh ${shellQuote(backgroundScript)}`);
      await input.press('Enter');
      await expect.poll(() => rows.textContent()).toContain('OP03_BACKGROUND_ARMED');
      const backgroundBaseline = await outputMetrics(page);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.minimize());
      await expect
        .poll(() =>
          app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized()),
        )
        .toBe(true);
      const minimized = true;
      const suspendedAt = performance.now();
      await writeFile(backgroundBarrier, 'start');
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      const suspendedMs = performance.now() - suspendedAt;
      const restoredAt = performance.now();
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.restore();
        window.show();
        window.focus();
      });
      await expect
        .poll(() =>
          app!.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0]!;
            return window.isVisible() && !window.isMinimized();
          }),
        )
        .toBe(true);
      await expect.poll(() => rows.textContent()).toContain('OP03_BACKGROUND_DONE');
      const recoveryMs = performance.now() - restoredAt;
      await expect
        .poll(async () => {
          const values = await outputMetrics(page);
          const first = values.find((value) => value.id === ids[0])!;
          return (
            first.pendingBytes === 0 &&
            first.consumedBytes -
              backgroundBaseline.find((value) => value.id === ids[0])!.consumedBytes >=
              terminalProfileBytes
          );
        })
        .toBe(true);
      report.windowRecovery = {
        minimized,
        suspendedMs,
        recoveryMs,
        metrics: await outputMetrics(page),
      };
      const echoScript = resolve(userData, 'echo-marker.sh');
      const interruptScript = resolve(userData, 'interrupted-marker.sh');
      await writeFile(echoScript, "printf '\\r\\nOP03_INPUT_RECEIVED\\r\\n'\n");
      await writeFile(interruptScript, "printf '\\r\\nOP03_INTERRUPT_RECOVERED\\r\\n'\n");
      const inputAt = performance.now();
      await input.pressSequentially(`sh ${shellQuote(echoScript)}`);
      await input.press('Enter');
      await expect.poll(() => rows.textContent()).toContain('OP03_INPUT_RECEIVED');
      const inputMs = performance.now() - inputAt;
      await input.pressSequentially('yes OP03_FLOOD');
      await input.press('Enter');
      await expect.poll(() => rows.textContent()).toContain('OP03_FLOOD');
      const interruptedAt = performance.now();
      await input.press('Control+c');
      await input.pressSequentially(`sh ${shellQuote(interruptScript)}`);
      await input.press('Enter');
      await expect.poll(() => rows.textContent()).toContain('OP03_INTERRUPT_RECOVERED');
      const interruptMs = performance.now() - interruptedAt;
      await expect
        .poll(async () => (await outputMetrics(page)).every((value) => value.pendingBytes === 0))
        .toBe(true);
      const finished = await outputMetrics(page);
      report.interaction = { inputMs, interruptMs, finalMetrics: finished };
      await page.screenshot({
        path: test.info().outputPath(`terminal-${terminalCount}-visible.png`),
      });
      const memoryFinal = await memory();
      peakWorkingSetMiB = Math.max(peakWorkingSetMiB, memoryFinal.workingSetMiB);
      report.memoryFinal = memoryFinal;
      report.memoryPeak = {
        workingSetMiB: peakWorkingSetMiB,
        growthMiB: peakWorkingSetMiB - memoryBaseline.workingSetMiB,
        sampleCount: memorySampleCount,
        maxProcessCount,
      };
      if (samplingError) throw samplingError;
      expect.soft(burstMs).toBeLessThanOrEqual(30_000);
      expect
        .soft((report.burst as { aggregateMiBPerSecond: number }).aggregateMiBPerSecond)
        .toBeGreaterThanOrEqual(1);
      for (const value of finished) {
        expect.soft(value.peakPendingBytes).toBeLessThanOrEqual(terminalQueueCeilingBytes);
        expect.soft(value.peakCallbackMs).toBeLessThanOrEqual(2_000);
        expect.soft(value.pendingBytes).toBe(0);
        expect.soft(value.consumedBytes).toBe(value.receivedBytes);
        expect.soft(value.completedWrites).toBe(value.writeCalls);
      }
      expect
        .soft(peakWorkingSetMiB - memoryBaseline.workingSetMiB)
        .toBeLessThanOrEqual(terminalCount === 1 ? 256 : terminalCount === 4 ? 512 : 768);
      expect.soft(inputMs).toBeLessThanOrEqual(1_500);
      expect.soft(interruptMs).toBeLessThanOrEqual(1_500);
      expect.soft(recoveryMs).toBeLessThanOrEqual(1_500);
      for (const value of recovered) {
        expect.soft(value.activationMs).toBeLessThanOrEqual(1_500);
        expect.soft(value.searchMs).toBeLessThanOrEqual(1_500);
      }
    } finally {
      if (memoryTimer) clearInterval(memoryTimer);
      await sampleInFlight;
      await writeFile(
        test.info().outputPath(`terminal-${terminalCount}-metrics.json`),
        JSON.stringify(report, null, 2) + '\n',
      );
      await app?.close().catch(() => {});
      await rm(userData, { recursive: true, force: true });
    }
  });
}

function id(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}

test('J-09 keeps the 10k bookmark workspace responsive and DOM-bounded', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-performance-e2e-'));
  const database = await ProductDatabase.open(resolve(userData, 'data-v2', 'axterm.sqlite'));
  try {
    database.transaction(() => {
      database.run(
        `INSERT INTO bookmark_groups(
          id, parent_id, name, color, description, position, created_at, updated_at, version
        ) VALUES (?, NULL, 'Performance 10000', NULL, '', 0, ?, ?, 1)`,
        groupId,
        timestamp,
        timestamp,
      );
      for (let index = 0; index < 10_000; index += 1) {
        database.run(
          `INSERT INTO bookmarks(
            id, group_id, protocol, host_id, title, color, description, position,
            profile_id, connection_profile_id, quick_commands_payload, triggers_payload,
            ftp_payload, telnet_payload, serial_payload, rdp_payload, vnc_payload,
            spice_payload, web_payload, created_at, updated_at, version
          ) VALUES (?, ?, 'local', NULL, ?, NULL, '', ?, NULL, NULL, '[]', '[]',
            'null', 'null', 'null', 'null', 'null', 'null', 'null', ?, ?, 1)`,
          id(index + 10),
          groupId,
          `Server ${index.toString().padStart(5, '0')}`,
          index,
          timestamp,
          timestamp,
        );
      }
    });
  } finally {
    database.close();
  }

  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();

    const group = page.locator('.bookmark-tree-row').filter({ hasText: 'Performance 10000' });
    await expect(group).toBeVisible();
    await page.evaluate(() => performance.mark('j09-expand-start'));
    await group.locator('.bookmark-row-main').click();
    await expect(page.locator('[data-bookmark-title="Server 00000"]')).toBeVisible();
    const expandDuration = await page.evaluate(
      () => performance.now() - performance.getEntriesByName('j09-expand-start').at(-1)!.startTime,
    );
    expect(expandDuration).toBeLessThan(3_000);
    expect(await page.locator('.bookmark-tree-row').count()).toBeLessThanOrEqual(64);
    await expect(page.locator('.bookmark-tree-spacer')).toHaveCSS('height', '260026px');

    const search = page.getByRole('textbox', { name: '搜索书签' });
    await page.evaluate(() => performance.mark('j09-search-start'));
    await search.fill('Server 09999');
    await expect(page.locator('[data-bookmark-title="Server 09999"]')).toBeVisible();
    await expect(page.locator('.bookmark-search-announcement')).toHaveText('1 个匹配');
    const searchDuration = await page.evaluate(
      () => performance.now() - performance.getEntriesByName('j09-search-start').at(-1)!.startTime,
    );
    expect(searchDuration).toBeLessThan(1_500);
    expect(await page.locator('.bookmark-tree-row').count()).toBeLessThanOrEqual(64);

    await search.fill('');
    const viewport = page.locator('.bookmark-tree-viewport');
    await viewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(page.locator('[data-bookmark-title="Server 09999"]')).toBeVisible();
    expect(await page.locator('.bookmark-tree-row').count()).toBeLessThanOrEqual(64);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});
