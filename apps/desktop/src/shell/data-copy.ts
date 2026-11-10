import { app, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  homeCopyReceiptSchema,
  homeCopyResultSchema,
  type HomeCopyResult,
} from '@axterm/desktop-host/protocol';
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
async function state(home: string) {
  const path = join(home, 'level3-data-copy.json');
  if (!(await exists(path))) return;
  const value = await lstat(path);
  if (!value.isFile() || value.isSymbolicLink() || value.size > 4096)
    throw Error('DATA_COPY_INVALID_JOURNAL');
  return homeCopyReceiptSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
/** Shell-only preflight. No Vault or Host may start with an incomplete migration marker. */
export async function assertShellHomeReady(home: string): Promise<void> {
  const value = await state(home);
  const names = await readdir(home).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (
    names.some(
      (name) => name.startsWith('.level3-copy-') && (!value || name !== '.level3-copy-' + value.id),
    )
  )
    throw Error('DATA_COPY_RECOVERY_REQUIRED');
  if (
    value &&
    (value.state !== 'committed' ||
      value.published.length !== 3 ||
      new Set(value.published).size !== 3)
  )
    throw Error('DATA_COPY_RECOVERY_REQUIRED');
  if (value)
    for (const entry of ['data-v2', 'vault-v2', 'desktop']) {
      const root = join(home, entry),
        status = await lstat(root),
        marker = join(root, '.level3-data-copy-owner');
      if (!status.isDirectory() || status.isSymbolicLink())
        throw Error('DATA_COPY_INCOMPLETE_TARGET');
      const file = await lstat(marker);
      if (
        !file.isFile() ||
        file.isSymbolicLink() ||
        file.size !== 36 ||
        (await readFile(marker, 'utf8')) !== value.id
      )
        throw Error('DATA_COPY_INCOMPLETE_TARGET');
    }
}
export function runHomeCopyWorker(input: {
  home: string;
  source: string;
  action: 'copy' | 'resume' | 'retry';
  entry: string;
  environment: NodeJS.ProcessEnv;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--expose-internals', input.entry, '--data-copy'], {
      env: { ...input.environment, ELECTRON_RUN_AS_NODE: '1', AXTERM_HOME: input.home },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    let received: HomeCopyResult | undefined,
      failed = false;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      failed = true;
      child.kill();
    }, 10 * 60_000);
    child.on('message', (message) => {
      const parsed = homeCopyResultSchema.safeParse(message);
      if (!parsed.success || received !== undefined) {
        failed = true;
        child.kill();
        return;
      }
      received = parsed.data;
    });
    child.once('error', () => {
      failed = true;
    });
    child.once('close', (code) =>
      finish(
        !failed && code === 0 && received?.ok === true
          ? undefined
          : Error(received?.ok === false ? received.code : 'DATA_COPY_RECOVERY_REQUIRED'),
      ),
    );
    child.send(
      {
        kind: 'axterm-home-copy',
        version: 1,
        source: input.source,
        home: input.home,
        action: input.action,
      },
      (error) => {
        if (error) {
          failed = true;
          child.kill();
        }
      },
    );
  });
}
const messages = {
  en: {
    title: 'Axterm data migration',
    close: 'Quit the previous Axterm before continuing.',
    retry: 'Try again',
    quit: 'Quit',
    copy: 'Copy data',
    resume: 'Resume',
    rebuild: 'Retry unpublished copy',
    source: 'Select current Axterm data folder',
    confirm: 'Copy the current Axterm data into the new home?',
    detail:
      'The original is retained. Credentials and references are verified before publishing. Unfinished tasks and old approvals will not run again.',
    failed: 'Data migration requires recovery. Your original data is retained.',
    conflict:
      'The target already exists. Keep it backed up and choose a different AXTERM_HOME before copying.',
  },
  'zh-CN': {
    title: 'Axterm 数据迁移',
    close: '请先退出旧版 Axterm 再继续。',
    retry: '重试',
    quit: '退出',
    copy: '复制数据',
    resume: '继续恢复',
    rebuild: '重试未发布的复制',
    source: '选择当前 Axterm 数据目录',
    confirm: '将当前 Axterm 数据复制到新 home？',
    detail: '保留原目录；发布前验证凭据和引用关系。未完成任务与旧审批不会重放。',
    failed: '数据迁移需要恢复。原数据保留不变。',
    conflict: '目标已存在。请保留备份并选择其他 AXTERM_HOME 后再复制。',
  },
  'zh-TW': {
    title: 'Axterm 資料遷移',
    close: '請先退出舊版 Axterm 再繼續。',
    retry: '重試',
    quit: '退出',
    copy: '複製資料',
    resume: '繼續恢復',
    rebuild: '重試未發布的複製',
    source: '選擇目前 Axterm 資料目錄',
    confirm: '將目前 Axterm 資料複製到新 home？',
    detail: '保留原目錄；發布前驗證憑證和引用關係。未完成工作與舊核准不會重播。',
    failed: '資料遷移需要恢復。原資料保留不變。',
    conflict: '目標已存在。請保留備份並選擇其他 AXTERM_HOME 後再複製。',
  },
  ja: {
    title: 'Axterm データ移行',
    close: '以前の Axterm を終了してから続行してください。',
    retry: '再試行',
    quit: '終了',
    copy: 'データをコピー',
    resume: '復旧を続行',
    rebuild: '未公開コピーを再試行',
    source: '現在の Axterm データフォルダを選択',
    confirm: '現在の Axterm データを新しい home にコピーしますか？',
    detail:
      '元のデータは保持されます。公開前に認証情報と参照を検証します。未完了タスクと以前の承認は再実行しません。',
    failed: 'データ移行の復旧が必要です。元のデータは保持されています。',
    conflict: '移行先が既に存在します。バックアップを保持し、別の AXTERM_HOME を選択してください。',
  },
};
const failureOrder = [
  'DATA_COPY_RECOVERY_REQUIRED',
  'DATA_COPY_NO_SPACE',
  'DATA_COPY_SOURCE_INVALID',
  'DATA_COPY_TARGET_CONFLICT',
  'DATA_COPY_VAULT_INVALID',
  'DATA_COPY_MISSING_REFERENCE',
  'DATA_COPY_SOURCE_CHANGED',
];
const failureText = {
  en: [
    'Keep the migration journal and retry recovery.',
    'Free space on the destination disk before retrying.',
    'Select the current generation-2 Axterm folder with a complete database.',
    'Keep the existing target backed up and choose another home.',
    'Restore the complete original Vault backup before retrying.',
    'A retained credential, image or theme reference is missing. Restore the complete source backup.',
    'The original or prepared copy changed. Keep both directories and recover from a consistent backup.',
  ],
  'zh-CN': [
    '保留迁移标记并重试恢复。',
    '请先释放目标磁盘空间，再重试。',
    '请选择包含完整数据库的当前 generation-2 Axterm 目录。',
    '保留现有目标的备份并选择其他 home。',
    '请先恢复完整的原 Vault 备份，再重试。',
    '缺少保留的凭据、图片或主题引用；请恢复完整源备份。',
    '原目录或已准备的副本发生变化；请保留两者并从一致备份恢复。',
  ],
  'zh-TW': [
    '保留遷移標記並重試恢復。',
    '請先釋放目標磁碟空間，再重試。',
    '請選擇包含完整資料庫的目前 generation-2 Axterm 目錄。',
    '保留現有目標的備份並選擇其他 home。',
    '請先恢復完整的原 Vault 備份，再重試。',
    '缺少保留的憑證、圖片或主題引用；請恢復完整來源備份。',
    '原目錄或已準備的副本發生變化；請保留兩者並從一致備份恢復。',
  ],
  ja: [
    '移行ジャーナルを保持して復旧を再試行してください。',
    '移行先ディスクの空き容量を確保してから再試行してください。',
    '完全なデータベースを含む現行 generation-2 Axterm フォルダを選択してください。',
    '既存の移行先をバックアップし、別の home を選択してください。',
    '元の Vault の完全なバックアップを復元してから再試行してください。',
    '認証情報、画像、テーマの参照が不足しています。完全な移行元バックアップを復元してください。',
    '移行元または準備済みコピーが変更されました。両方を保持し、一貫したバックアップから復旧してください。',
  ],
};
/** Acquires the legacy singleton before migration, then switches to the new home's singleton. */
export async function prepareShellHome(options: {
  home: string;
  source?: string;
  bootstrap: string;
  entry: string;
  environment: NodeJS.ProcessEnv;
}): Promise<boolean> {
  await app.whenReady();
  const language = app.getPreferredSystemLanguages()[0] ?? 'en';
  const key =
    language.startsWith('zh-TW') || language.startsWith('zh-HK')
      ? 'zh-TW'
      : language.startsWith('zh')
        ? 'zh-CN'
        : language.startsWith('ja')
          ? 'ja'
          : 'en';
  const text = messages[key];
  let current: Awaited<ReturnType<typeof state>>,
    source = options.source;
  try {
    current = await state(options.home);
  } catch {
    await dialog.showMessageBox({
      type: 'error',
      title: text.title,
      message: text.failed,
      buttons: [text.quit],
    });
    return false;
  }
  if (current?.state === 'committed') {
    try {
      await assertShellHomeReady(options.home);
    } catch {
      await dialog.showMessageBox({
        type: 'error',
        title: text.title,
        message: text.failed,
        buttons: [text.quit],
      });
      return false;
    }
    source = undefined;
  } else if (source && !(await exists(join(source, 'data-v2/axterm.sqlite')))) source = undefined;
  if (current && current.state !== 'committed' && !source) {
    await app.whenReady();
    const selected = await dialog.showOpenDialog({
      title: text.source,
      properties: ['openDirectory'],
    });
    if (selected.canceled || selected.filePaths.length !== 1) return false;
    source = selected.filePaths[0];
  }
  let legacy = false;
  try {
    if (source) {
      for (;;) {
        // Swap only while acquiring the native singleton. Chromium keeps the private bootstrap root.
        app.setPath('userData', source);
        legacy = app.requestSingleInstanceLock();
        app.setPath('userData', options.bootstrap);
        if (legacy) break;
        await app.whenReady();
        const choice = await dialog.showMessageBox({
          type: 'warning',
          title: text.title,
          message: text.close,
          buttons: [text.retry, text.quit],
          cancelId: 1,
          defaultId: 0,
        });
        if (choice.response !== 0) return false;
      }
      await app.whenReady();
      if (
        !current &&
        (
          await Promise.all(
            ['data-v2', 'vault-v2', 'desktop'].map((entry) => exists(join(options.home, entry))),
          )
        ).some(Boolean)
      ) {
        await dialog.showMessageBox({
          type: 'error',
          title: text.title,
          message: text.conflict,
          buttons: [text.quit],
        });
        return false;
      }
      const choice = await dialog.showMessageBox({
        type: 'question',
        title: text.title,
        message: current ? text.failed : text.confirm,
        detail: text.detail,
        buttons: [
          current?.state === 'copying' ? text.rebuild : current ? text.resume : text.copy,
          text.quit,
        ],
        cancelId: 1,
        defaultId: 0,
      });
      if (choice.response !== 0) return false;
      for (;;) {
        try {
          await runHomeCopyWorker({
            ...options,
            source,
            action: current?.state === 'copying' ? 'retry' : current ? 'resume' : 'copy',
          });
          break;
        } catch (error) {
          const index = failureOrder.indexOf(error instanceof Error ? error.message : '');
          current = await state(options.home);
          const response = await dialog.showMessageBox({
            type: 'error',
            title: text.title,
            message: text.failed,
            detail: text.detail + '\n' + failureText[key][Math.max(0, index)],
            buttons: [current?.state === 'copying' ? text.rebuild : text.resume, text.quit],
            cancelId: 1,
            defaultId: 0,
          });
          if (response.response !== 0) return false;
        }
      }
    }
  } finally {
    if (legacy) app.releaseSingleInstanceLock();
  }
  try {
    await assertShellHomeReady(options.home);
  } catch {
    await dialog.showMessageBox({
      type: 'error',
      title: text.title,
      message: text.failed,
      buttons: [text.quit],
    });
    return false;
  }
  await mkdir(join(options.home, 'desktop'), { recursive: true, mode: 0o700 });
  app.setPath('userData', join(options.home, 'desktop'));
  return app.requestSingleInstanceLock();
}
