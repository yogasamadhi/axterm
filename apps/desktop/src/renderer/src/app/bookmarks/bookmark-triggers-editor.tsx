import { ArrowDown, ArrowUp, Bell, Plus, Trash2, Zap } from 'lucide-react';
import type { Bookmark } from '@workspace/contracts';
import { useI18n } from '../../i18n/context';
import type { AxtermMessageKey } from '../../i18n/core';

type BookmarkTrigger = Bookmark['triggers'][number];

const presetTriggers: Array<{
  labelKey: AxtermMessageKey;
  trigger: Omit<BookmarkTrigger, 'id' | 'name'> & { nameKey: AxtermMessageKey };
}> = [
  {
    labelKey: 'bookmarkTriggers.ciscoPreset',
    trigger: {
      nameKey: 'bookmarkTriggers.ciscoName',
      enabled: true,
      match: { type: 'text', value: '--More--', caseSensitive: true },
      action: { type: 'send', value: ' ' },
      sendEnter: false,
      mode: 'cooldown',
      cooldownMs: 500,
    },
  },
  {
    labelKey: 'bookmarkTriggers.sudoPreset',
    trigger: {
      nameKey: 'bookmarkTriggers.sudoName',
      enabled: true,
      match: { type: 'regex', value: '\\[sudo\\]\\s*password', caseSensitive: false },
      action: { type: 'notify', value: '' },
      sendEnter: false,
      mode: 'cooldown',
      cooldownMs: 5_000,
    },
  },
];

