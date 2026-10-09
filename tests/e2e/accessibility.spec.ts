import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';

const require = createRequire(resolve('apps/desktop/package.json'));
const executablePath = require('electron') as string;
const axeScriptPath = require.resolve('axe-core/axe.min.js');

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: Array<{ target: string[]; failureSummary?: string | null }>;
}

interface AccessibilityViolation {
  className: string;
  html: string;
  reason: string;
  tagName: string;
}

async function collectAccessibilityViolations(page: Page): Promise<AccessibilityViolation[]> {
  return page.evaluate(() => {
    const violations: AccessibilityViolation[] = [];
    const visible = (element: HTMLElement) => {
      const style = globalThis.getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0 &&
        bounds.width > 0 &&
        bounds.height > 0
      );
    };
    const labelText = (element: HTMLElement) => {
      const labelledBy = element.getAttribute('aria-labelledby');
      const referenced = labelledBy
        ?.split(/\s+/u)
        .map((id) => globalThis.document.getElementById(id)?.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ');
      const wrappingLabel = element.closest('label')?.textContent?.trim();
      const explicitLabel = element.id
        ? globalThis.document
            .querySelector<HTMLLabelElement>(`label[for="${CSS.escape(element.id)}"]`)
            ?.textContent?.trim()
        : '';
      return [
        element.getAttribute('aria-label'),
        referenced,
        explicitLabel,
        wrappingLabel,
        element.getAttribute('title'),
        element.getAttribute('alt'),
        element.getAttribute('placeholder'),
        element.textContent?.trim(),
      ].find((value) => value && value.length > 0);
    };

    const interactiveSelector = [
      'button',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      'a[href]',
      '[role="button"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[tabindex]',
    ].join(',');
    for (const element of Array.from(
      globalThis.document.querySelectorAll<HTMLElement>(interactiveSelector),
    )) {
      if (
        !visible(element) ||
        element.matches(':disabled,[aria-disabled="true"],[aria-hidden="true"],[tabindex="-1"]') ||
        element.closest('[aria-hidden="true"]')
      ) {
        continue;
      }
      if (!labelText(element)) {
        violations.push({
          className: element.className,
          html: element.outerHTML.slice(0, 240),
          reason: 'visible interactive control has no accessible name',
          tagName: element.tagName,
        });
      }
      if (element.tabIndex > 0) {
        violations.push({
          className: element.className,
          html: element.outerHTML.slice(0, 240),
          reason: `positive tabindex ${element.tabIndex} changes the document focus order`,
          tagName: element.tagName,
        });
      }
    }

    const ids = new Map<string, number>();
    for (const element of Array.from(globalThis.document.querySelectorAll<HTMLElement>('[id]'))) {
      if (!visible(element)) continue;
      ids.set(element.id, (ids.get(element.id) ?? 0) + 1);
    }
    for (const [id, count] of ids) {
      if (count <= 1) continue;
      violations.push({
        className: '',
        html: `id=${id}`,
        reason: `${count} visible elements share the same id`,
        tagName: '*',
      });
    }
    return violations;
  });
}

async function expectAxeClean(page: Page, scene: string): Promise<void> {
  const violations = await page.evaluate(async () => {
    const axe = (
      globalThis as typeof globalThis & {
        axe?: {
          run: (
            context: Document,
            options: { runOnly: { type: 'tag'; values: string[] } },
          ) => Promise<{ violations: AxeViolation[] }>;
        };
      }
    ).axe;
    if (!axe) throw new Error('axe-core was not injected into the renderer');
    const results = await axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
      },
    });
    return results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        failureSummary: node.failureSummary ?? null,
      })),
    }));
  });
  expect(
    violations,
    `${scene} axe-core violations:\n${JSON.stringify(violations, null, 2)}`,
  ).toEqual([]);
}

