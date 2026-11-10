import type { ReactNode } from 'react';
import { BookmarkPlus, BookOpen, Settings } from 'lucide-react';
import type { Context } from '@deepseek-ai/cordis';
import type { Settings as SettingsFacts } from '@axterm/plugin-api/configuration';
import type { WorkspaceSnapshot, WorkspaceUi } from '@axterm/ui/workspace';
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from '@axterm/ui/controls';
import { orderedActivityRailItems } from './rail-policy.ts';
import dictionaries from './rail-locales.json' with { type: 'json' };
import styles from './workspace.module.css';
const cls = (...names: string[]) =>
  names.map((name) => name + ' ' + (styles[name] ?? '')).join(' ');
const icons = { newBookmark: BookmarkPlus, bookmarks: BookOpen, setting: Settings };
export function ActivityRail({
  ctx,
  workspace,
  state,
  preferences,
  onError,
  leading,
}: {
  ctx: Context;
  workspace: WorkspaceUi;
  state: WorkspaceSnapshot;
  preferences: SettingsFacts['workspace'] | undefined;
  onError: () => void;
  leading?: ReactNode;
}) {
  const language = ctx.locale.getSnapshot().active;
  const text = dictionaries[language as keyof typeof dictionaries] ?? dictionaries.en;
  const primary = orderedActivityRailItems(
    preferences ? ({ workspace: preferences } as SettingsFacts) : undefined,
  );
  const run = (id: string) => void workspace.invokeAction(id).catch(onError);
  return (
    <TooltipProvider delayDuration={250}>
      {leading}
      {primary.map((item) => {
        const Icon = icons[item],
          label = text[item];
        return (
          <Tooltip key={item}>
            <TooltipTrigger asChild>
              <button
                className={cls(
                  'activity-item',
                  ...(item === 'bookmarks' && state.section === 'hosts' && state.sidebarOpen
                    ? ['active']
                    : []),
                )}
                data-activity-item={item}
                aria-label={label}
                onClick={() =>
                  item === 'newBookmark'
                    ? run('new-bookmark')
                    : item === 'setting'
                      ? run('settings.open.common')
                      : state.section === 'hosts' && state.sidebarOpen
                        ? workspace.toggleSidebar()
                        : workspace.selectSection('hosts')
                }
              >
                <Icon size={19} strokeWidth={1.65} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={8} className={cls('activity-rail-tooltip')}>
              {label}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </TooltipProvider>
  );
}
