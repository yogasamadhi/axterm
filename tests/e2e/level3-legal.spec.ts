import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch';
import { openLevel3Settings } from '../support/level3-workspace-actions';
const licenseDocuments = (await readdir(resolve('licenses')))
  .filter((name) => name.endsWith('.txt'))
  .sort();
test('actual desktop and new package expose every exact retained legal document and runtime notice', async ({
  browserName: _browserName,
}, info) => {
  test.skip(
    info.project.name === 'packaged' && !process.env.AXTERM_LEVEL3_PACKAGE_RESULT,
    'An explicit new isolated package is required.',
  );
  test.setTimeout(90_000);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-legal-')));
  const home = join(directory, 'home');
  await mkdir(home);
  const app = await launchLevel3Desktop({
    executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
    args: [`--user-data-dir=${home}`],
    env: { ...process.env },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await openLevel3Settings(page);
    await page.locator('[data-settings-category="legal"]').click();
    const panel = page.locator('.legal-notices-panel');
    await expect(panel).toBeVisible();
    await panel.getByText('阅读 Apache-2.0 许可证').click();
    await panel.getByText('阅读第三方声明').click();
    await expect
      .poll(() => panel.locator('details').nth(0).locator('pre').textContent(), {
        intervals: [10, 20, 50, 100],
      })
      .toBe(await readFile(resolve('LICENSE'), 'utf8'));
    expect(await panel.locator('details').nth(0).locator('pre').textContent()).toBe(
      await readFile(resolve('LICENSE'), 'utf8'),
    );
    await expect
      .poll(() => panel.locator('details').nth(1).locator('pre').textContent(), {
        intervals: [10, 20, 50, 100],
      })
      .toBe(await readFile(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8'));
    expect(await panel.locator('details').nth(1).locator('pre').textContent()).toBe(
      await readFile(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8'),
    );
    const topDetails = panel.locator(':scope > details');
    const detailsWithSummary = (name: string) => {
      const exactName = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
      return topDetails.filter({
        has: page.locator(':scope > summary', { hasText: exactName }),
      });
    };
    expect(
      (await topDetails.locator(':scope > summary').allTextContents())
        .filter((name) => name.endsWith('.txt'))
        .sort(),
    ).toEqual(licenseDocuments);
    expect(licenseDocuments).toContain('isarray-README.txt');
    expect(licenseDocuments).toContain('trzsz-js-LICENSE.txt');
    expect(licenseDocuments).toContain('chromium-dom-code-data-LICENSE.txt');
    const ironRdpDetails = detailsWithSummary('IronRDP-LICENSE-APACHE.txt');
    await ironRdpDetails.locator(':scope > summary').click();
    await expect(ironRdpDetails.locator('pre')).toBeVisible();
    for (const name of licenseDocuments) {
      const details = detailsWithSummary(name);
      if (!(await details.evaluate((element: HTMLDetailsElement) => element.open))) {
        await details.locator(':scope > summary').click();
      }
      await expect
        .poll(() => details.locator('pre').textContent(), { intervals: [10, 20, 50, 100] })
        .toBe(await readFile(resolve('licenses', name), 'utf8'));
      await expect(details.locator('pre')).toBeVisible();
      expect(await details.locator('pre').textContent()).toBe(
        await readFile(resolve('licenses', name), 'utf8'),
      );
    }
    const runtimeLicenseDetails = detailsWithSummary('查看 Electron 与 Chromium 声明');
    await runtimeLicenseDetails.locator(':scope > summary').click();
    const electronRuntimeDetails = runtimeLicenseDetails.locator('details').filter({
      has: page.locator('summary', { hasText: 'Electron 许可证' }),
    });
    await electronRuntimeDetails.locator('summary').click();
    await expect(
      page.frameLocator('iframe[title="Electron 许可证"]').locator('body'),
    ).toContainText('Electron contributors');
    const chromiumRuntimeDetails = runtimeLicenseDetails.locator('details').filter({
      has: page.locator('summary', { hasText: 'Chromium 声明' }),
    });
    const chromiumResponse = page.waitForResponse(
      (response) => response.url() === 'axterm-app://app/desktop/licenses/chromium',
    );
    await chromiumRuntimeDetails.locator('summary').click();
    const response = await chromiumResponse;
    expect(response.status()).toBe(200);
    expect(Number(response.headers()['content-length'])).toBeGreaterThan(1_000_000);
    await chromiumRuntimeDetails.locator('summary').click();
    const componentDetails = detailsWithSummary('THIRD_PARTY_COMPONENTS.json');
    await componentDetails.locator('summary').click();
    await expect(componentDetails.locator('summary')).toHaveText('THIRD_PARTY_COMPONENTS.json');
    await expect
      .poll(() => componentDetails.locator('pre').textContent(), { intervals: [10, 20, 50, 100] })
      .toBe(await readFile(resolve('compliance/THIRD_PARTY_COMPONENTS.json'), 'utf8'));
    expect(await componentDetails.locator('pre').textContent()).toBe(
      await readFile(resolve('compliance/THIRD_PARTY_COMPONENTS.json'), 'utf8'),
    );
    const sbomDetails = detailsWithSummary('AXTERM_PRODUCTION_DEPENDENCIES.spdx.json');
    await sbomDetails.locator('summary').click();
    await expect(sbomDetails.locator('summary')).toHaveText(
      'AXTERM_PRODUCTION_DEPENDENCIES.spdx.json',
    );
    await expect
      .poll(() => sbomDetails.locator('pre').textContent(), { intervals: [10, 20, 50, 100] })
      .toBe(await readFile(resolve('compliance/AXTERM_PRODUCTION_DEPENDENCIES.spdx.json'), 'utf8'));
    expect(await sbomDetails.locator('pre').textContent()).toBe(
      await readFile(resolve('compliance/AXTERM_PRODUCTION_DEPENDENCIES.spdx.json'), 'utf8'),
    );
    const licenseTextsDetails = detailsWithSummary('THIRD_PARTY_LICENSE_TEXTS.json');
    await licenseTextsDetails.locator('summary').first().click();
    await expect(licenseTextsDetails.locator('summary').first()).toHaveText(
      'THIRD_PARTY_LICENSE_TEXTS.json',
    );
    const archive = JSON.parse(
      await readFile(resolve('compliance/THIRD_PARTY_LICENSE_TEXTS.json'), 'utf8'),
    ) as {
      limitations: string[];
      missingCopyrightDeclarations: Array<{ name: string; version: string }>;
      components: Array<{
        name: string;
        version: string;
        files: Array<{ name: string; content: string }>;
        attribution: {
          manifestPublisherRecords: Array<{
            field: 'author' | 'contributors';
            value: string | Record<string, unknown>;
          }>;
          manifestCopyright: string | null;
          rootLicenseCopyrightLines: Array<{ file: string; line: string }>;
        };
      }>;
    };
    const attributionDetails = licenseTextsDetails.locator('details').filter({
      has: page.locator('summary', { hasText: '查看软件包署名元数据' }),
    });
    await attributionDetails.locator('summary').click();
    expect(await attributionDetails.locator('pre').textContent()).toBe(
      JSON.stringify(
        {
          source:
            'Package manifest author/contributor and copyright fields plus copyright lines extracted from installed root LICENSE/COPYING/NOTICE files.',
          reviewQueue: archive.missingCopyrightDeclarations,
          components: archive.components.map(({ name, version, attribution }) => ({
            name,
            version,
            ...attribution,
          })),
          limitations: archive.limitations,
        },
        null,
        2,
      ),
    );
    for (const name of ['@fontsource/maple-mono', 'spice-client', 'ssh2']) {
      const component = archive.components.find((entry) => entry.name === name);
      expect(component?.files.length).toBeGreaterThan(0);
      const file = component?.files[0];
      if (!component || !file) throw new Error(`Missing packaged license text for ${name}`);
      const details = licenseTextsDetails.locator('details').filter({
        has: page.locator('summary', {
          hasText: `${component.name}@${component.version}/${file.name}`,
        }),
      });
      await details.locator('summary').click();
      expect(await details.locator('pre').textContent()).toBe(file.content);
    }
    await page.locator('[data-settings-category="common"]').click();
    await expect(panel).toBeHidden();
  } finally {
    await closeLevel3Desktop(app);
    await rm(directory, { recursive: true, force: true });
  }
});
