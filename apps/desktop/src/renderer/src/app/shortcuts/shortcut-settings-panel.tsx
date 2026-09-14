import { useEffect, useMemo, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type { QuickCommand, ShortcutActionId, ShortcutBindings } from '@workspace/contracts';
import { Check, Keyboard, Pencil, RotateCcw, Trash2, X } from 'lucide-react';
import {
  SHORTCUT_ACTIONS,
  effectiveShortcutBindings,
  formatShortcut,
  normalizeShortcut,
  shortcutConflicts,
  shortcutFromKeyboardEvent,
  shortcutFromWheelEvent,
  shortcutPlatform,
  shortcutToElectronAccelerator,
} from './shortcut-registry';
import { useI18n } from '../../i18n/context';

type Client = ReturnType<typeof createRuntimeClient>;

export function ShortcutSettingsPanel({ client }: { client: Client }) {
  const { x } = useI18n();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: client.settings });
  const quickCommands = useQuery({ queryKey: ['quick-commands'], queryFn: client.quickCommands });
  const platform = shortcutPlatform(navigator.userAgent);
  const [editing, setEditing] = useState<ShortcutActionId>();
  const [draft, setDraft] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);
  const capture = useRef<HTMLDivElement>(null);
  const bindings = settings.data?.shortcuts.bindings;
  const conflicts = useMemo(
    () =>
      editing
        ? shortcutConflicts(editing, draft, bindings, quickCommands.data ?? [], platform, x)
        : [],
    [bindings, draft, editing, platform, quickCommands.data, x],
  );

  useEffect(() => {
    if (editing) capture.current?.focus();
  }, [editing]);

  function begin(actionId: ShortcutActionId) {
    const definition = SHORTCUT_ACTIONS.find(({ id }) => id === actionId);
    if (!definition || definition.readonly) return;
    setEditing(actionId);
    setDraft([...effectiveShortcutBindings(definition, bindings, platform)]);
    setNotice('');
    setNoticeError(false);
  }

  function captureChord(chord: string | undefined) {
    if (!chord) return;
    setDraft((current) =>
      current.includes(chord)
        ? current
        : current.length >= 2
          ? [current[1]!, chord]
          : [...current, chord],
    );
  }

  async function persist(nextBindings: ShortcutBindings, success: string) {
    if (!settings.data || busy) return;
    setBusy(true);
    setNotice('');
    setNoticeError(false);
    try {
      const next = await client.updateSettings(settings.data, {
        shortcuts: { bindings: nextBindings },
      });
      queryClient.setQueryData(['settings'], next);
      setEditing(undefined);
      setNotice(success);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : x('shortcuts.saveError'));
      setNoticeError(true);
      await settings.refetch();
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!editing || conflicts.length) return;
    await persist({ ...(bindings ?? {}), [editing]: draft }, x('shortcuts.applied'));
  }

  async function resetAll() {
    await persist({}, x('shortcuts.defaultsRestored'));
  }

  return (
    <section className="surface shortcut-settings-panel" aria-labelledby="shortcut-settings-title">
      <header>
        <div>
          <small>{x('shortcuts.registryEyebrow')}</small>
          <h3 id="shortcut-settings-title">
            <Keyboard size={15} aria-hidden="true" /> {x('shortcuts.title')}
          </h3>
          <p className="hint">{x('shortcuts.description')}</p>
        </div>
        <button type="button" disabled={!settings.data || busy} onClick={() => void resetAll()}>
          <RotateCcw size={13} aria-hidden="true" /> {x('shortcuts.restoreDefaults')}
        </button>
      </header>

      <div className="shortcut-table" role="table" aria-label={x('shortcuts.table')}>
        <div className="shortcut-table-heading" role="row">
          <span role="columnheader">NO.</span>
          <span role="columnheader">{x('shortcuts.action')}</span>
          <span role="columnheader">{x('shortcuts.scope')}</span>
          <span role="columnheader">{x('shortcuts.binding')}</span>
          <span role="columnheader" className="sr-only">
            {x('shortcuts.operations')}
          </span>
        </div>
        {SHORTCUT_ACTIONS.map((definition, index) => {
          const values = effectiveShortcutBindings(definition, bindings, platform);
          const active = editing === definition.id;
          return (
            <div
              className={active ? 'shortcut-row editing' : 'shortcut-row'}
              data-shortcut-action={definition.id}
              key={definition.id}
              role="row"
            >
              <span className="shortcut-index" role="cell">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="shortcut-description" role="cell">
                <strong>{x(definition.labelKey)}</strong>
                <small>{definition.id}</small>
              </span>
              <span className="shortcut-scope" role="cell">
                {definition.scope === 'app' ? x('shortcuts.app') : x('shortcuts.terminal')}
              </span>
              <span className="shortcut-bindings" role="cell">
                {definition.id === 'app_mouseWheelDownCloseTab' ? (
                  <kbd>{x('shortcuts.middleMouseButton')}</kbd>
                ) : values.length ? (
                  values.map((value) => <kbd key={value}>{formatShortcut(value, platform, x)}</kbd>)
                ) : (
                  <em>{x('shortcuts.notSet')}</em>
                )}
                {definition.readonly && (
                  <small className="shortcut-readonly">{x('shortcuts.systemBinding')}</small>
                )}
              </span>
              <span className="shortcut-actions" role="cell">
                {!definition.readonly && (
                  <button
                    type="button"
                    aria-label={x('shortcuts.editNamed', { name: x(definition.labelKey) })}
                    disabled={!settings.data || busy}
                    onClick={() => begin(definition.id)}
                  >
                    <Pencil size={13} aria-hidden="true" />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {editing && (
        <div className="shortcut-editor" role="dialog" aria-label={x('shortcuts.edit')}>
          <div>
            <small>EDIT SHORTCUT</small>
            <strong>{x(SHORTCUT_ACTIONS.find(({ id }) => id === editing)!.labelKey)}</strong>
          </div>
          <div
            ref={capture}
            className="shortcut-capture"
            data-shortcut-capture="true"
            tabIndex={0}
            onKeyDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (event.key === 'Escape') {
                setEditing(undefined);
                return;
              }
              if (event.key === 'Backspace' || event.key === 'Delete') {
                setDraft([]);
                return;
              }
              captureChord(shortcutFromKeyboardEvent(event.nativeEvent));
            }}
            onWheel={(event: ReactWheelEvent<HTMLDivElement>) => {
              event.preventDefault();
              event.stopPropagation();
              captureChord(shortcutFromWheelEvent(event.nativeEvent));
            }}
          >
            {draft.length ? (
              draft.map((value) => (
                <button
                  type="button"
                  key={value}
                  title={x('shortcuts.removeBinding')}
                  onClick={() => setDraft((current) => current.filter((item) => item !== value))}
                >
                  <kbd>{formatShortcut(value, platform, x)}</kbd>
                  <X size={11} aria-hidden="true" />
                </button>
              ))
            ) : (
              <span>{x('shortcuts.captureHint')}</span>
            )}
          </div>
          {conflicts.length > 0 && (
            <p className="danger-text" role="alert">
              {conflicts
                .map(({ chord, ownerLabel }) =>
                  x('shortcuts.conflict', {
                    chord: formatShortcut(chord, platform, x),
                    owner: ownerLabel,
                  }),
                )
                .join(x('shortcuts.conflictSeparator'))}
            </p>
          )}
          <div className="shortcut-editor-actions">
            <button type="button" onClick={() => setDraft([])} disabled={busy}>
              <Trash2 size={13} aria-hidden="true" /> {x('shortcuts.clear')}
            </button>
            <button type="button" onClick={() => setEditing(undefined)} disabled={busy}>
              <X size={13} aria-hidden="true" /> {x('common.cancel')}
            </button>
            <button
              className="primary"
              type="button"
              disabled={busy || conflicts.length > 0}
              onClick={() => void save()}
            >
              <Check size={13} aria-hidden="true" /> {x('shortcuts.apply')}
            </button>
          </div>
        </div>
      )}
      {notice && (
        <p className={noticeError ? 'danger-text' : 'hint'} role="status">
          {notice}
        </p>
      )}
      <GlobalHotkeySetting
        client={client}
        bindings={bindings}
        quickCommands={quickCommands.data ?? []}
        platform={platform}
      />
    </section>
  );
}

function GlobalHotkeySetting({
  client,
  bindings,
  quickCommands,
  platform,
}: {
  client: Client;
  bindings: ShortcutBindings | undefined;
  quickCommands: readonly QuickCommand[];
  platform: ReturnType<typeof shortcutPlatform>;
}) {
  const { x } = useI18n();
  const queryClient = useQueryClient();
  const preferences = useQuery({
    queryKey: ['window-preferences'],
    queryFn: client.windowPreferences,
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageError, setMessageError] = useState(false);
  const editor = useRef<HTMLDivElement>(null);
  const current = normalizeShortcut(preferences.data?.preferences.globalHotkey ?? '', platform);
  const conflicts = draft
    ? shortcutConflicts('desktop.globalHotkey', [draft], bindings, quickCommands, platform, x)
    : [];

  useEffect(() => {
    if (editing) editor.current?.focus();
  }, [editing]);

  function begin() {
    setDraft(current ?? '');
    setEditing(true);
    setMessage('');
    setMessageError(false);
  }

  async function update(value: string, success: string) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    setMessageError(false);
    try {
      const result = await client.updateWindowPreferences({ globalHotkey: value });
      queryClient.setQueryData(['window-preferences'], result);
      setEditing(false);
      setMessage(success);
    } catch {
      setMessage(x('shortcuts.globalRegistrationFailed'));
      setMessageError(true);
      await preferences.refetch();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="global-hotkey-setting" aria-label={x('shortcuts.globalHotkey')}>
      <div>
        <small>{x('shortcuts.globalVisibilityEyebrow')}</small>
        <strong>{x('shortcuts.showOrHide')}</strong>
        <p className="hint">{x('shortcuts.globalDescription')}</p>
      </div>
      <div className="global-hotkey-value">
        {current ? (
          <kbd>{formatShortcut(current, platform, x)}</kbd>
        ) : (
          <em>{x('shortcuts.disabled')}</em>
        )}
        <span
          className={preferences.data?.globalHotkeyRegistered ? 'registered' : 'inactive'}
          role="status"
        >
          {preferences.data?.preferences.globalHotkey
            ? preferences.data.globalHotkeyRegistered
              ? x('shortcuts.registered')
              : x('shortcuts.registrationFailed')
            : x('shortcuts.off')}
        </span>
        <button type="button" disabled={!preferences.data || busy} onClick={begin}>
          <Pencil size={13} aria-hidden="true" /> {x('shortcuts.editAction')}
        </button>
      </div>
      {editing && (
        <div className="global-hotkey-editor">
          <div
            ref={editor}
            className="shortcut-capture"
            data-shortcut-capture="true"
            tabIndex={0}
            onKeyDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (event.key === 'Escape') return setEditing(false);
              if (event.key === 'Backspace' || event.key === 'Delete') return setDraft('');
              const value = shortcutFromKeyboardEvent(event.nativeEvent);
              if (value) setDraft(value);
            }}
          >
            {draft ? (
              <kbd>{formatShortcut(draft, platform, x)}</kbd>
            ) : (
              <span>{x('shortcuts.pressCombination')}</span>
            )}
          </div>
          {conflicts.length > 0 && (
            <p className="danger-text" role="alert">
              {x('shortcuts.conflict', {
                chord: formatShortcut(conflicts[0]!.chord, platform, x),
                owner: conflicts[0]!.ownerLabel,
              })}
            </p>
          )}
          <div className="shortcut-editor-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => void update('', x('shortcuts.globalDisabled'))}
            >
              <Trash2 size={13} aria-hidden="true" /> {x('shortcuts.disableAction')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void update('Control+2', x('shortcuts.globalDefaultRestored'))}
            >
              <RotateCcw size={13} aria-hidden="true" /> {x('shortcuts.defaultAction')}
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>
              <X size={13} aria-hidden="true" /> {x('common.cancel')}
            </button>
            <button
              className="primary"
              type="button"
              disabled={!draft || busy || conflicts.length > 0}
              onClick={() =>
                void update(shortcutToElectronAccelerator(draft), x('shortcuts.globalApplied'))
              }
            >
              <Check size={13} aria-hidden="true" /> {x('shortcuts.apply')}
            </button>
          </div>
        </div>
      )}
      {message && <p className={messageError ? 'danger-text' : 'hint'}>{message}</p>}
    </div>
  );
}