function parseCssDurations(value: string): number[] {
  return value.split(',').map((duration) => {
    const normalized = duration.trim();
    if (normalized.endsWith('ms')) return Number.parseFloat(normalized);
    if (normalized.endsWith('s')) return Number.parseFloat(normalized) * 1_000;
    return 0;
  });
}

test('J-08 keeps the shell, settings and dialog flows keyboard and screen-reader operable', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-accessibility-e2e-'));
  const configurationPath = resolve(userData, 'axterm-configuration.json');
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.evaluate(
      ({ dialog }, fixturePaths) => {
        let fixtureIndex = 0;
        dialog.showOpenDialog = (() =>
          Promise.resolve({
            canceled: false,
            filePaths: [fixturePaths[Math.min(fixtureIndex++, fixturePaths.length - 1)]!],
          })) as typeof dialog.showOpenDialog;
        dialog.showSaveDialog = (() =>
          Promise.resolve({
            canceled: false,
            filePath: fixturePaths.at(-1),
          })) as typeof dialog.showSaveDialog;
      },
      [configurationPath],
    );
    await app.context().addInitScript({ path: axeScriptPath });
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.locator('.app-sidebar nav')).toHaveAttribute('aria-label', /主要功能/u);
    expect(await collectAccessibilityViolations(page)).toEqual([]);
    await expectAxeClean(page, 'startup shell');

    const settings = page.locator('[data-activity-item="setting"]');
    await settings.focus();
    await expect(settings).toBeFocused();
    await settings.press('Enter');
    const categories = page.getByRole('complementary', { name: '设置项目' });
    const common = categories.locator('[data-settings-category="common"]');
    await expectAxeClean(page, 'Settings common workspace');

    const migrationPanel = page.getByLabel('Axterm 配置快照');
    await expectAxeClean(page, 'Axterm configuration workspace');

    const exportConfiguration = migrationPanel.getByRole('button', {
      name: '导出 Axterm 配置',
    });
    await exportConfiguration.focus();
    await exportConfiguration.press('Enter');
    await expect(migrationPanel.getByText('Axterm 配置已导出', { exact: true })).toBeVisible();
    const importConfiguration = migrationPanel.getByRole('button', {
      name: '导入 Axterm 配置',
    });
    await importConfiguration.focus();
    await importConfiguration.press('Enter');
    const configurationPreview = migrationPanel.locator('.axterm-config-preview');
    await expect(configurationPreview).toBeVisible();
    await expect(configurationPreview.locator('.axterm-config-preview-note')).toContainText(
      '保留当前设置和 application-local Vault',
    );
    await expectAxeClean(page, 'independent Axterm configuration preview workspace');
    const discardConfiguration = configurationPreview.getByRole('button', {
      name: '丢弃 Axterm 配置预览',
    });
    await discardConfiguration.focus();
    await expect(discardConfiguration).toBeFocused();
    await discardConfiguration.press('Enter');
    await expect(configurationPreview).toBeHidden();

    await common.focus();
    await common.press('End');
    await expect(categories.locator('[data-settings-category="legal"]')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(common).toBeFocused();

    await categories.locator('[data-settings-category="legal"]').click();
    const legalNotices = page.locator('.legal-notices-panel');
    await expect(legalNotices).toBeVisible();
    await expectAxeClean(page, 'Settings legal notices workspace');
    const axtermLicenseSummary = legalNotices.getByText('阅读 Apache-2.0 许可证');
    await axtermLicenseSummary.click();
    const axtermLicenseText = legalNotices.locator('details').first().locator('pre');
    await axtermLicenseSummary.press('Tab');
    await expect(axtermLicenseText).toBeFocused();
    const thirdPartySummary = legalNotices.getByText('阅读第三方声明');
    await thirdPartySummary.click();
    const thirdPartyText = legalNotices.locator('details').nth(1).locator('pre');
    await thirdPartySummary.press('Tab');
    await expect(thirdPartyText).toBeFocused();
    await expectAxeClean(page, 'expanded legal notices workspace');

    await categories.locator('[data-settings-category="sync"]').click();
    const sync = page.getByRole('region', { name: '设置同步' });
    const githubProvider = sync.getByRole('tab', { name: 'GitHub' });
    const customProvider = sync.getByRole('tab', { name: '自定义服务' });
    await githubProvider.focus();
    await githubProvider.press('End');
    await expect(customProvider).toBeFocused();
    await expect(customProvider).toHaveAttribute('aria-selected', 'true');
    await customProvider.press('Home');
    await expect(githubProvider).toBeFocused();
    await expect(githubProvider).toHaveAttribute('aria-selected', 'true');

    await sync.getByRole('tab', { name: 'WebDAV' }).click();
    await sync.getByLabel('服务地址').fill('http://127.0.0.1:47302/storage/');
    await sync.getByLabel('远程文件名').fill('accessibility.json');
    await sync.getByLabel('用户名').fill('accessibility-review');
    await sync.getByLabel('WebDAV 密码').fill('ACCESSIBILITY_FIXTURE_ONLY');
    const saveSyncProfile = sync.getByRole('button', { name: '保存配置' });
    await saveSyncProfile.scrollIntoViewIfNeeded();
    await saveSyncProfile.click();
    await expect(sync.getByText('同步配置已保存；凭据只保存在应用本地 Vault。')).toBeVisible();

    await expect(sync.getByRole('tab', { name: '旧版迁移格式' })).toHaveCount(0);
    const compareSyncData = sync.getByRole('button', { name: '比较' });
    await compareSyncData.focus();
    await expect(compareSyncData).toBeFocused();
    expect(await collectAccessibilityViolations(page)).toEqual([]);
    await expectAxeClean(page, 'settings sync workspace');

    await page.getByRole('button', { name: '终端配置', exact: true }).click();
    const connectionProfiles = page.getByRole('region', { name: '连接配置' });
    await expect(connectionProfiles.getByRole('heading', { name: '连接配置' })).toBeVisible();
    const profileName = connectionProfiles.getByLabel('连接配置名称');
    await expect(profileName).toBeFocused();
    expect(await collectAccessibilityViolations(page)).toEqual([]);
    await expectAxeClean(page, 'connection configuration SSH editor');
    const protocolTabs = connectionProfiles.getByRole('tablist', { name: '配置适用协议' });
    const sshTab = protocolTabs.getByRole('tab', { name: 'SSH' });
    const telnetTab = protocolTabs.getByRole('tab', { name: 'Telnet' });
    const spiceTab = protocolTabs.getByRole('tab', { name: 'SPICE' });
    await sshTab.focus();
    await sshTab.press('ArrowRight');
    await expect(telnetTab).toBeFocused();
    await expect(telnetTab).toHaveAttribute('aria-selected', 'true');
    await expect(telnetTab).toHaveAttribute('tabindex', '0');
    await expect(sshTab).toHaveAttribute('tabindex', '-1');
    await expect(connectionProfiles.getByRole('tabpanel', { name: 'Telnet' })).toBeVisible();
    await telnetTab.press('End');
    await expect(spiceTab).toBeFocused();
    await spiceTab.press('ArrowRight');
    await expect(sshTab).toBeFocused();
    await sshTab.press('ArrowLeft');
    await expect(spiceTab).toBeFocused();
    await expect(spiceTab).toHaveAttribute('aria-selected', 'true');
    await expect(connectionProfiles.getByRole('tabpanel', { name: 'SPICE' })).toBeVisible();
    await expect(connectionProfiles.getByRole('tabpanel')).toHaveCount(1);
    await spiceTab.press('Tab');
    await expect(
      connectionProfiles.getByRole('tabpanel', { name: 'SPICE' }).getByRole('textbox', {
        name: '用户名',
      }),
    ).toBeFocused();
    expect(await collectAccessibilityViolations(page)).toEqual([]);
    await expectAxeClean(page, 'connection configuration SPICE editor');

    await page.getByRole('button', { name: '关闭设置并返回工作区' }).focus();
    await page.keyboard.press('Enter');
    const hosts = page.locator('[data-activity-item="bookmarks"]');
    await hosts.focus();
    await hosts.press('Enter');
    await expect(page.locator('.workspace-sidebar')).toBeHidden();
    await hosts.press('Enter');
    await expect(page.locator('.workspace-sidebar')).toBeVisible();
    const manageHosts = page.locator('.workspace-sidebar').getByRole('button', { name: '管理' });
    await manageHosts.focus();
    await manageHosts.press('Enter');
    await expect(page.locator('.section-tab')).toHaveCount(0);
    await expect(page.locator('.terminal-workspace-layer')).toBeVisible();
    const hostGroupFilters = page.getByRole('group', { name: '主机分组' });
    await expect(hostGroupFilters.getByRole('button').first()).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expectAxeClean(page, 'Host Manager workspace');
    const addHost = page.getByRole('button', { name: '添加主机' });
    await addHost.focus();
    await addHost.press('Enter');
    const dialog = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('名称')).toBeFocused();
    expect(await collectAccessibilityViolations(page)).toEqual([]);
    await expectAxeClean(page, 'add SSH bookmark dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(addHost).toBeFocused();

    const addRdp = page.getByRole('button', { name: '添加 RDP' });
    await addRdp.focus();
    await addRdp.press('Enter');
    const rdpDialog = page.getByRole('dialog', { name: '添加 RDP 书签' });
    await expect(rdpDialog).toBeVisible();
    await expect(rdpDialog.locator('form[data-protocol="rdp"]')).toBeVisible();
    await expect(rdpDialog.getByLabel('名称')).toBeFocused();
    expect(await collectAccessibilityViolations(page)).toEqual([]);
    await expectAxeClean(page, 'add RDP bookmark dialog');
    await page.keyboard.press('Escape');
    await expect(rdpDialog).toBeHidden();
    await expect(addRdp).toBeFocused();

    await page.locator('[data-activity-item="setting"]').focus();
    await page.keyboard.press('Enter');
    await page.locator('.settings-workspace-tabs button').nth(2).focus();
    await page.keyboard.press('Enter');
    const themeWorkspace = page.locator('.terminal-theme-workspace');
    await expect(themeWorkspace).toBeVisible();
    await expect(page.getByTestId('legacy-theme-file-deprecation')).toHaveCount(0);
    expect(await collectAccessibilityViolations(page)).toEqual([]);
    await expectAxeClean(page, 'terminal theme workspace');

    await page.locator('[data-activity-item="setting"]').focus();
    await page.keyboard.press('Enter');
    const widgets = page.locator('.settings-workspace-tabs button').nth(6);
    await widgets.focus();
    await widgets.press('Enter');
    await expect(page.locator('.widget-workspace')).toBeVisible();
    await expectAxeClean(page, 'Widgets workspace');
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('J-08 removes meaningful animation when reduced motion is requested', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-reduced-motion-e2e-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('.tab-add-menu:visible').first().click();
    await expect(page.locator('.session-menu')).toBeVisible();
    const durations = await page.locator('.app-shell').evaluate((root) =>
      Array.from(root.querySelectorAll<HTMLElement>('*'))
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          const style = globalThis.getComputedStyle(element);
          return bounds.width > 0 && bounds.height > 0 && style.visibility !== 'hidden';
        })
        .flatMap((element) => {
          const style = globalThis.getComputedStyle(element);
          return [style.animationDuration, style.transitionDuration];
        }),
    );
    const maximumDuration = Math.max(0, ...durations.flatMap(parseCssDurations));
    expect(maximumDuration).toBeLessThanOrEqual(0.01);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});
