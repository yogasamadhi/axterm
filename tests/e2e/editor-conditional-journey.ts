import {
  setDesktopRemoteFault,
  desktopRemoteFaultAttempts,
} from '../support/level3-desktop-remote-fault';
import { selectLevel3Language } from '../support/level3-language';
import { openNewBookmark } from './settings-workspace-navigation';
import { expect, type Page, type ElectronApplication } from '@playwright/test';

const locales = [
  {
    id: 'en',
    hostDialog: 'Add SSH host',
    hostName: 'Display name',
    hostError: 'Unable to save the SSH host: Operation failed',
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
    hostError: 'SSH ホストを保存できませんでした：操作に失敗しました',
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
    hostError: '保存 SSH 主机失败：操作失败',
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
    hostError: '儲存 SSH 主機失敗：操作失敗',
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

export async function verifyFourLocaleEditorConditionalJourney(
  page: Page,
  app: ElectronApplication,
): Promise<void> {
  const paths: Record<Editor, string> = {
    ssh: '/api/catalog/createSshBookmark',
    ftp: '/api/catalog/createBookmark',
    profile: '/api/catalog/createConnectionProfile',
  };
  const attempts = (kind: Editor) => desktopRemoteFaultAttempts(app, paths[kind]);
  const fail = (kind: Editor, enabled: boolean) =>
    setDesktopRemoteFault(app, paths[kind], enabled, canary, {
      code: 'catalog/failure',
      reason: 'capacity',
    });
  for (const kind of ['ssh', 'ftp', 'profile'] as const) await fail(kind, false);
  for (const locale of locales) {
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('.settings-workspace-tabs button').nth(1).click();
    await page.locator('[data-settings-category="common"]').click();
    await selectLevel3Language(page, locale.id);
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
    const sshBefore = await attempts('ssh');
    await hostSave.click();
    await expect(host).toBeVisible();
    expect(
      await hostName.evaluate((element: HTMLInputElement) => element.validity.valueMissing),
    ).toBe(true);
    expect(await attempts('ssh')).toBe(sshBefore);
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
    await fail('ssh', true);
    await hostSave.click();
    await expect.poll(() => attempts('ssh')).toBe(sshBefore + 1);
    await expect(host).toBeVisible();
    await expect(host.getByRole('alert')).toHaveText(locale.hostError);
    await expect(page.getByText(canary)).toHaveCount(0);
    await assertHorizontalBounds(page);
    expect(await attempts('ssh')).toBe(sshBefore + 1);
    await fail('ssh', false);
    await hostSave.click();
    await expect(host).toBeHidden();
    await expect(page.locator('[data-section-chrome=settings]')).toBeVisible();
    await page.locator('[data-activity-item="bookmarks"]').click();
    await expect(page.locator('.app-shell')).toHaveClass(/section-hosts/);
    const manage = page.locator('.bookmark-explorer-title button');
    if (await manage.isVisible()) await manage.click();
    await expect(page.locator('.host-card').filter({ hasText: sshTitle })).toHaveCount(1);
    expect(await attempts('ssh')).toBe(sshBefore + 2);

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
    const ftpBefore = await attempts('ftp');
    await ftpSave.click();
    await expect(ftp).toBeVisible();
    expect(
      await ftpName.evaluate((element: HTMLInputElement) => element.validity.valueMissing),
    ).toBe(true);
    expect(await attempts('ftp')).toBe(ftpBefore);
    const ftpTitle = `s2-ftp-${locale.id}`;
    await ftpName.fill(ftpTitle);
    await ftp.locator('input[name="hostname"]').fill('ftp.example.test');
    await fail('ftp', true);
    await ftpSave.click();
    await expect(ftp.getByRole('alert')).toHaveText(locale.ftpError);
    await expect(page.getByText(canary)).toHaveCount(0);
    await assertHorizontalBounds(page);
    expect(await attempts('ftp')).toBe(ftpBefore + 1);
    await fail('ftp', false);
    await ftpSave.click();
    await expect(ftp).toBeHidden();
    await expect(
      page.locator('[data-bookmark-protocol="ftp"]').filter({ hasText: ftpTitle }),
    ).toHaveCount(1);
    expect(await attempts('ftp')).toBe(ftpBefore + 2);

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
    const profileBefore = await attempts('profile');
    await profileSave.click();
    expect(
      await profileName.evaluate((element: HTMLInputElement) => element.validity.valueMissing),
    ).toBe(true);
    expect(await attempts('profile')).toBe(profileBefore);
    const profileTitle = `s2-profile-${locale.id}`;
    await profileName.fill(profileTitle);
    await fail('profile', true);
    await profileSave.click();
    const message = page.locator('.connection-profile-message');
    await expect(message).toHaveAttribute('role', 'status');
    await expect(message).toHaveText(locale.profileError);
    await message.scrollIntoViewIfNeeded();
    await expect(message).toBeInViewport();
    await expect(page.getByText(canary)).toHaveCount(0);
    await assertHorizontalBounds(page);
    expect(await attempts('profile')).toBe(profileBefore + 1);
    await fail('profile', false);
    await profileSave.click();
    await expect(message).toHaveText(locale.profileSaved);
    await expect(page.locator('.connection-profile-list').getByText(profileTitle)).toHaveCount(1);
    expect(await attempts('profile')).toBe(profileBefore + 2);
  }
}
