import { openNewBookmark } from './settings-workspace-navigation';
import { expect, type Page } from '@playwright/test';

const locales = [
  {
    id: 'en',
    hostDialog: 'Add SSH host',
    hostName: 'Display name',
    hostError: 'Unable to complete the SSH host action. Check the connection and retry.',
    ftpDialog: 'Add FTP/FTPS bookmark',
    ftpName: 'Name',
    ftpError: 'Unable to save the FTP/FTPS bookmark. Try again.',
    profileTab: 'Terminal profiles',
    profileName: 'Profile name',
    profileSave: 'Save profile',
    profileError: 'Connection-profile operation failed',
    profileSaved: 'Connection profile saved.',
  },
  {
    id: 'ja',
    hostDialog: 'SSH ホストを追加',
    hostName: '表示名',
    hostError: 'SSH ホストの操作を完了できませんでした。接続を確認して再試行してください。',
    ftpDialog: 'FTP/FTPS ブックマークを追加',
    ftpName: '名前',
    ftpError: 'FTP/FTPS ブックマークを保存できませんでした。再試行してください。',
    profileTab: 'ターミナルプロファイル',
    profileName: 'プロファイル名',
    profileSave: 'プロファイルを保存',
    profileError: '接続プロファイルの操作に失敗しました',
    profileSaved: '接続プロファイルを保存しました。',
  },
  {
    id: 'zh-CN',
    hostDialog: '添加 SSH 主机',
    hostName: '显示名称',
    hostError: '无法完成 SSH 主机操作，请检查连接后重试。',
    ftpDialog: '添加 FTP/FTPS 书签',
    ftpName: '名称',
    ftpError: '无法保存 FTP/FTPS 书签，请重试。',
    profileTab: '终端配置',
    profileName: '连接配置名称',
    profileSave: '保存配置',
    profileError: '连接配置操作失败',
    profileSaved: '连接配置已保存。',
  },
  {
    id: 'zh-TW',
    hostDialog: '新增 SSH 主機',
    hostName: '顯示名稱',
    hostError: '無法完成 SSH 主機操作。請檢查連線後重試。',
    ftpDialog: '新增 FTP/FTPS 書籤',
    ftpName: '名稱',
    ftpError: '無法儲存 FTP/FTPS 書籤，請重試。',
    profileTab: '終端機設定檔',
    profileName: '設定檔名稱',
    profileSave: '儲存設定檔',
    profileError: '連線設定檔操作失敗',
    profileSaved: '連線設定檔已儲存。',
  },
] as const;

type Editor = 'ssh' | 'ftp' | 'profile';
const canary = 's2-editor-secret-canary-do-not-display';
const failureBody = JSON.stringify({
  type: 'about:blank',
  title: 'Synthetic editor failure',
  status: 500,
  detail: canary,
});

async function assertHorizontalBounds(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth + 1),
    )
    .toBe(true);
}

async function assertDialogBounds(page: Page, selector: string): Promise<void> {
  const bounds = await page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(-1);
  expect(bounds.top).toBeGreaterThanOrEqual(-1);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width + 1);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height + 1);
}

