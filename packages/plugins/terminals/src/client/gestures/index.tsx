import { useLayoutEffect, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import type { ShortcutReferenceSeat } from '@axterm/ui/shortcuts';
import type {
  ShortcutBindings,
  ConfigurationClientActions,
} from '@axterm/plugin-api/configuration';
import { parseLegacyShortcut, type ShortcutPlatform } from '@axterm/plugin-api/shortcuts';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import { TerminalGestureCommands } from './commands.ts';
import {
  GESTURE_ACTIONS,
  gestureDefaults,
  gestureChord,
  replaceGestureBindings,
  type GestureAction,
} from './model.ts';
interface Review {
  action: GestureAction;
  generation: string;
  version: number;
  bindings: ShortcutBindings;
  wheels: readonly string[];
}
class GestureEditorStore {
  private value: Review | undefined;
  private readonly listeners = new Set<() => void>();
  private closed = false;
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  open(
    action: GestureAction,
    configuration: ConfigurationClientActions,
    platform: ShortcutPlatform,
  ) {
    if (this.closed) return;
    const current = configuration.getSnapshot();
    if (current.status !== 'ready') return;
    const bindings = structuredClone(current.baseline.settings.shortcuts.bindings);
    this.set({
      action,
      generation: current.baseline.generation,
      version: current.baseline.settings.version,
      bindings,
      wheels: (bindings[action] ?? gestureDefaults(action, platform)).filter(
        (value) => parseLegacyShortcut(value, platform)?.kind === 'wheel',
      ),
    });
  }
  review(configuration: ConfigurationClientActions) {
    if (!this.value) return;
    const current = configuration.getSnapshot();
    if (current.status === 'ready')
      this.set({
        ...this.value,
        generation: current.baseline.generation,
        version: current.baseline.settings.version,
        bindings: structuredClone(current.baseline.settings.shortcuts.bindings),
      });
  }
  change(wheels: readonly string[]) {
    if (this.value) this.set({ ...this.value, wheels: [...wheels] });
  }
  clear() {
    this.set(undefined);
  }
  close() {
    this.closed = true;
    this.value = undefined;
    this.listeners.clear();
  }
  private set(value: Review | undefined) {
    if (this.closed) return;
    this.value = value;
    for (const listener of [...this.listeners]) listener();
  }
}
const label = (action: GestureAction) =>
  action === 'terminal_zoominTerminal'
    ? ('shortcuts.action.zoomInTerminal' as const)
    : ('shortcuts.action.zoomOutTerminal' as const);
export function installTerminalGestureUi(ctx: Context): void {
  const configuration = ctx.configurationActions,
    commands = new TerminalGestureCommands(configuration),
    store = new GestureEditorStore(),
    platform = ctx.shortcuts.platform;
  ctx.effect(() => async () => {
    store.close();
    await commands.close();
  });
  ctx.slots.inject('shortcuts.gesture-rows', function* () {
    yield ctx.slots.register(
      { name: 'shortcuts.gesture-rows', id: 'terminals.gesture-rows', locale: 'shortcuts' },
      function Rows({
        t,
        classes,
        startIndex,
        editing,
        selectEditor,
      }: PropsLocale<'shortcuts'> & ShortcutReferenceSeat) {
        const current = useSyncExternalStore(configuration.subscribe, configuration.getSnapshot),
          editor = useSyncExternalStore(store.subscribe, store.getSnapshot),
          state = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
        const bindings =
          current.status === 'ready' ? current.baseline.settings.shortcuts.bindings : {};
        return (
          <>
            {GESTURE_ACTIONS.map((action, index) => {
              const wheels = (bindings[action] ?? gestureDefaults(action, platform)).filter(
                (value) => parseLegacyShortcut(value, platform)?.kind === 'wheel',
              );
              return (
                <div
                  className={editing === 'gesture:' + action ? classes.editingRow : classes.row}
                  data-shortcut-gesture={action}
                  role="row"
                  key={action}
                >
                  <span className={classes.index} role="cell">
                    {String(startIndex + index).padStart(2, '0')}
                  </span>
                  <span className={classes.description} role="cell">
                    <strong>{t(label(action))}</strong>
                    <small>{action}</small>
                  </span>
                  <span className={classes.scope} role="cell">
                    {t('shortcuts.terminal')}
                  </span>
                  <span className={classes.bindings} role="cell">
                    {wheels.length ? (
                      wheels.map((value) => (
                        <kbd key={value}>
                          {value
                            .split('+')
                            .map((value) =>
                              value === 'wheelup'
                                ? t('shortcuts.wheelUp')
                                : value === 'wheeldown'
                                  ? t('shortcuts.wheelDown')
                                  : value === 'meta' && platform === 'macos'
                                    ? '⌘'
                                    : value === 'ctrl'
                                      ? 'Ctrl'
                                      : value === 'alt'
                                        ? 'Alt'
                                        : value === 'shift'
                                          ? 'Shift'
                                          : value,
                            )
                            .join(platform === 'macos' ? '' : ' + ')}
                        </kbd>
                      ))
                    ) : (
                      <em>{t('shortcuts.notSet')}</em>
                    )}
                  </span>
                  <span className={classes.actions} role="cell">
                    <button
                      type="button"
                      aria-label={t('shortcuts.editNamed', { name: t(label(action)) })}
                      disabled={
                        state.busy ||
                        (state.uncertain && editor?.action !== action) ||
                        editing !== undefined ||
                        current.status !== 'ready'
                      }
                      onClick={() => {
                        if (!state.uncertain) store.open(action, configuration, platform);
                        selectEditor('gesture:' + action);
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                  </span>
                </div>
              );
            })}
          </>
        );
      },
    );
  });
  ctx.slots.inject('shortcuts.gesture-editor', function* () {
    yield ctx.slots.register(
      { name: 'shortcuts.gesture-editor', id: 'terminals.gesture-editor', locale: 'shortcuts' },
      function Editor(props: PropsLocale<'shortcuts'> & ShortcutReferenceSeat) {
        const review = useSyncExternalStore(store.subscribe, store.getSnapshot);
        return review && props.editing === 'gesture:' + review.action ? (
          <GestureEditor
            key={review.action}
            {...props}
            ctx={ctx}
            review={review}
            store={store}
            commands={commands}
          />
        ) : null;
      },
    );
  });
}
function GestureEditor({
  t,
  classes,
  ctx,
  review,
  store,
  commands,
  selectEditor,
}: PropsLocale<'shortcuts'> &
  ShortcutReferenceSeat & {
    ctx: Context;
    review: Review;
    store: GestureEditorStore;
    commands: TerminalGestureCommands;
  }) {
  const command = useSyncExternalStore(commands.subscribe, commands.getSnapshot),
    configuration = useSyncExternalStore(
      ctx.configurationActions.subscribe,
      ctx.configurationActions.getSnapshot,
    );
  const [message, setMessage] = useState(''),
    [ready, setReady] = useState(ctx.shortcuts.runtime === 'web');
  const capture = useRef<HTMLDivElement>(null),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    void ctx.shortcuts.recording(true).then(
      () => {
        if (active) {
          setReady(true);
          capture.current?.focus();
        }
      },
      () => {
        if (active) setMessage(t('protocol.native-failed'));
      },
    );
    return () => {
      active = false;
      mounted.current = false;
      void ctx.shortcuts.recording(false).catch(() => {});
    };
  }, [ctx, t]);
  const captureState = useRef({ ready, command, review });
  useLayoutEffect(() => {
    captureState.current = { ready, command, review };
  }, [ready, command, review]);
  useEffect(() => {
    const element = capture.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const { ready, command, review } = captureState.current;
      if (!ready || command.busy || command.uncertain) return;
      const chord = gestureChord(event);
      if (!chord) return;
      const current = review.wheels;
      if (!current.includes(chord))
        store.change(current.length >= 2 ? [current[1]!, chord] : [...current, chord]);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [store]);
  const stale =
    configuration.status !== 'ready' ||
    configuration.baseline.generation !== review.generation ||
    configuration.baseline.settings.version !== review.version;
  const save = async () => {
    if (command.busy) return;
    if (stale && !command.uncertain) {
      setMessage(t('protocol.stale'));
      return;
    }
    try {
      if (command.uncertain) await commands.retry();
      else
        await commands.save(
          replaceGestureBindings(
            review.bindings,
            review.action,
            review.wheels,
            ctx.shortcuts.platform,
          ),
        );
      await ctx.shortcuts.recording(false);
      if (mounted.current) {
        store.clear();
        selectEditor(undefined);
      }
    } catch {
      if (mounted.current) setMessage(t('shortcuts.saveError'));
    }
  };
  return (
    <div
      className={classes.editor}
      role="dialog"
      aria-label={t('shortcuts.edit')}
      data-terminal-gesture-editor=""
      data-shortcut-capture="true"
    >
      <div>
        <small>EDIT SHORTCUT</small>
        <strong>{t(label(review.action))}</strong>
      </div>
      <div
        className={classes.capture}
        ref={capture}
        tabIndex={ready ? 0 : -1}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || event.key === 'Tab') return;
          event.preventDefault();
          event.stopPropagation();
          if (command.busy || command.uncertain) return;
          if (event.key === 'Escape') {
            store.clear();
            selectEditor(undefined);
          } else if (event.key === 'Backspace' || event.key === 'Delete') store.change([]);
        }}
      >
        {review.wheels.length ? (
          review.wheels.map((value) => (
            <button
              key={value}
              type="button"
              title={t('shortcuts.removeBinding')}
              disabled={command.busy || command.uncertain}
              onClick={() => store.change(review.wheels.filter((chord) => chord !== value))}
            >
              <kbd>{value}</kbd>
              <X size={11} />
            </button>
          ))
        ) : (
          <span>{t('shortcuts.captureHint')}</span>
        )}
      </div>
      {stale && !command.uncertain && (
        <p className={classes.error} role="status">
          {t('protocol.stale')}
          <button
            type="button"
            disabled={command.busy}
            onClick={() => store.review(ctx.configurationActions)}
          >
            {t('protocol.review')}
          </button>
        </p>
      )}
      {message && (
        <p className={classes.error} role="alert">
          {message}
        </p>
      )}
      <div className={classes.editorActions}>
        <button
          type="button"
          onClick={() => store.change([])}
          disabled={command.busy || command.uncertain}
        >
          <Trash2 size={13} />
          {t('shortcuts.clear')}
        </button>
        <button
          type="button"
          onClick={() => store.change(gestureDefaults(review.action, ctx.shortcuts.platform))}
          disabled={command.busy || command.uncertain}
        >
          {t('shortcuts.restoreDefaults')}
        </button>
        <button
          type="button"
          onClick={() => {
            store.clear();
            selectEditor(undefined);
          }}
          disabled={command.busy || command.uncertain}
        >
          <X size={13} />
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className={classes.primary}
          onClick={() => void save()}
          disabled={!ready || command.busy || (stale && !command.uncertain)}
        >
          <Check size={13} />
          {t('shortcuts.apply')}
        </button>
      </div>
    </div>
  );
}
