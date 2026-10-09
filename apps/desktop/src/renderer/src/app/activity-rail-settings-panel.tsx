import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type { ActivityRailItem } from '@workspace/contracts';
import { Check, ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import { useI18n } from '../i18n/context';
import {
  orderedActivityRailItems,
  VISIBLE_ACTIVITY_RAIL_ITEM_IDS,
  type VisibleActivityRailItem,
} from './activity-rail';
import './activity-rail-settings-panel.css';

type Client = ReturnType<typeof createRuntimeClient>;

const translationKeys: Record<VisibleActivityRailItem, string> = {
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

export function ActivityRailSettingsPanel({ client }: { client: Client }) {
  const { t, x } = useI18n();
  const settings = useQuery({ queryKey: ['settings'], queryFn: client.settings });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const selected = orderedActivityRailItems(settings.data);
  const orderedOptions = [
    ...selected,
    ...VISIBLE_ACTIVITY_RAIL_ITEM_IDS.filter((item) => !selected.includes(item)),
  ];

  async function save(items: ActivityRailItem[]) {
    if (!settings.data || busy || !items.length) return;
    setBusy(true);
    setMessage('');
    try {
      await client.updateSettings(settings.data, { workspace: { activityRailItems: items } });
      await settings.refetch();
      setMessage(x('activityRail.saved'));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : x('common.operationFailed'));
      await settings.refetch();
    } finally {
      setBusy(false);
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
    <section className="surface activity-rail-settings" aria-label={x('activityRail.title')}>
      <header>
        <div>
          <small>{t('leftSideBarIcons', 'LEFT SIDEBAR ICONS')}</small>
          <h3>{x('activityRail.title')}</h3>
        </div>
        <span>
          {selected.length}/{VISIBLE_ACTIVITY_RAIL_ITEM_IDS.length}
        </span>
      </header>
      <p className="hint">{x('activityRail.hint')}</p>
      <div className="activity-rail-settings-list">
        {orderedOptions.map((item) => {
          const index = selected.indexOf(item);
          const checked = index >= 0;
          const label = t(translationKeys[item], item);
          return (
            <div className={checked ? 'enabled' : ''} data-activity-setting={item} key={item}>
              <GripVertical size={14} aria-hidden="true" />
              {item !== 'setting' ? (
                <span className="activity-rail-fixed-item">
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
      {message && <p className="hint activity-rail-settings-message">{message}</p>}
    </section>
  );
}
