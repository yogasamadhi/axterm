import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { Bookmark } from '@workspace/contracts';
import { useI18n } from '../../i18n/context';

type BookmarkQuickCommand = Bookmark['quickCommands'][number];

export function BookmarkQuickCommandsEditor({
  value,
  onChange,
}: {
  value: BookmarkQuickCommand[];
  onChange(value: BookmarkQuickCommand[]): void;
}) {
  const { x } = useI18n();
  function update(index: number, patch: Partial<BookmarkQuickCommand>) {
    onChange(
      value.map((command, position) => (position === index ? { ...command, ...patch } : command)),
    );
  }

  function move(index: number, offset: -1 | 1) {
    const target = index + offset;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    const [item] = next.splice(index, 1);
    if (item) next.splice(target, 0, item);
    onChange(next);
  }

  return (
    <section
      aria-labelledby="ssh-bookmark-tab-quickCommands"
      className="bookmark-quick-command-field host-form-field full-field"
      data-tab="quickCommands"
      id="ssh-bookmark-quickCommands"
      role="tabpanel"
    >
      <header>
        <div>
          <strong>{x('bookmarkCommands.title')}</strong>
          <p>{x('bookmarkCommands.description')}</p>
        </div>
        <button
          type="button"
          disabled={value.length >= 64}
          onClick={() => onChange([...value, { name: '', command: '' }])}
        >
          <Plus size={13} /> {x('bookmarkCommands.add')}
        </button>
      </header>
      {value.length ? (
        <div className="bookmark-quick-command-list">
          {value.map((command, index) => (
            <div className="bookmark-quick-command-row" key={index}>
              <span>{index + 1}</span>
              <label>
                {x('bookmarkCommands.name')}
                <input
                  aria-label={x('bookmarkCommands.nameAt', { number: index + 1 })}
                  value={command.name}
                  maxLength={60}
                  required
                  onChange={(event) => update(index, { name: event.target.value })}
                />
              </label>
              <label>
                {x('bookmarkCommands.command')}
                <textarea
                  aria-label={x('bookmarkCommands.commandAt', { number: index + 1 })}
                  value={command.command}
                  maxLength={16_384}
                  required
                  rows={2}
                  onChange={(event) => update(index, { command: event.target.value })}
                />
              </label>
              <div className="bookmark-quick-command-actions">
                <button
                  aria-label={x('bookmarkCommands.moveUp', { number: index + 1 })}
                  type="button"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  aria-label={x('bookmarkCommands.moveDown', { number: index + 1 })}
                  type="button"
                  disabled={index === value.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={13} />
                </button>
                <button
                  className="danger"
                  aria-label={x('bookmarkCommands.delete', { number: index + 1 })}
                  type="button"
                  onClick={() => onChange(value.filter((_, position) => position !== index))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bookmark-quick-command-empty">{x('bookmarkCommands.empty')}</div>
      )}
      <small>{x('bookmarkCommands.limits', { count: value.length })}</small>
    </section>
  );
}
