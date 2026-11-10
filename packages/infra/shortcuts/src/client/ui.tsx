import type {} from '@axterm/ui/workspace';
// Axterm retains the existing settings DOM. Recording/arbitration follows locked DSH ui-shortcuts/Editor.tsx.
import { useLayoutEffect, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale, TranslateNS, PropsRenderSlots } from '@axterm/ui';
import type { Shortcuts, ShortcutCatalogEntry, ShortcutReferenceSeat } from '@axterm/ui/shortcuts';
import type {
  ShortcutBinding,
  ShortcutCommandId,
  ShortcutRevision,
} from '@axterm/plugin-api/shortcuts';
import { presentBinding } from '@axterm/plugin-api/shortcuts';
import { Check, Keyboard, Pencil, RotateCcw, Trash2, X } from 'lucide-react';
import { observeComposition } from './primitives.ts';
import { dictionaries } from './locales.ts';
import styles, { cssText } from './shortcuts.module.css';

const cx = (value: string) =>
  value
    .split(/\s+/u)
    .map((name) => name + ' ' + (styles[name] ?? ''))
    .join(' ');
const actionOrder = [
  'app.closeCurrentTab',
  'app.mouseWheelDownCloseTab',
  'app.reloadCurrentTab',
  'app.reloadAll',
  'app.cloneToNextLayout',
  'app.duplicateTab',
  'app.newBookmark',
  'app.newTab',
  'app.toggleAddBtn',
  'app.togglefullscreen',
  'app.zoomin',
  'app.zoomout',
  'app.prevTab',
  'app.nextTab',
  'terminal.clear',
  'terminal.copy',
  'terminal.paste',
  'terminal.search',
  'terminal.pasteSelected',
  'terminal.showNormalBuffer',
  'terminal.zoominTerminal',
  'terminal.zoomoutTerminal',
  'terminal.syncSftpPath',
];
export function installShortcutSettings(ctx: Context, shortcuts: Shortcuts): void {
  ctx.effect(() => ctx.locale.register('shortcuts', dictionaries));
  const t = ctx.locale.bind('shortcuts');
  for (const [id, key, bindings] of [
    [
      'move',
      'protocol.move',
      [
        { code: 'ArrowUp', modifiers: [] },
        { code: 'ArrowDown', modifiers: [] },
      ],
    ],
    ['select', 'protocol.select', [{ code: 'Enter', modifiers: [] }]],
    ['dismiss', 'protocol.dismiss', [{ code: 'Escape', modifiers: [] }]],
  ] as const)
    ctx.effect(() =>
      shortcuts.registerFixed({
        id: ('fixed.' + id) as ShortcutCommandId,
        label: () => t(key),
        keys: bindings.map((binding) => binding.code),
        bindings,
        group: 'menus',
      }),
    );

  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.axtermOwner = '@axterm/infra-shortcuts';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.inject(['slots'], (owner) =>
    owner.slots.inject('settings.shortcuts', function* () {
      yield owner.slots.register(
        {
          name: 'settings.shortcuts',
          id: 'shortcuts.preferences',
          locale: 'shortcuts',
          children: {
            'shortcuts.gesture-rows': { kind: 'list', scope: 'root' },
            'shortcuts.gesture-editor': { kind: 'list', scope: 'root' },
            'shortcuts.footer': { kind: 'list', scope: 'root' },
          },
        },
        ({
          t,
          renderSlot,
        }: PropsLocale<'shortcuts'> &
          PropsRenderSlots<
            'shortcuts.gesture-rows' | 'shortcuts.gesture-editor' | 'shortcuts.footer'
          >) => <ShortcutSettingsPanel shortcuts={shortcuts} x={t} renderSlot={renderSlot} />,
      );
    }),
  );
}
export function ShortcutSettingsPanel({
  shortcuts,
  x,
  renderSlot,
}: {
  shortcuts: Shortcuts;
  x: TranslateNS<'shortcuts'>;
  renderSlot: PropsRenderSlots<
    'shortcuts.gesture-rows' | 'shortcuts.gesture-editor' | 'shortcuts.footer'
  >['renderSlot'];
}) {
  const catalog = useSyncExternalStore(shortcuts.catalog.subscribe, shortcuts.catalog.getSnapshot),
    fixed = useSyncExternalStore(
      shortcuts.fixedCatalog.subscribe,
      shortcuts.fixedCatalog.getSnapshot,
    ),
    config = useSyncExternalStore(shortcuts.config.subscribe, shortcuts.config.getSnapshot);
  const [editing, setEditing] = useState<string>(),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const rows = [
    ...catalog.filter(
      (row) =>
        !row.id.endsWith('.alternate') &&
        !(
          row.binding === null &&
          !row.modified &&
          ['terminal.zoominTerminal', 'terminal.zoomoutTerminal'].includes(row.id) &&
          !catalog.some((alias) => alias.id === row.id + '.alternate' && alias.binding !== null)
        ),
    ),
    ...fixed.map((row) => ({ ...row, fixed: true as const })),
  ].sort((a, b) => {
    const i = actionOrder.indexOf(a.id),
      j = actionOrder.indexOf(b.id);
    return (i < 0 ? 999 : i) - (j < 0 ? 999 : j) || a.id.localeCompare(b.id);
  });
  const seat: ShortcutReferenceSeat = {
    editing,
    selectEditor: setEditing,
    startIndex: rows.length + 1,
    classes: {
      row: cx('shortcut-row'),
      editingRow: cx('shortcut-row editing'),
      index: cx('shortcut-index'),
      description: cx('shortcut-description'),
      scope: cx('shortcut-scope'),
      bindings: cx('shortcut-bindings'),
      actions: cx('shortcut-actions'),
      editor: cx('shortcut-editor'),
      capture: cx('shortcut-capture'),
      editorActions: cx('shortcut-editor-actions'),
      hint: cx('hint'),
      error: cx('danger-text'),
      primary: cx('primary'),
    },
  };
  const reset = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await shortcuts.edit({ type: 'reset-all' }, config.revision);
      if (mounted.current)
        setNotice(
          result.status === 'saved' ? x('shortcuts.defaultsRestored') : x('shortcuts.saveError'),
        );
    } catch {
      if (mounted.current) setNotice(x('shortcuts.saveError'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section
      className={cx('surface shortcut-settings-panel')}
      aria-labelledby="shortcut-settings-title"
      data-shortcut-preferences=""
    >
      <header>
        <div>
          <small>{x('shortcuts.registryEyebrow')}</small>
          <h3 id="shortcut-settings-title">
            <Keyboard size={15} aria-hidden="true" />
            {x('shortcuts.title')}
          </h3>
          <p className={cx('hint')}>{x('shortcuts.description')}</p>
        </div>
        <button
          type="button"
          disabled={config.status !== 'ready' || busy || editing !== undefined}
          onClick={() => void reset()}
        >
          <RotateCcw size={13} aria-hidden="true" />
          {x('shortcuts.restoreDefaults')}
        </button>
      </header>
      <div className={cx('shortcut-table')} role="table" aria-label={x('shortcuts.table')}>
        <div className={cx('shortcut-table-heading')} role="row">
          <span role="columnheader">NO.</span>
          <span role="columnheader">{x('shortcuts.action')}</span>
          <span role="columnheader">{x('shortcuts.scope')}</span>
          <span role="columnheader">{x('shortcuts.binding')}</span>
          <span role="columnheader" className={cx('sr-only')}>
            {x('shortcuts.operations')}
          </span>
        </div>
        {rows.map((row, index) => {
          const isFixed = 'fixed' in row,
            alias = catalog.find((value) => value.id === row.id + '.alternate'),
            values = [row.keys, ...(alias?.keys.length ? [alias.keys] : [])].filter(
              (value) => value.length,
            );
          return (
            <div
              className={cx(editing === row.id ? 'shortcut-row editing' : 'shortcut-row')}
              data-shortcut-action={row.id.replace('.', '_')}
              key={row.id}
              role="row"
            >
              <span className={cx('shortcut-index')} role="cell">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className={cx('shortcut-description')} role="cell">
                <strong>{row.label}</strong>
                <small>{row.id.replace('.', '_')}</small>
              </span>
              <span className={cx('shortcut-scope')} role="cell">
                {x(row.id.startsWith('terminal.') ? 'shortcuts.terminal' : 'shortcuts.app')}
              </span>
              <span className={cx('shortcut-bindings')} role="cell">
                {values.length ? (
                  values.map((keys, index) => (
                    <kbd key={index}>{keys.join(shortcuts.platform === 'macos' ? '' : ' ')}</kbd>
                  ))
                ) : (
                  <em>{x('shortcuts.notSet')}</em>
                )}
                {isFixed && (
                  <small className={cx('shortcut-readonly')}>{x('shortcuts.systemBinding')}</small>
                )}
              </span>
              <span className={cx('shortcut-actions')} role="cell">
                {!isFixed && (
                  <button
                    type="button"
                    aria-label={x('shortcuts.editNamed', { name: row.label })}
                    disabled={config.status !== 'ready' || busy || editing !== undefined}
                    onClick={() => {
                      setNotice('');
                      setEditing(row.id);
                    }}
                  >
                    <Pencil size={13} aria-hidden="true" />
                  </button>
                )}
              </span>
            </div>
          );
        })}
        {renderSlot('shortcuts.gesture-rows', seat)}
      </div>
      {renderSlot('shortcuts.gesture-editor', seat)}
      {editing && catalog.some((row) => row.id === editing) && (
        <ShortcutEditor
          key={editing}
          shortcuts={shortcuts}
          group={catalog.filter((row) => row.id === editing || row.id === editing + '.alternate')}
          x={x}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            setNotice(x('shortcuts.applied'));
          }}
        />
      )}
      {config.status !== 'ready' && (
        <p role="status" className={cx('danger-text')}>
          {x(config.status === 'loading' ? 'protocol.not-ready' : 'protocol.not-ready')}
        </p>
      )}
      {notice && (
        <p className={cx('hint')} role="status">
          {notice}
        </p>
      )}
      {renderSlot('shortcuts.footer', seat)}
    </section>
  );
}
function ShortcutEditor({
  shortcuts,
  group,
  x,
  onClose,
  onSaved,
}: {
  shortcuts: Shortcuts;
  group: readonly ShortcutCatalogEntry[];
  x: TranslateNS<'shortcuts'>;
  onClose(): void;
  onSaved(): void;
}) {
  const config = useSyncExternalStore(shortcuts.config.subscribe, shortcuts.config.getSnapshot);
  const [targetId, setTargetId] = useState(group[0]!.id),
    [revision, setRevision] = useState<ShortcutRevision>(config.revision),
    [candidate, setCandidate] = useState<ShortcutBinding | null>(group[0]!.binding),
    [message, setMessage] = useState(''),
    [ready, setReady] = useState(shortcuts.runtime === 'web'),
    [busy, setBusy] = useState(false);
  const recorder = useRef<HTMLDivElement>(null),
    writing = useRef(false),
    mounted = useRef(true),
    resetInput = useRef(() => {});
  const target = group.find((row) => row.id === targetId)!;
  const stale = revision !== config.revision,
    desktopChords =
      shortcuts.runtime === 'desktop' &&
      (shortcuts.platform === 'macos' || shortcuts.platform === 'windows');
  const state = useRef({
    busy: false,
    capture: (_binding: ShortcutBinding) => {},
    close: () => {},
  });
  useLayoutEffect(() => {
    state.current = {
      busy,
      capture: (binding) => {
        setCandidate(binding);
        const description = shortcuts.describeBinding(binding),
          conflicts = description.conflicts.filter((id) => id !== targetId);
        setMessage(
          description.issue
            ? x(`protocol.${description.issue}`)
            : conflicts.length
              ? x('protocol.conflict', {
                  commands: conflicts
                    .map(
                      (id) =>
                        shortcuts.catalog.getSnapshot().find((row) => row.id === id)?.label ??
                        shortcuts.fixedCatalog.getSnapshot().find((row) => row.id === id)?.label ??
                        description.referenceLabels?.[id] ??
                        id,
                    )
                    .join(', '),
                })
              : '',
        );
      },
      close: onClose,
    };
  }, [busy, shortcuts, targetId, x, onClose]);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    let disposed = false;
    void shortcuts.recording(true).then(
      () => {
        if (!disposed) {
          setReady(true);
          recorder.current?.focus();
        }
      },
      () => {
        if (!disposed) setMessage(x('protocol.native-failed'));
      },
    );
    const composition = observeComposition(document),
      held = new Set<string>();
    let pending: ShortcutBinding | null = null,
      dead = false,
      blocked = false;
    const reset = () => {
      pending = null;
      held.clear();
      dead = false;
      blocked = false;
    };
    resetInput.current = reset;
    const down = (event: KeyboardEvent) => {
      if (composition.guards(event) || event.getModifierState('AltGraph')) {
        reset();
        return;
      }
      if (
        (!desktopChords || document.activeElement !== recorder.current) &&
        event.key === 'Escape' &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat && !state.current.busy) state.current.close();
        return;
      }
      if (event.key === 'Dead') {
        reset();
        dead = true;
        return;
      }
      if (dead) {
        dead = false;
        return;
      }
      const modifiers = (['control', 'alt', 'shift', 'meta'] as const).filter(
        (value) =>
          ({
            control: event.ctrlKey,
            alt: event.altKey,
            shift: event.shiftKey,
            meta: event.metaKey,
          })[value],
      );
      if (
        document.activeElement !== recorder.current ||
        (event.key === 'Tab' && !desktopChords && modifiers.length < 3)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (writing.current || event.repeat) return;
      if (/^(Control|Alt|Shift|Meta)(Left|Right)$/u.test(event.code)) {
        if (desktopChords && pending) reset();
        return;
      }
      if (desktopChords) {
        held.add(event.code);
        if (blocked) return;
        if (held.size > 2) {
          blocked = true;
          pending = null;
          setMessage(x('protocol.too-many-keys'));
          return;
        }
      }
      try {
        const codes = [
          event.code,
          ...(desktopChords ? [...held].filter((value) => value !== event.code) : []),
        ];
        pending = shortcuts.describeBinding({
          code: codes[0]!,
          ...(codes[1] === undefined ? {} : { secondCode: codes[1] }),
          modifiers,
        }).binding;
        if (pending) setCandidate(pending);
      } catch {
        blocked = desktopChords;
        pending = null;
        setMessage(x('protocol.unsupported-key'));
      }
    };
    const up = (event: KeyboardEvent) => {
      held.delete(event.code);
      if (desktopChords && document.activeElement === recorder.current) {
        event.preventDefault();
        event.stopPropagation();
      }
      const binding =
        pending &&
        (pending.code === event.code ||
          pending.secondCode === event.code ||
          pending.modifiers.some(
            (modifier) => modifier === event.code.replace(/(Left|Right)$/u, '').toLowerCase(),
          ))
          ? pending
          : null;
      if (binding) {
        pending = null;
        blocked = desktopChords;
      }
      if (
        desktopChords &&
        (held.size === 0 ||
          (shortcuts.platform === 'macos' && /^Meta(Left|Right)$/u.test(event.code)))
      ) {
        held.clear();
        blocked = false;
      }
      if (binding) state.current.capture(binding);
    };
    const blur = () => reset(),
      focus = () => {
        if (document.activeElement !== recorder.current) reset();
      };
    document.addEventListener('keydown', down, true);
    document.addEventListener('keyup', up, true);
    document.addEventListener('focusin', focus, true);
    document.addEventListener('compositionstart', blur, true);
    window.addEventListener('blur', blur);
    return () => {
      disposed = true;
      composition.dispose();
      document.removeEventListener('keydown', down, true);
      document.removeEventListener('keyup', up, true);
      document.removeEventListener('focusin', focus, true);
      document.removeEventListener('compositionstart', blur, true);
      window.removeEventListener('blur', blur);
      void shortcuts.recording(false).catch(() => {});
    };
  }, [shortcuts, desktopChords, x]);
  const save = async (reset = false) => {
    if (writing.current || stale || config.status !== 'ready') return;
    if (!reset && candidate) {
      const described = shortcuts.describeBinding(candidate);
      if (described.issue || described.conflicts.some((id) => id !== targetId)) {
        state.current.capture(candidate);
        return;
      }
    }
    writing.current = true;
    setBusy(true);
    try {
      const result = await shortcuts.edit(
        reset ? { type: 'reset', id: targetId } : { type: 'set', id: targetId, binding: candidate },
        revision,
      );
      if (!mounted.current) return;
      if (result.status === 'saved') onSaved();
      else
        setMessage(
          x(
            result.status === 'stale'
              ? 'protocol.stale'
              : result.status === 'write-failed'
                ? 'protocol.write-failed'
                : result.status === 'conflict'
                  ? 'shortcuts.saveError'
                  : 'protocol.not-ready',
          ),
        );
    } catch {
      if (mounted.current) setMessage(x('shortcuts.saveError'));
    } finally {
      writing.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div
      className={cx('shortcut-editor')}
      role="dialog"
      aria-label={x('shortcuts.edit')}
      data-shortcut-modal="shortcut-edit"
    >
      <div>
        <small>EDIT SHORTCUT</small>
        <strong>{target.label}</strong>
        {group.length > 1 &&
          group.map((row, index) => (
            <button
              key={row.id}
              type="button"
              aria-pressed={targetId === row.id}
              disabled={busy}
              onClick={() => {
                resetInput.current();
                setTargetId(row.id);
                setCandidate(row.binding);
                setRevision(config.revision);
                setMessage('');
                recorder.current?.focus();
              }}
            >
              {index + 1}
            </button>
          ))}
      </div>
      <div
        ref={recorder}
        tabIndex={ready ? 0 : -1}
        aria-disabled={!ready}
        className={cx('shortcut-capture')}
        data-shortcut-recording=""
      >
        {candidate ? (
          <kbd>
            {presentBinding(
              shortcuts.describeBinding(candidate).binding,
              shortcuts.platform,
            ).keys.join(shortcuts.platform === 'macos' ? '' : ' ')}
          </kbd>
        ) : (
          <span>{x('protocol.record-help')}</span>
        )}
      </div>
      {stale && (
        <p role="status">
          {x('protocol.stale')}
          <button type="button" disabled={busy} onClick={() => setRevision(config.revision)}>
            {x('protocol.review')}
          </button>
        </p>
      )}
      {message && (
        <p className={cx('danger-text')} role="alert">
          {message}
        </p>
      )}
      <div className={cx('shortcut-editor-actions')}>
        <button type="button" onClick={() => setCandidate(null)} disabled={busy}>
          <Trash2 size={13} />
          {x('shortcuts.clear')}
        </button>
        <button type="button" onClick={() => void save(true)} disabled={busy || stale}>
          <RotateCcw size={13} />
          {x('shortcuts.restoreDefaults')}
        </button>
        <button type="button" onClick={onClose} disabled={busy}>
          <X size={13} />
          {x('common.cancel')}
        </button>
        <button
          type="button"
          className={cx('primary')}
          disabled={busy || stale || !ready || config.status !== 'ready'}
          onClick={() => void save()}
        >
          <Check size={13} />
          {x('shortcuts.apply')}
        </button>
      </div>
    </div>
  );
}
