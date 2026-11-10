import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { LoaderCircle, Network, Save } from 'lucide-react';
import type { ConfigurationClientActions, Settings } from '@axterm/plugin-api/configuration';
import type { ConnectionsModel } from '../../index.ts';
import type { ProxySave } from './proxy-save.ts';
import {
  createProxyTestRequest,
  normalizeProxyUsername,
  retainedProxyCredentialRef,
  type ProxyDraft,
  type ProxyMode,
} from './proxy-model.ts';
import { useI18n } from './i18n.tsx';
import { cx } from './styles.ts';
import { ErrorBanner } from './scaffold.tsx';
export function ProxySettingsPanel({
  settings,
  model,
  workflow,
}: {
  settings: ConfigurationClientActions;
  model: ConnectionsModel;
  workflow: ProxySave;
}) {
  const { x } = useI18n(),
    state = useSyncExternalStore(settings.subscribe, settings.getSnapshot);
  return (
    <section className={cx('surface stack')} aria-labelledby="proxy-settings-title">
      <h3 id="proxy-settings-title">
        <Network size={14} aria-hidden="true" /> {x('proxy.title')}
      </h3>
      {state.status === 'ready' ? (
        <GlobalProxyForm
          key={
            state.baseline.generation + ':' + JSON.stringify(state.baseline.settings.network.proxy)
          }
          settings={state.baseline.settings}
          model={model}
          workflow={workflow}
        />
      ) : (
        <p role="status" className={cx('hint')}>
          {x('proxy.loading')}
        </p>
      )}
    </section>
  );
}
function GlobalProxyForm({
  settings,
  model,
  workflow,
}: {
  settings: Settings;
  model: ConnectionsModel;
  workflow: ProxySave;
}) {
  const { x } = useI18n(),
    current = settings.network.proxy;
  const [mode, setMode] = useState<ProxyMode>(current.mode),
    [busy, setBusy] = useState<'test'>(),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const saving = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot);
  const test = useRef<AbortController>();
  useEffect(() => () => test.current?.abort(), []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || saving.status === 'running' || saving.status === 'uncertain') return;
    const element = event.currentTarget,
      form = new FormData(element),
      action =
        ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value ?? 'save';
    setError('');
    setNotice('');
    if (action === 'test') {
      const draft = proxyDraftFromForm(form, mode),
        request = createProxyTestRequest(draft, current);
      draft.password = '';
      form.delete('proxyPassword');
      if (!request.ok) {
        setError(x(proxyTestErrorKeys[request.code]));
        return;
      }
      const controller = new AbortController();
      test.current = controller;
      setBusy('test');
      try {
        const result = await model.testProxy(request.value, controller.signal);
        if (!controller.signal.aborted)
          setNotice(
            x('proxy.availableVia', {
              protocol: result.protocol.toUpperCase(),
              host: result.proxyHost,
              port: result.proxyPort,
              latency: result.latencyMs,
            }),
          );
      } catch {
        if (!controller.signal.aborted) setError(x('proxy.operationFailed'));
      } finally {
        if (request.value.source.kind === 'custom') delete request.value.source.temporaryPassword;
        if (test.current === controller) test.current = undefined;
        setBusy(undefined);
      }
      return;
    }
    try {
      let proxy: Settings['network']['proxy'] = { mode: 'direct' };
      const password = mode === 'custom' ? String(form.get('proxyPassword') ?? '') : '';
      if (mode === 'custom') {
        const username = normalizeProxyUsername(String(form.get('proxyUsername') ?? ''));
        if (!username && password) {
          setError(x('proxy.usernameRequired'));
          return;
        }
        const credentialRef = username ? retainedProxyCredentialRef(current, username) : null;
        if (username && !password && !credentialRef) {
          setError(x('proxy.passwordSaveRequired'));
          return;
        }
        proxy = {
          mode: 'custom',
          endpoint: { url: String(form.get('proxyUrl') ?? '').trim(), username, credentialRef },
        };
      }
      const pending = workflow.save(
        proxy,
        password,
        x('proxy.credentialLabel', { url: proxy.mode === 'custom' ? proxy.endpoint.url : '' }),
      );
      const field = element.elements.namedItem('proxyPassword');
      if (field instanceof HTMLInputElement) field.value = '';
      form.delete('proxyPassword');
      await pending;
    } catch {
      setError(x('proxy.operationFailed'));
    }
  }
  return (
    <form className={cx('stack')} onSubmit={(event) => void submit(event)}>
      <p className={cx('hint')}>{x('proxy.globalDescription')}</p>
      <div className={cx('form-grid')}>
        <label>
          {x('proxy.connectionMode')}
          <select
            name="proxyMode"
            value={mode}
            disabled={!!busy || saving.status === 'running' || saving.status === 'uncertain'}
            onChange={(event) => setMode(event.target.value as ProxyMode)}
          >
            <option value="direct">{x('proxy.direct')}</option>
            <option value="custom">{x('proxy.custom')}</option>
          </select>
        </label>
        {mode === 'custom' && (
          <>
            <label className={cx('full-field')}>
              {x('proxy.url')}
              <input
                name="proxyUrl"
                required
                type="url"
                placeholder={x('proxy.urlPlaceholder')}
                defaultValue={current.mode === 'custom' ? current.endpoint.url : ''}
              />
            </label>
            <label>
              {x('proxy.usernameOptional')}
              <input
                name="proxyUsername"
                autoComplete="off"
                defaultValue={current.mode === 'custom' ? (current.endpoint.username ?? '') : ''}
              />
            </label>
            <label>
              {x('proxy.password')}
              <input
                name="proxyPassword"
                type="password"
                autoComplete="new-password"
                placeholder={
                  current.mode === 'custom' && current.endpoint.credentialRef
                    ? x('proxy.savedKeepBlank')
                    : x('proxy.passwordOptional')
                }
              />
            </label>
          </>
        )}
        <label>
          {x('proxy.testTarget')}
          <input name="proxyTargetHost" required defaultValue="github.com" />
        </label>
        <label>
          {x('proxy.testPort')}
          <input
            name="proxyTargetPort"
            type="number"
            min="1"
            max="65535"
            required
            defaultValue="443"
          />
        </label>
      </div>
      {error && (
        <p className={cx('danger-text')} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={cx('hint')} role="status" aria-live="polite">
          {notice}
        </p>
      )}
      {saving.status === 'uncertain' && (
        <p role="alert">
          {x('tools.uncertain')}{' '}
          <button type="button" onClick={() => void workflow.retry()}>
            {x('tools.checkAgain')}
          </button>
        </p>
      )}
      {saving.status === 'failed' && <ErrorBanner text={x('proxy.operationFailed')} />}
      {saving.status === 'saved' && (
        <p role="status" className={cx('hint')}>
          {x('proxy.saved')}
        </p>
      )}
      {saving.credentialRetained && <p className={cx('hint')}>{x('tools.credentialRetained')}</p>}
      <div className={cx('modal-actions')}>
        <button
          type="submit"
          name="action"
          value="test"
          disabled={
            !!busy ||
            saving.status === 'running' ||
            saving.status === 'uncertain' ||
            mode === 'direct'
          }
        >
          {busy === 'test' && <LoaderCircle className={cx('spin')} size={13} aria-hidden="true" />}
          {x('proxy.test')}
        </button>
        <button
          className={cx('primary')}
          type="submit"
          name="action"
          value="save"
          disabled={!!busy || saving.status === 'running' || saving.status === 'uncertain'}
        >
          {saving.status === 'running' ? (
            <LoaderCircle className={cx('spin')} size={13} aria-hidden="true" />
          ) : (
            <Save size={13} aria-hidden="true" />
          )}
          {x('proxy.save')}
        </button>
      </div>
    </form>
  );
}
function proxyDraftFromForm(
  form: FormData,
  mode: ProxyMode,
  targetHostName = 'proxyTargetHost',
  targetPortName = 'proxyTargetPort',
): ProxyDraft {
  return {
    mode,
    url: String(form.get('proxyUrl') ?? ''),
    username: String(form.get('proxyUsername') ?? ''),
    password: String(form.get('proxyPassword') ?? ''),
    targetHost: String(form.get(targetHostName) ?? ''),
    targetPort: String(form.get(targetPortName) ?? ''),
  };
}

const proxyTestErrorKeys = {
  invalidTarget: 'proxy.invalidTarget',
  directNoTest: 'proxy.directNoTest',
  passwordRequired: 'proxy.passwordTestRequired',
  usernameRequired: 'proxy.usernameRequired',
} as const;
