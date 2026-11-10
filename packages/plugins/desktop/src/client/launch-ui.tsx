import { DesktopStartup } from './startup.ts';
import { useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@axterm/ui/workspace';
import { Button } from '@axterm/ui/controls';
import { DesktopLaunchModel } from './launches.ts';
export function installDesktopLaunchUi(ctx: Context): void {
  ctx.inject(['desktopWindow', 'sessionLaunchUi', 'slots', 'locale'], (owner) => {
    const model = new DesktopLaunchModel(owner, owner.desktopWindow.id, (source, signal) =>
      owner.sessionLaunchUi.launch(source, signal),
    );
    owner.effect(() => () => model.close());
    const startup = new DesktopStartup(owner, owner.desktopWindow.id);
    owner.provide('desktopStartupUi', startup);
    owner.effect(() => () => startup.close());
    owner.slots.inject('workspace.overlay', function* () {
      yield owner.slots.register(
        { name: 'workspace.overlay', id: 'desktop.launch-status' },
        function LaunchStatus() {
          const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
          if (!state.failed) return null;
          return (
            <div role="alert">
              <span>
                {owner.locale.resolveText({
                  en: 'Unable to complete the Desktop launch request. Submit it again to retry.',
                  ja: 'Desktop の起動要求を完了できませんでした。再試行するにはもう一度送信してください。',
                  'zh-CN': '桌面启动请求未能完成。请重新提交启动请求。',
                  'zh-TW': '桌面啟動請求未能完成。請重新提交啟動請求。',
                })}
              </span>
              <Button
                onClick={() => {
                  if (state.status === 'error') void model.retry().catch(() => {});
                  else model.dismiss();
                }}
              >
                {owner.locale.resolveText(
                  state.status === 'error'
                    ? { en: 'Reconnect', ja: '再接続', 'zh-CN': '重新连接', 'zh-TW': '重新連線' }
                    : { en: 'Dismiss', ja: '閉じる', 'zh-CN': '关闭', 'zh-TW': '關閉' },
                )}
              </Button>
            </div>
          );
        },
      );
    });
  });
}
