import styles, { cssText } from './recovery.module.css';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import type {} from '@axterm/ui/workspace';
import { useSyncExternalStore } from 'react';
import {
  Button,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogFooter,
} from '@axterm/ui/controls';
import type { DesktopRuntimeModel } from './index.ts';
const dictionaries = {
  en: {
    title: 'Recovery mode',
    disabled:
      'All Profile-installed external code is disabled. Installed packages and user data are preserved.',
    detail:
      'Profile and home patches are not loaded. Keep and inspect any original patch and backups with Desktop stopped. Clearing recovery does not restore a backup automatically.',
    clear:
      'After review, quit Desktop. Run the bundled CLI with AXTERM_HOME set to this directory:',
    close: 'Close',
  },
  ja: {
    title: '復旧モード',
    disabled:
      'Profile にインストールされた外部コードはすべて無効です。パッケージとユーザーデータは保持されています。',
    detail:
      'Profile とホームのパッチは読み込みません。Desktop を終了し、元のパッチとバックアップを確認してください。復旧を解除しても自動復元されません。',
    clear:
      '確認後に Desktop を終了し、AXTERM_HOME を次のディレクトリに設定して同梱 CLI を実行してください:',
    close: '閉じる',
  },
  'zh-CN': {
    title: '恢复模式',
    disabled: '已禁用全部 Profile 安装的外部代码。安装包和用户数据均已保留。',
    detail:
      '当前不加载 Profile 和 home 补丁。请退出 Desktop，保留并检查原补丁和已有备份。解除恢复模式不会自动还原备份。',
    clear: '检查后退出 Desktop，将 AXTERM_HOME 设为以下目录，再运行内置 CLI：',
    close: '关闭',
  },
  'zh-TW': {
    title: '復原模式',
    disabled: '已停用全部 Profile 安裝的外部程式碼。安裝套件和使用者資料均已保留。',
    detail:
      '目前不載入 Profile 和 home 修補檔。請結束 Desktop，保留並檢查原修補檔與現有備份。解除復原模式不會自動還原備份。',
    clear: '檢查後結束 Desktop，將 AXTERM_HOME 設為以下目錄，再執行內建 CLI：',
    close: '關閉',
  },
};
declare module '@axterm/ui' {
  interface LocaleNamespaceMap {
    desktopRecovery: keyof typeof dictionaries.en;
  }
}
export function installRecoveryUi(ctx: Context, model: DesktopRuntimeModel): void {
  ctx.inject(['slots', 'locale'], (scope) => {
    scope.effect(() => {
      const style = document.createElement('style');
      style.dataset.plugin = '@axterm/plugin-desktop';
      style.textContent = cssText;
      document.head.append(style);
      return () => style.remove();
    });
    scope.effect(() => scope.locale.register('desktopRecovery', dictionaries));
    scope.slots.inject('workspace.toolbar', function* () {
      yield scope.slots.register(
        { name: 'workspace.toolbar', id: 'desktop.recovery', locale: 'desktopRecovery', order: 0 },
        function Recovery({ t }: PropsLocale<'desktopRecovery'>) {
          const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
          if (state.status !== 'ready' || !state.baseline.metadata.recoveryMode) return null;
          return (
            <Dialog>
              <DialogTrigger asChild>
                <Button data-desktop-recovery-trigger="">{t('title')}</Button>
              </DialogTrigger>
              <DialogContent
                data-desktop-recovery=""
                onOpenAutoFocus={(event) => {
                  event.preventDefault();
                  if (event.target instanceof HTMLElement) event.target.focus();
                }}
              >
                <DialogTitle>{t('title')}</DialogTitle>
                <DialogDescription>{t('disabled')}</DialogDescription>
                <p>{t('detail')}</p>
                <p>{t('clear')}</p>
                <p className={styles.command}>
                  <code data-recovery-home="">{state.baseline.metadata.recoveryHome}</code>
                </p>
                <p className={styles.command}>
                  <code data-recovery-command="">
                    axterm plugin --profile desktop recovery clear --confirm
                  </code>
                </p>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button>{t('close')}</Button>
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          );
        },
      );
    });
  });
}
