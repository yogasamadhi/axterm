import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Pencil, Trash2, RotateCcw, X, Check } from 'lucide-react';
import type { Context } from '@deepseek-ai/cordis';
import type { ShortcutReferenceSeat } from '@axterm/ui/shortcuts';
import {
  parseLegacyShortcut,
  presentBinding,
  normalizeBinding,
} from '@axterm/plugin-api/shortcuts';
import type { ShortcutBinding } from '@axterm/plugin-api/shortcuts';
import type { DesktopPreferencesModel } from './preferences-model.ts';
import type { DesktopPreferenceCommands } from './preferences-commands.ts';
import type { PreferenceTranslate } from './preferences-locales.ts';
import { cx } from './preferences-styles.ts';
const editorId = 'desktop.globalHotkey';
export function acceleratorFromBinding(binding: ShortcutBinding): string {
  if (binding.secondCode || !binding.modifiers.length) throw Error('GLOBAL_SHORTCUT_INVALID');
  const names: Record<string, string> = {
    Equal: '=',
    Minus: '-',
    Slash: '/',
    Backquote: '`',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Enter: 'Return',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
  };
  const code =
    names[binding.code] ??
    (/^(Key|Digit)/u.test(binding.code) ? binding.code.replace(/^(Key|Digit)/u, '') : binding.code);
  const modifiers: Record<string, string> = {
    control: 'Control',
    meta: 'Command',
    alt: 'Alt',
    shift: 'Shift',
    primary: 'CommandOrControl',
  };
  return [...binding.modifiers.map((value) => modifiers[value]), code].join('+');
}
interface Services {
  ctx: Context;
  model: DesktopPreferencesModel;
  commands: DesktopPreferenceCommands;
  seat: ShortcutReferenceSeat;
  x: PreferenceTranslate;
}
export function GlobalHotkey(props: Services) {
  const { ctx, model, commands, seat, x } = props,
    facts = useSyncExternalStore(model.subscribe, model.getSnapshot),
    command = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  const [review, setReview] = useState<{ generation: string; version: number; value: string }>(),
    [message, setMessage] = useState('');
  const record = facts.status === 'ready' ? facts.baseline.record : undefined;
  const parsed = record
    ? parseLegacyShortcut(record.preferences.globalHotkey, ctx.shortcuts.platform)
    : undefined;
  const current =
    parsed?.kind === 'keyboard'
      ? presentBinding(
          normalizeBinding(parsed.binding, ctx.shortcuts.platform),
          ctx.shortcuts.platform,
        ).keys.join('+')
      : '';
  const retiredReview =
    !!review && facts.status === 'ready' && facts.baseline.generation !== review.generation;
  if (retiredReview) setReview(undefined);
  useEffect(() => {
    if (retiredReview && seat.editing === editorId) seat.selectEditor(undefined);
  }, [retiredReview, seat]);
  const registered = facts.status === 'ready' && !!facts.baseline.native?.globalHotkeyRegistered;
  const retry = async () => {
    try {
      if (command.uncertain) await commands.retry();
      else if (facts.status === 'ready') await model.retryApplication(facts.baseline.generation);
      setMessage('');
    } catch {
      setMessage(x('shortcuts.globalRegistrationFailed'));
    }
  };
  return (
    <div
      className={cx('global-hotkey-setting')}
      aria-label={x('shortcuts.globalHotkey')}
      data-desktop-global-hotkey=""
    >
      <div>
        <small>{x('shortcuts.globalVisibilityEyebrow')}</small>
        <strong>{x('shortcuts.showOrHide')}</strong>
        <p className={cx('hint')}>{x('shortcuts.globalDescription')}</p>
      </div>
      <div className={cx('global-hotkey-value')}>
        {current ? <kbd>{current}</kbd> : <em>{x('shortcuts.disabled')}</em>}
        <span className={cx(registered ? 'registered' : 'inactive')} role="status">
          {x(
            record?.preferences.globalHotkey
              ? registered
                ? 'shortcuts.registered'
                : 'shortcuts.registrationFailed'
              : 'shortcuts.off',
          )}
        </span>
        <button
          type="button"
          disabled={!record || !!seat.editing || command.busy || command.uncertain}
          onClick={() => {
            if (facts.status !== 'ready') return;
            setReview({
              generation: facts.baseline.generation,
              version: facts.baseline.record.version,
              value: facts.baseline.record.preferences.globalHotkey,
            });
            setMessage('');
            seat.selectEditor(editorId);
          }}
        >
          <Pencil size={13} />
          {x('shortcuts.editAction')}
        </button>
      </div>
      {review && seat.editing === editorId && (
        <GlobalHotkeyEditor
          {...props}
          review={review}
          onClose={() => seat.selectEditor(undefined)}
          onSaved={() => {
            seat.selectEditor(undefined);
            const state = model.getSnapshot();
            setMessage(
              x(
                state.status === 'ready' && state.baseline.application === 'ready'
                  ? 'shortcuts.globalApplied'
                  : 'shortcuts.globalRegistrationFailed',
              ),
            );
          }}
        />
      )}
      {command.uncertain && (
        <p className={cx('danger-text')} role="alert">
          {x('windowPreferences.unknown')}
        </p>
      )}
      {(command.uncertain ||
        (facts.status === 'ready' && facts.baseline.application === 'failed')) && (
        <button type="button" disabled={command.busy} onClick={() => void retry()}>
          {x('windowPreferences.retry')}
        </button>
      )}
      {message && (
        <p className={cx('hint')} role="status">
          {message}
        </p>
      )}
    </div>
  );
}
function GlobalHotkeyEditor({
  ctx,
  model,
  commands,
  x,
  review,
  onClose,
  onSaved,
}: Services & {
  review: { generation: string; version: number; value: string };
  onClose(): void;
  onSaved(): void;
}) {
  const initial = parseLegacyShortcut(review.value, ctx.shortcuts.platform);
  const [candidate, setCandidate] = useState<ShortcutBinding | null>(
      initial?.kind === 'keyboard' ? initial.binding : null,
    ),
    [ready, setReady] = useState(false),
    [error, setError] = useState('');
  const capture = useRef<HTMLDivElement>(null),
    mounted = useRef(true),
    command = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  useEffect(() => {
    let active = true;
    mounted.current = true;
    void ctx.shortcuts.recording(true).then(
      () => {
        if (active) {
          setReady(true);
          capture.current?.focus();
        }
      },
      () => {
        if (active) setError(x('shortcuts.globalRegistrationFailed'));
      },
    );
    return () => {
      active = false;
      mounted.current = false;
      void ctx.shortcuts.recording(false).catch(() => {});
    };
  }, [ctx, x]);
  const description = candidate ? ctx.shortcuts.describeBinding(candidate) : undefined;
  const conflict = description?.conflicts
    .map(
      (id) =>
        ctx.shortcuts.catalog.getSnapshot().find((row) => row.id === id)?.label ??
        ctx.shortcuts.fixedCatalog.getSnapshot().find((row) => row.id === id)?.label ??
        description.referenceLabels?.[id] ??
        id,
    )
    .join(', ');
  const apply = async (value: ShortcutBinding | null) => {
    if (command.busy) return;
    if (value) {
      const current = ctx.shortcuts.describeBinding(value);
      if (current.issue || current.conflicts.length) {
        setError(x('shortcuts.globalRegistrationFailed'));
        return;
      }
    }
    try {
      setReady(false);
      await ctx.shortcuts.recording(false);
      if (command.uncertain) await commands.retry();
      else
        await commands.save(
          { globalHotkey: value ? acceleratorFromBinding(value) : '' },
          review.version,
          review.generation,
        );
      if (mounted.current) onSaved();
    } catch {
      if (mounted.current) {
        setError(x('shortcuts.globalRegistrationFailed'));
        void ctx.shortcuts.recording(true).then(
          () => {
            if (mounted.current) setReady(true);
          },
          () => {},
        );
      }
    }
  };
  const facts = model.getSnapshot(),
    stale =
      facts.status !== 'ready' ||
      facts.baseline.generation !== review.generation ||
      facts.baseline.record.version !== review.version;
  return (
    <div
      className={cx('global-hotkey-editor')}
      data-desktop-global-editor=""
      data-shortcut-modal="shortcut-edit"
    >
      <div
        ref={capture}
        className={cx('shortcut-capture')}
        data-shortcut-capture="true"
        tabIndex={ready ? 0 : -1}
        aria-disabled={!ready}
        onKeyDown={(event) => {
          if (event.key === 'Tab' || event.target !== event.currentTarget) return;
          event.preventDefault();
          event.stopPropagation();
          if (
            !ready ||
            command.busy ||
            command.uncertain ||
            event.nativeEvent.isComposing ||
            event.repeat
          )
            return;
          if (event.key === 'Escape') {
            onClose();
            return;
          }
          if (event.key === 'Delete' || event.key === 'Backspace') {
            setCandidate(null);
            return;
          }
          const modifiers = (['control', 'alt', 'shift', 'meta'] as const).filter((name) =>
            name === 'control'
              ? event.ctrlKey
              : name === 'alt'
                ? event.altKey
                : name === 'shift'
                  ? event.shiftKey
                  : event.metaKey,
          );
          if (!modifiers.length || /^(Control|Shift|Alt|Meta)/u.test(event.code)) return;
          try {
            const binding = normalizeBinding(
              { code: event.code, modifiers },
              ctx.shortcuts.platform,
            );
            acceleratorFromBinding(binding);
            setCandidate(binding);
            setError('');
          } catch {
            setError(x('shortcuts.globalRegistrationFailed'));
          }
        }}
      >
        {candidate ? (
          <kbd>
            {presentBinding(
              normalizeBinding(candidate, ctx.shortcuts.platform),
              ctx.shortcuts.platform,
            ).keys.join('+')}
          </kbd>
        ) : (
          <span>{x('shortcuts.pressCombination')}</span>
        )}
      </div>
      {conflict && (
        <p className={cx('danger-text')} role="alert">
          {x('shortcuts.conflict', { chord: description?.keys.join('+'), owner: conflict })}
        </p>
      )}
      {stale && (
        <p className={cx('danger-text')} role="alert">
          {x('windowPreferences.applicationFailed')}
        </p>
      )}
      {error && (
        <p className={cx('danger-text')} role="alert">
          {error}
        </p>
      )}
      <div className={cx('shortcut-editor-actions')}>
        <button
          type="button"
          disabled={!ready || command.busy || command.uncertain || stale}
          onClick={() => void apply(null)}
        >
          <Trash2 size={13} />
          {x('shortcuts.disableAction')}
        </button>
        <button
          type="button"
          disabled={!ready || command.busy || command.uncertain || stale}
          onClick={() => void apply({ code: 'Digit2', modifiers: ['control'] })}
        >
          <RotateCcw size={13} />
          {x('shortcuts.defaultAction')}
        </button>
        <button type="button" disabled={command.busy} onClick={onClose}>
          <X size={13} />
          {x('common.cancel')}
        </button>
        <button
          type="button"
          className={cx('primary')}
          disabled={
            !ready || command.busy || !candidate || !!conflict || !!description?.issue || stale
          }
          onClick={() => void apply(candidate)}
        >
          <Check size={13} />
          {x('shortcuts.apply')}
        </button>
      </div>
    </div>
  );
}