export function BookmarkTriggersEditor({
  value,
  onChange,
}: {
  value: BookmarkTrigger[];
  onChange(value: BookmarkTrigger[]): void;
}) {
  const { x } = useI18n();
  function update(index: number, next: BookmarkTrigger) {
    onChange(value.map((trigger, position) => (position === index ? next : trigger)));
  }

  function move(index: number, offset: -1 | 1) {
    const target = index + offset;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    const [item] = next.splice(index, 1);
    if (item) next.splice(target, 0, item);
    onChange(next);
  }

  function add(trigger?: Omit<BookmarkTrigger, 'id'>) {
    onChange([
      ...value,
      {
        id: crypto.randomUUID(),
        ...(trigger ?? {
          name: '',
          enabled: true,
          match: { type: 'text', value: '', caseSensitive: false },
          action: { type: 'notify', value: '' },
          sendEnter: false,
          mode: 'cooldown',
          cooldownMs: 500,
        }),
      },
    ]);
  }

  return (
    <section
      aria-labelledby="ssh-bookmark-tab-triggers"
      className="bookmark-trigger-field host-form-field full-field"
      data-tab="triggers"
      id="ssh-bookmark-triggers"
      role="tabpanel"
    >
      <header>
        <div>
          <strong>{x('bookmarkTriggers.title')}</strong>
          <p>{x('bookmarkTriggers.description')}</p>
        </div>
        <div className="bookmark-trigger-add">
          <select
            aria-label={x('bookmarkTriggers.addPreset')}
            defaultValue=""
            disabled={value.length >= 32}
            onChange={(event) => {
              const preset = presetTriggers[Number(event.target.value)];
              event.target.value = '';
              if (preset) {
                const { nameKey, ...trigger } = preset.trigger;
                add({ ...structuredClone(trigger), name: x(nameKey) });
              }
            }}
          >
            <option value="">{x('bookmarkTriggers.presets')}</option>
            {presetTriggers.map((preset, index) => (
              <option key={preset.labelKey} value={index}>
                {x(preset.labelKey)}
              </option>
            ))}
          </select>
          <button type="button" disabled={value.length >= 32} onClick={() => add()}>
            <Plus size={13} /> {x('bookmarkTriggers.addRule')}
          </button>
        </div>
      </header>
      {value.length ? (
        <div className="bookmark-trigger-list">
          {value.map((trigger, index) => (
            <article className="bookmark-trigger-row" key={trigger.id}>
              <header>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={trigger.enabled}
                    onChange={(event) =>
                      update(index, { ...trigger, enabled: event.target.checked })
                    }
                  />
                  {x('bookmarkTriggers.enabled')}
                </label>
                <span>
                  {trigger.action.type === 'send' ? <Zap size={13} /> : <Bell size={13} />}
                </span>
                <div className="bookmark-trigger-actions">
                  <button
                    aria-label={x('bookmarkTriggers.moveUp', { number: index + 1 })}
                    type="button"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    aria-label={x('bookmarkTriggers.moveDown', { number: index + 1 })}
                    type="button"
                    disabled={index === value.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    aria-label={x('bookmarkTriggers.delete', { number: index + 1 })}
                    className="danger"
                    type="button"
                    onClick={() => onChange(value.filter((_, position) => position !== index))}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </header>
              <div className="bookmark-trigger-grid">
                <label className="wide">
                  {x('bookmarkTriggers.name')}
                  <input
                    aria-label={x('bookmarkTriggers.nameAria', { number: index + 1 })}
                    maxLength={100}
                    required
                    value={trigger.name}
                    onChange={(event) => update(index, { ...trigger, name: event.target.value })}
                  />
                </label>
                <label>
                  {x('bookmarkTriggers.matchType')}
                  <select
                    value={trigger.match.type}
                    onChange={(event) =>
                      update(index, {
                        ...trigger,
                        match: {
                          ...trigger.match,
                          type: event.target.value as 'text' | 'regex',
                        },
                      })
                    }
                  >
                    <option value="text">{x('bookmarkTriggers.text')}</option>
                    <option value="regex">{x('bookmarkTriggers.regex')}</option>
                  </select>
                </label>
                <label className="wide">
                  {x('bookmarkTriggers.matchValue')}
                  <input
                    aria-label={x('bookmarkTriggers.matchValueAria', { number: index + 1 })}
                    maxLength={512}
                    required
                    value={trigger.match.value}
                    onChange={(event) =>
                      update(index, {
                        ...trigger,
                        match: { ...trigger.match, value: event.target.value },
                      })
                    }
                  />
                </label>
                <label className="check compact">
                  <input
                    type="checkbox"
                    checked={trigger.match.caseSensitive}
                    onChange={(event) =>
                      update(index, {
                        ...trigger,
                        match: { ...trigger.match, caseSensitive: event.target.checked },
                      })
                    }
                  />
                  {x('bookmarkTriggers.caseSensitive')}
                </label>
                <label>
                  {x('bookmarkTriggers.action')}
                  <select
                    value={trigger.action.type}
                    onChange={(event) =>
                      update(index, {
                        ...trigger,
                        action:
                          event.target.value === 'send'
                            ? { type: 'send', value: '' }
                            : { type: 'notify', value: '' },
                      })
                    }
                  >
                    <option value="notify">{x('bookmarkTriggers.notify')}</option>
                    <option value="send">{x('bookmarkTriggers.sendText')}</option>
                  </select>
                </label>
                <label className="wide">
                  {x('bookmarkTriggers.sendValue')}
                  <textarea
                    aria-label={x('bookmarkTriggers.sendValueAria', { number: index + 1 })}
                    disabled={trigger.action.type !== 'send'}
                    maxLength={16_384}
                    rows={2}
                    value={trigger.action.value}
                    onChange={(event) =>
                      trigger.action.type === 'send' &&
                      update(index, {
                        ...trigger,
                        action: { type: 'send', value: event.target.value },
                      })
                    }
                  />
                </label>
                <label>
                  {x('bookmarkTriggers.mode')}
                  <select
                    value={trigger.mode}
                    onChange={(event) =>
                      update(index, {
                        ...trigger,
                        mode: event.target.value as BookmarkTrigger['mode'],
                      })
                    }
                  >
                    <option value="repeat">{x('bookmarkTriggers.repeat')}</option>
                    <option value="once">{x('bookmarkTriggers.once')}</option>
                    <option value="cooldown">{x('bookmarkTriggers.cooldown')}</option>
                  </select>
                </label>
                <label>
                  {x('bookmarkTriggers.cooldownMs')}
                  <input
                    type="number"
                    disabled={trigger.mode !== 'cooldown'}
                    min={0}
                    max={600_000}
                    value={trigger.cooldownMs}
                    onChange={(event) =>
                      update(index, { ...trigger, cooldownMs: Number(event.target.value) })
                    }
                  />
                </label>
                <label className="check compact">
                  <input
                    type="checkbox"
                    disabled={trigger.action.type !== 'send'}
                    checked={trigger.sendEnter}
                    onChange={(event) =>
                      update(index, { ...trigger, sendEnter: event.target.checked })
                    }
                  />
                  {x('bookmarkTriggers.sendEnter')}
                </label>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="bookmark-trigger-empty">{x('bookmarkTriggers.empty')}</div>
      )}
      <small>{x('bookmarkTriggers.safety', { count: value.length })}</small>
    </section>
  );
}
