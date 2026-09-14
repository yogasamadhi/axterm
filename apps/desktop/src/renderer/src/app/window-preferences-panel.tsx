import { useEffect, useState, type FormEvent } from 'react';
import type { createRuntimeClient } from '@workspace/client';
import type { DesktopWindowPreferencesResult } from '@workspace/contracts/desktop';
import { LoaderCircle, MonitorCog, RotateCcw, Save } from 'lucide-react';
import {
  parseWindowPreferencesDraft,
  toWindowPreferencesDraft,
  type WindowPreferencesDraft,
} from './window-preferences-model';
import { useI18n } from '../i18n/context';

type Client = ReturnType<typeof createRuntimeClient>;

export function WindowPreferencesPanel({ client }: { client: Client }) {
  const { x } = useI18n();
  const [result, setResult] = useState<DesktopWindowPreferencesResult>();
  const [draft, setDraft] = useState<WindowPreferencesDraft>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let canceled = false;
    void client
      .windowPreferences()
      .then((next) => {
        if (canceled) return;
        setResult(next);
        setDraft(toWindowPreferencesDraft(next.preferences));
      })
      .catch((cause) => {
        if (!canceled) setError(preferenceError('load', cause, x));
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [client, x]);

  async function retryLoad() {
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const next = await client.windowPreferences();
      applyResult(next);
    } catch (cause) {
      setError(preferenceError('load', cause, x));
    } finally {
      setLoading(false);
    }
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
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const next = await client.updateWindowPreferences(parsed.value);
      applyResult(next);
      setNotice(
        x(next.requiresRestart ? 'windowPreferences.savedRestart' : 'windowPreferences.saved'),
      );
    } catch (cause) {
      setError(preferenceError('save', cause, x));
    } finally {
      setSaving(false);
    }
  }

  async function resetBounds() {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const next = await client.updateWindowPreferences({ bounds: null });
      applyResult(next);
      setNotice(x('windowPreferences.boundsReset'));
    } catch (cause) {
      setError(preferenceError('resetBounds', cause, x));
    } finally {
      setSaving(false);
    }
  }

  function applyResult(next: DesktopWindowPreferencesResult) {
    setResult(next);
    setDraft(toWindowPreferencesDraft(next.preferences));
  }

  return (
    <section className="surface stack" aria-labelledby="window-preferences-title">
      <h3 id="window-preferences-title">
        <MonitorCog size={14} aria-hidden="true" /> {x('windowPreferences.title')}
      </h3>
      <p className="hint">{x('windowPreferences.localOnly')}</p>
      {loading ? (
        <p className="hint" role="status">
          <LoaderCircle className="spin" size={13} aria-hidden="true" />{' '}
          {x('windowPreferences.loading')}
        </p>
      ) : error && !draft ? (
        <div className="stack">
          <p className="danger-text" role="alert">
            {error}
          </p>
          <button type="button" onClick={() => void retryLoad()}>
            {x('windowPreferences.retry')}
          </button>
        </div>
      ) : draft && result ? (
        <form className="stack" onSubmit={(event) => void savePreferences(event)}>
          <div className="form-grid">
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
              <small className="hint" id="window-opacity-help">
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
              <small className="hint" id="window-zoom-help">
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
            <label className="checkbox-line">
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
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={draft.allowMultiInstance}
                disabled={saving}
                onChange={(event) =>
                  setDraft({ ...draft, allowMultiInstance: event.target.checked })
                }
              />
              {x('windowPreferences.allowMultipleInstances')}
              <small className="hint">{x('windowPreferences.afterRestart')}</small>
            </label>
          </div>
          {result.requiresRestart && (
            <p className="hint" role="status">
              {x('windowPreferences.restartPending')}
            </p>
          )}
          {error && (
            <p className="danger-text" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="hint" role="status" aria-live="polite">
              {notice}
            </p>
          )}
          <div className="modal-actions">
            <button
              type="button"
              disabled={saving || result.preferences.bounds === null}
              onClick={() => void resetBounds()}
            >
              <RotateCcw size={13} aria-hidden="true" /> {x('windowPreferences.resetBounds')}
            </button>
            <button className="primary" type="submit" disabled={saving}>
              {saving ? (
                <LoaderCircle className="spin" size={13} aria-hidden="true" />
              ) : (
                <Save size={13} aria-hidden="true" />
              )}
              {x('windowPreferences.save')}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function preferenceError(
  action: 'load' | 'save' | 'resetBounds',
  cause: unknown,
  x: ReturnType<typeof useI18n>['x'],
): string {
  const detail = cause instanceof Error && cause.message.trim() ? `: ${cause.message}` : '';
  const actionLabel = x(
    action === 'load'
      ? 'windowPreferences.actionLoad'
      : action === 'save'
        ? 'windowPreferences.actionSave'
        : 'windowPreferences.actionResetBounds',
  );
  return x('windowPreferences.actionError', { action: actionLabel, detail });
}
