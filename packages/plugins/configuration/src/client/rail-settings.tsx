import { useState, useSyncExternalStore } from 'react';

import type { SettingsModel } from './index.ts';
import type { BehaviorPreferenceCommands } from './behavior-commands.ts';
import type { PropsLocale } from '@axterm/ui';
import type { Settings } from '@axterm/plugin-api/configuration';
type ActivityRailItem = Settings['workspace']['activityRailItems'][number];
import { Check, ChevronDown, ChevronUp, GripVertical } from 'lucide-react';

import {
  orderedActivityRailItems,
  VISIBLE_ACTIVITY_RAIL_ITEM_IDS,
  type VisibleActivityRailItem,
} from './rail-policy.ts';
import styles from './behavior.module.css';
const cls = (...names: string[]) =>
  names.map((name) => name + ' ' + (styles[name] ?? '')).join(' ');

const translationKeys: Record<VisibleActivityRailItem, 'newBookmark' | 'bookmarks' | 'setting'> = {
  newBookmark: 'newBookmark',
  bookmarks: 'bookmarks',
  setting: 'setting',
};

function moveItem(
  items: readonly ActivityRailItem[],
  item: ActivityRailItem,
  offset: -1 | 1,
): ActivityRailItem[] {
  const next = [...items];
  const index = next.indexOf(item);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function ActivityRailSettingsPanel({
  model,
  commands,
  t,
}: {
  model: SettingsModel;
  commands: BehaviorPreferenceCommands;
  t: PropsLocale<'activityRail'>['t'];
}) {
  const facts = useSyncExternalStore(model.subscribe, model.getSnapshot),
    command = useSyncExternalStore(commands.subscribe, commands.getSnapshot),
    settings = { data: facts.status === 'ready' ? facts.baseline.settings : undefined },
    busy = command.busy || command.uncertain,
    x = t;
  const [message, setMessage] = useState('');
  const selected = orderedActivityRailItems(settings.data);
  const orderedOptions = [
    ...selected,
    ...VISIBLE_ACTIVITY_RAIL_ITEM_IDS.filter((item) => !selected.includes(item)),
  ];

  async function save(items: ActivityRailItem[]) {
    if (!settings.data || busy || !items.length) return;
    setMessage('');
    try {
      await commands.save({ workspace: { activityRailItems: items } });
      setMessage(x('activityRail.saved'));
    } catch {
      setMessage(x('common.operationFailed'));
    }
  }

  function toggle(item: 'setting', checked: boolean) {
    if (checked) {
      void save([...selected, item]);
      return;
    }
    void save(selected.filter((candidate) => candidate !== item));
  }

  return (
    <section
      className={cls('surface', 'activity-rail-settings')}
      aria-label={x('activityRail.title')}
    >
      <header>
        <div>
          <small>{t('leftSideBarIcons')}</small>
          <h3>{x('activityRail.title')}</h3>
        </div>
        <span>
          {selected.length}/{VISIBLE_ACTIVITY_RAIL_ITEM_IDS.length}
        </span>
      </header>
      <p className={cls('hint')}>{x('activityRail.hint')}</p>
      <div className={cls('activity-rail-settings-list')}>
        {orderedOptions.map((item) => {
          const index = selected.indexOf(item);
          const checked = index >= 0;
          const label = t(translationKeys[item]);
          return (
            <div className={checked ? cls('enabled') : ''} data-activity-setting={item} key={item}>
              <GripVertical size={14} aria-hidden="true" />
              {item !== 'setting' ? (
                <span className={cls('activity-rail-fixed-item')}>
                  <Check size={14} aria-hidden="true" />
                  <span>{label}</span>
                </span>
              ) : (
                <label>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={busy}
                    onChange={(event) => toggle(item, event.currentTarget.checked)}
                  />
                  <span>{label}</span>
                </label>
              )}
              <div>
                <button
                  type="button"
                  aria-label={x('activityRail.moveUp', { item: label })}
                  disabled={busy || !checked || index === 0}
                  onClick={() => void save(moveItem(selected, item, -1))}
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  aria-label={x('activityRail.moveDown', { item: label })}
                  disabled={busy || !checked || index === selected.length - 1}
                  onClick={() => void save(moveItem(selected, item, 1))}
                >
                  <ChevronDown size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {command.uncertain && (
        <button
          disabled={command.busy}
          onClick={() => {
            void commands.retry().then(
              () => setMessage(t('activityRail.saved')),
              () => setMessage(t('common.operationFailed')),
            );
          }}
        >
          {t('common.retry')}
        </button>
      )}
      {message && <p className={cls('hint', 'activity-rail-settings-message')}>{message}</p>}
    </section>
  );
}
