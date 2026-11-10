import { useState, useSyncExternalStore, type FormEvent } from 'react';
import type { DesktopWindowPreferencesPatch } from '@axterm/plugin-api/desktop';
import type { DesktopPreferencesModel } from './preferences-model.ts';
import type { DesktopPreferenceCommands } from './preferences-commands.ts';
import type { PreferenceTranslate } from './preferences-locales.ts';
import { cx } from './preferences-styles.ts';
import { LoaderCircle, MonitorCog, RotateCcw, Save } from 'lucide-react';
import {
  parseWindowPreferencesDraft,
  toWindowPreferencesDraft,
  type WindowPreferencesDraft,
} from './preferences-draft.ts';

export function WindowPreferencesPanel({
  model,
  commands,
  x,
}: {
  model: DesktopPreferencesModel;
  commands: DesktopPreferenceCommands;
  x: PreferenceTranslate;
}) {
  const facts = useSyncExternalStore(model.subscribe, model.getSnapshot),
    command = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  const result =
    facts.status === 'ready'
      ? {
          preferences: facts.baseline.record.preferences,
          requiresRestart: facts.baseline.native?.requiresRestart ?? false,
        }
      : undefined;
  const [draft, setDraft] = useState<WindowPreferencesDraft>();
  const [review, setReview] = useState<{ version: number; generation: string }>();
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const saving = command.busy || command.uncertain,
    loading = facts.status === 'connecting';
  const applyResult = () => {
    const current = model.getSnapshot();
    if (current.status === 'ready') {
      setDraft(toWindowPreferencesDraft(current.baseline.record.preferences));
      setReview({
        version: current.baseline.record.version,
        generation: current.baseline.generation,
      });
    }
  };
  if (facts.status === 'ready' && (!review || review.generation !== facts.baseline.generation)) {
    setDraft(toWindowPreferencesDraft(facts.baseline.record.preferences));
    setReview({ version: facts.baseline.record.version, generation: facts.baseline.generation });
  }
  async function retryLoad() {
    try {
      await model.retry();
    } catch {
      setError(preferenceError('load', x));
    }
  }
  async function write(patch: DesktopWindowPreferencesPatch) {
    if (command.uncertain) {
      await commands.retry();
      return;
    }
    if (!review) throw Error('DESKTOP_PREFERENCE_NOT_REVIEWED');
    await commands.save(patch, review.version, review.generation);
  }
  async function savePreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const parsed = parseWindowPreferencesDraft(draft);
    if (!parsed.ok) {
      setError(x(`windowPreferences.${parsed.code}`));
      setNotice('');
      return;
    }
    setError('');
    setNotice('');
    try {
      await write(parsed.value);
      applyResult();
      const accepted = model.getSnapshot();
      setNotice(
        x(
          accepted.status === 'ready' && accepted.baseline.native?.requiresRestart
            ? 'windowPreferences.savedRestart'
            : 'windowPreferences.saved',
        ),
      );
    } catch {
      setError(preferenceError('save', x));
    }
  }

  async function resetBounds() {
    setError('');
    setNotice('');
    try {
      await write({
        bounds: null,
        rememberWindowSize: false,
      });
      applyResult();
      setNotice(x('windowPreferences.boundsReset'));
    } catch {
      setError(preferenceError('resetBounds', x));
    }
  }

  return (
    <section className={cx('preferences surface stack')} aria-labelledby="window-preferences-title">
      <h3 id="window-preferences-title">
        <MonitorCog size={14} aria-hidden="true" /> {x('windowPreferences.title')}
      </h3>
      <p className={cx('hint')}>{x('windowPreferences.localOnly')}</p>
      {loading ? (
        <p className={cx('hint')} role="status">
          <LoaderCircle className={cx('spin')} size={13} aria-hidden="true" />{' '}
          {x('windowPreferences.loading')}
        </p>
      ) : facts.status === 'error' || (error && !draft) ? (
        <div className={cx('stack')}>
          <p className={cx('danger-text')} role="alert">
            {error || preferenceError('load', x)}
          </p>
          <button type="button" onClick={() => void retryLoad()}>
            {x('windowPreferences.retry')}
          </button>
        </div>
      ) : draft && result ? (
        <form
          data-desktop-window-preferences=""
          className={cx('stack')}
          onSubmit={(event) => void savePreferences(event)}
        >
          <div className={cx('form-grid')}>
            <label>
              {x('windowPreferences.titleBar')}
              <select
                value={draft.titleBarStyle}
                disabled={saving}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    titleBarStyle: event.target.value as WindowPreferencesDraft['titleBarStyle'],
                  })
                }
              >
                <option value="custom">{x('windowPreferences.customTitleBar')}</option>
                <option value="system">{x('windowPreferences.systemTitleBar')}</option>
              </select>
            </label>
            <label>
              {x('windowPreferences.opacity')}
              <input
                aria-describedby="window-opacity-help"
                type="number"
                min="0"
                max="1"
                step="0.05"
                inputMode="decimal"
                value={draft.opacity}
                disabled={saving}
                onChange={(event) => setDraft({ ...draft, opacity: event.target.value })}
              />
              <small className={cx('hint')} id="window-opacity-help">
                {x('windowPreferences.opacityHint')}
              </small>
            </label>
            <label>
              {x('windowPreferences.zoom')}
              <input
                aria-describedby="window-zoom-help"
                type="number"
                min="0.5"
                max="8"
                step="0.25"
                inputMode="decimal"
                value={draft.zoomFactor}
                disabled={saving}
                onChange={(event) => setDraft({ ...draft, zoomFactor: event.target.value })}
              />
              <small className={cx('hint')} id="window-zoom-help">
                {x('windowPreferences.zoomHint')}
              </small>
            </label>
            <label>
              {x('windowPreferences.savedBounds')}
              <input
                readOnly
                value={
                  result.preferences.bounds
                    ? x('windowPreferences.boundsValue', result.preferences.bounds)
                    : x('windowPreferences.boundsEmpty')
                }
              />
            </label>
            <label className={cx('checkbox-line')}>
              <input
                type="checkbox"
                checked={draft.rememberWindowSize}
                disabled={saving}
                aria-label={x('windowPreferences.rememberWindowSize')}
                aria-describedby="window-remember-size-help"
                onChange={(event) =>
                  setDraft({ ...draft, rememberWindowSize: event.target.checked })
                }
              />
              {x('windowPreferences.rememberWindowSize')}
              <small className={cx('hint')} id="window-remember-size-help">
                {x('windowPreferences.rememberWindowSizeHint')}
              </small>
            </label>
            <label className={cx('checkbox-line')}>
              <input
                type="checkbox"
                checked={draft.confirmBeforeExit}
                disabled={saving}
                onChange={(event) =>
                  setDraft({ ...draft, confirmBeforeExit: event.target.checked })
                }
              />
              {x('windowPreferences.confirmBeforeExit')}
            </label>
            <label className={cx('checkbox-line')}>
              <input
                type="checkbox"
                checked={draft.allowMultiInstance}
                disabled={saving}
                onChange={(event) =>
                  setDraft({ ...draft, allowMultiInstance: event.target.checked })
                }
              />
              {x('windowPreferences.allowMultipleInstances')}
              <small className={cx('hint')}>{x('windowPreferences.singleProfileWindows')}</small>
            </label>
          </div>
          {result.requiresRestart && (
            <p className={cx('hint')} role="status">
              {x('windowPreferences.restartPending')}
            </p>
          )}
          {facts.status === 'ready' && facts.baseline.application === 'failed' && (
            <p className={cx('danger-text')} role="alert">
              {x('windowPreferences.applicationFailed')}{' '}
              <button
                type="button"
                disabled={command.busy}
                onClick={() =>
                  void model
                    .retryApplication(facts.baseline.generation)
                    .catch(() => setError(preferenceError('save', x)))
                }
              >
                {x('windowPreferences.retry')}
              </button>
            </p>
          )}
          {command.uncertain && (
            <p className={cx('danger-text')} role="alert">
              {x('windowPreferences.unknown')}
            </p>
          )}
          {error && (
            <div>
              <p className={cx('danger-text')} role="alert">
                {error}
              </p>
              {!command.uncertain && (
                <button
                  type="button"
                  disabled={command.busy}
                  onClick={() => {
                    applyResult();
                    setError('');
                  }}
                >
                  {x('windowPreferences.retry')}
                </button>
              )}
            </div>
          )}
          {notice && (
            <p className={cx('hint')} role="status" aria-live="polite">
              {notice}
            </p>
          )}
          <div className={cx('modal-actions')}>
            <button
              type="button"
              disabled={saving || result.preferences.bounds === null}
              onClick={() => void resetBounds()}
            >
              <RotateCcw size={13} aria-hidden="true" /> {x('windowPreferences.resetBounds')}
            </button>
            <button className={cx('primary')} type="submit" disabled={command.busy}>
              {command.busy ? (
                <LoaderCircle className={cx('spin')} size={13} aria-hidden="true" />
              ) : (
                <Save size={13} aria-hidden="true" />
              )}
              {x(command.uncertain ? 'windowPreferences.retry' : 'windowPreferences.save')}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function preferenceError(action: 'load' | 'save' | 'resetBounds', x: PreferenceTranslate): string {
  const actionLabel = x(
    action === 'load'
      ? 'windowPreferences.actionLoad'
      : action === 'save'
        ? 'windowPreferences.actionSave'
        : 'windowPreferences.actionResetBounds',
  );
  return x('windowPreferences.actionError', { action: actionLabel });
}
