import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';

const require = createRequire(resolve('apps/desktop/package.json'));
const executablePath = require('electron') as string;

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
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.locator('.app-sidebar nav')).toHaveAttribute('aria-label', /主要功能/u);
    expect(await collectAccessibilityViolations(page)).toEqual([]);

    const settings = page.locator('[data-activity-item="setting"]');
    await settings.focus();
    await expect(settings).toBeFocused();
    await settings.press('Enter');
    const categories = page.getByRole('complementary', { name: '设置项目' });
    const common = categories.locator('[data-settings-category="common"]');
    await common.focus();
    await common.press('End');
    await expect(categories.locator('[data-settings-category="password"]')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(common).toBeFocused();
    expect(await collectAccessibilityViolations(page)).toEqual([]);

    await page.getByRole('button', { name: '关闭设置并返回工作区' }).focus();
    await page.keyboard.press('Enter');
    const hosts = page.locator('[data-activity-item="bookmarks"]');
    await hosts.focus();
    await hosts.press('Enter');
    const addHost = page.getByRole('button', { name: '添加主机' });
    await addHost.focus();
    await addHost.press('Enter');
    const dialog = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('名称')).toBeFocused();
    expect(await collectAccessibilityViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(addHost).toBeFocused();
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
    await page.locator('.activity-new').click();
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
