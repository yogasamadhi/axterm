import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import { ACTIVITY_RAIL_ITEM_IDS, type ActivityRailItem } from '@workspace/contracts';
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import { useI18n } from '../i18n/context';
import './activity-rail-settings-panel.css';

type Client = ReturnType<typeof createRuntimeClient>;

const translationKeys: Record<ActivityRailItem, string> = {
  newBookmark: 'newBookmark',
  quickConnect: 'quickConnect',
  bookmarks: 'bookmarks',
  terminalThemes: 'terminalThemes',
  setting: 'setting',
  settingSync: 'settingSync',
  widgets: 'widgets',
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
  const selected = settings.data?.workspace.activityRailItems ?? [];
  const orderedOptions = [
    ...selected,
    ...ACTIVITY_RAIL_ITEM_IDS.filter((item) => !selected.includes(item)),
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

  function toggle(item: ActivityRailItem, checked: boolean) {
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
        <span>{selected.length}/7</span>
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
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busy || (checked && selected.length === 1)}
                  onChange={(event) => toggle(item, event.currentTarget.checked)}
                />
                <span>{label}</span>
              </label>
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