export async function verifyFourLocaleEditorConditionalJourney(page: Page): Promise<void> {
  const failures: Record<Editor, boolean> = { ssh: false, ftp: false, profile: false };
  const attempts: Record<Editor, number> = { ssh: 0, ftp: 0, profile: 0 };
  const paths: Record<Editor, string> = {
    ssh: '**/api/v1/ssh-bookmarks',
    ftp: '**/api/v1/bookmarks',
    profile: '**/api/v1/connection-profiles',
  };
  for (const kind of ['ssh', 'ftp', 'profile'] as const) {
    await page.route(paths[kind], async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      attempts[kind] += 1;
      if (failures[kind]) {
        await route.fulfill({
          status: 500,
          contentType: 'application/problem+json',
          body: failureBody,
        });
        return;
      }
      await route.continue();
    });
  }

  for (const locale of locales) {
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('.settings-workspace-tabs button').nth(1).click();
    await page.locator('[data-settings-category="common"]').click();
    await page.getByTestId('application-language').selectOption(locale.id);
    await expect(page.locator('html')).toHaveAttribute('lang', locale.id);

    await openNewBookmark(page);
    const host = page.getByRole('dialog', { name: locale.hostDialog });
    await expect(host).toBeVisible();
    await assertDialogBounds(page, '.host-bookmark-modal');
    const hostName = host.locator('input[name="name"]');
    await expect(hostName).toHaveAttribute('aria-label', locale.hostName);
    const hostSave = host.locator('button[value="save"]');
    await hostSave.scrollIntoViewIfNeeded();
    await expect(hostSave).toBeInViewport();
    const sshBefore = attempts.ssh;
    await hostSave.click();
    await expect(host).toBeVisible();
    expect(
      await hostName.evaluate((element: HTMLInputElement) => element.validity.valueMissing),
    ).toBe(true);
    expect(attempts.ssh).toBe(sshBefore);
    const sshTitle = `s2-ssh-${locale.id}`;
    await hostName.fill(sshTitle);
    await host.locator('input[name="hostname"]').fill('ssh.example.test');
    await host.locator('input[name="username"]').fill('s2-user');
    expect(
      await host.locator('form').evaluate((form: HTMLFormElement) =>
        Array.from(form.elements)
          .filter(
            (element) =>
              (element instanceof HTMLInputElement ||
                element instanceof HTMLSelectElement ||
                element instanceof HTMLTextAreaElement) &&
              !element.validity.valid,
          )
          .map((element) => (element as HTMLInputElement).name),
      ),
    ).toEqual([]);
    failures.ssh = true;
    await hostSave.click();
    await expect.poll(() => attempts.ssh).toBe(sshBefore + 1);
    await expect(host).toBeVisible();
    await expect(host.getByRole('alert')).toHaveText(locale.hostError);
    await expect(page.getByText(canary)).toHaveCount(0);
    await assertHorizontalBounds(page);
    expect(attempts.ssh).toBe(sshBefore + 1);
    failures.ssh = false;
    await hostSave.click();
    await expect(host).toBeHidden();
    await expect(page.locator('.settings-workspace')).toBeVisible();
    await page.locator('[data-activity-item="bookmarks"]').click();
    await expect(page.locator('.app-shell')).toHaveClass(/section-hosts/);
    const manage = page.locator('.bookmark-explorer-title button');
    if (await manage.isVisible()) await manage.click();
    await expect(page.locator('.host-card').filter({ hasText: sshTitle })).toHaveCount(1);
    expect(attempts.ssh).toBe(sshBefore + 2);

    await openNewBookmark(page);
    await page.locator('.host-bookmark-modal [data-bookmark-protocol="ftp"]').click();
    const ftp = page.getByRole('dialog', { name: locale.ftpDialog });
    await expect(ftp).toBeVisible();
    await assertDialogBounds(page, '.protocol-bookmark-modal');
    const ftpName = ftp.locator('input[name="name"]');
    await expect(ftpName).toHaveAccessibleName(locale.ftpName);
    const ftpSave = ftp.locator('button[value="save"]');
    await ftpSave.scrollIntoViewIfNeeded();
    await expect(ftpSave).toBeInViewport();
    const ftpBefore = attempts.ftp;
    await ftpSave.click();
    await expect(ftp).toBeVisible();
    expect(
      await ftpName.evaluate((element: HTMLInputElement) => element.validity.valueMissing),
    ).toBe(true);
    expect(attempts.ftp).toBe(ftpBefore);
    const ftpTitle = `s2-ftp-${locale.id}`;
    await ftpName.fill(ftpTitle);
    await ftp.locator('input[name="hostname"]').fill('ftp.example.test');
    failures.ftp = true;
    await ftpSave.click();
    await expect(ftp.getByRole('alert')).toHaveText(locale.ftpError);
    await expect(page.getByText(canary)).toHaveCount(0);
    await assertHorizontalBounds(page);
    expect(attempts.ftp).toBe(ftpBefore + 1);
    failures.ftp = false;
    await ftpSave.click();
    await expect(ftp).toBeHidden();
    await expect(
      page.locator('[data-bookmark-protocol="ftp"]').filter({ hasText: ftpTitle }),
    ).toHaveCount(1);
    expect(attempts.ftp).toBe(ftpBefore + 2);

    await page.locator('[data-activity-item="setting"]').click();
    await page
      .locator('.settings-workspace-tabs')
      .getByRole('button', { name: locale.profileTab, exact: true })
      .click();
    await expect(page.locator('.connection-profile-list p.hint')).toHaveCount(0);
    const profile = page.getByTestId('connection-profile-form');
    const profileName = profile.locator('input[name="name"]');
    await expect(profileName).toHaveAttribute('aria-label', locale.profileName);
    const profileSave = profile.getByRole('button', { name: locale.profileSave });
    await profileSave.scrollIntoViewIfNeeded();
    await expect(profileSave).toBeInViewport();
    const profileBefore = attempts.profile;
    await profileSave.click();
    expect(
      await profileName.evaluate((element: HTMLInputElement) => element.validity.valueMissing),
    ).toBe(true);
    expect(attempts.profile).toBe(profileBefore);
    const profileTitle = `s2-profile-${locale.id}`;
    await profileName.fill(profileTitle);
    failures.profile = true;
    await profileSave.click();
    const message = page.locator('.connection-profile-message');
    await expect(message).toHaveAttribute('role', 'status');
    await expect(message).toHaveText(locale.profileError);
    await message.scrollIntoViewIfNeeded();
    await expect(message).toBeInViewport();
    await expect(page.getByText(canary)).toHaveCount(0);
    await assertHorizontalBounds(page);
    expect(attempts.profile).toBe(profileBefore + 1);
    failures.profile = false;
    await profileSave.click();
    await expect(message).toHaveText(locale.profileSaved);
    await expect(page.locator('.connection-profile-list').getByText(profileTitle)).toHaveCount(1);
    expect(attempts.profile).toBe(profileBefore + 2);
  }
}
