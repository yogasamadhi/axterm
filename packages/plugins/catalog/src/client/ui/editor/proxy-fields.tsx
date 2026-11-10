import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { Host, ConnectionClientActions } from '@axterm/plugin-api/connections';
import { createProxyTestRequest, type ProxyMode, type ProxyDraft } from './proxy-model.ts';
import { useI18n } from '../i18n.tsx';
import styles from './editor.module.css';
const classes = (value: string) =>
  value
    .split(/\s+/u)
    .filter(Boolean)
    .map((name) => name + ' ' + (styles[name] ?? ''))
    .join(' ');
export function HostProxyFields({
  actions,
  host,
  className = '',
  dataTab,
}: {
  actions: Pick<ConnectionClientActions, 'testProxy'>;
  host: Host | undefined;
  className?: string;
  dataTab?: string;
}) {
  const { x } = useI18n();
  const current = host?.proxy;
  const [mode, setMode] = useState<HostProxyMode>(current?.mode ?? 'inherit');
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  async function test(formElement: HTMLFormElement | null) {
    if (!formElement) return;
    setError('');
    setNotice('');
    if (mode === 'command') return;
    const draft = proxyDraftFromForm(new FormData(formElement), mode, 'hostname', 'port');
    const request = createProxyTestRequest(draft, current);
    if (!request.ok) {
      setError(x(proxyTestErrorKeys[request.code]));
      return;
    }
    setTesting(true);
    try {
      const result = await actions.testProxy(request.value);
      setNotice(
        x('proxy.availableTarget', {
          host: result.target.host,
          port: result.target.port,
          latency: result.latencyMs,
        }),
      );
    } catch (cause) {
      setError(messageOf(cause, x));
    } finally {
      setTesting(false);
    }
  }
  return (
    <fieldset
      className={classes(`connection-options full-field ${className}`.trim())}
      data-tab={dataTab}
    >
      <legend>{x('proxy.title')}</legend>
      <label>
        {x('proxy.policy')}
        <select
          name="proxyMode"
          value={mode}
          onChange={(event) => setMode(event.target.value as HostProxyMode)}
        >
          <option value="inherit">{x('proxy.inherit')}</option>
          <option value="direct">{x('proxy.direct')}</option>
          <option value="custom">{x('proxy.custom')}</option>
          <option value="command">ProxyCommand</option>
        </select>
      </label>
      {mode === 'custom' && (
        <>
          <label className={classes('full-field')}>
            {x('proxy.url')}
            <input
              name="proxyUrl"
              required
              type="url"
              placeholder={x('proxy.urlPlaceholder')}
              defaultValue={current?.mode === 'custom' ? current.endpoint.url : ''}
            />
          </label>
          <label>
            {x('proxy.usernameOptional')}
            <input
              name="proxyUsername"
              autoComplete="off"
              defaultValue={current?.mode === 'custom' ? (current.endpoint.username ?? '') : ''}
            />
          </label>
          <label>
            {x('proxy.password')}
            <input
              name="proxyPassword"
              type="password"
              autoComplete="new-password"
              placeholder={
                current?.mode === 'custom' && current.endpoint.credentialRef
                  ? x('proxy.savedKeepBlank')
                  : x('proxy.passwordOptional')
              }
            />
          </label>
        </>
      )}
      {mode === 'command' && (
        <>
          <label className={classes('full-field')}>
            {x('proxy.executable')}
            <input
              name="proxyCommandExecutable"
              required
              autoComplete="off"
              placeholder={x('proxy.executablePlaceholder')}
              defaultValue={current?.mode === 'command' ? current.command.executable : ''}
            />
          </label>
          <label className={classes('full-field')}>
            {x('proxy.arguments')}
            <textarea
              name="proxyCommandArguments"
              required
              rows={5}
              spellCheck={false}
              placeholder={'-W\n%h:%p\njump.example.com'}
              defaultValue={current?.mode === 'command' ? current.command.arguments.join('\n') : ''}
            />
          </label>
        </>
      )}
      <p className={classes('hint')}>
        {mode === 'command' ? x('proxy.commandDescription') : x('proxy.hostDescription')}
      </p>
      <div className={classes('modal-actions full-field')}>
        <button
          type="button"
          disabled={testing || mode === 'direct' || mode === 'command'}
          onClick={(event) => void test(event.currentTarget.form)}
        >
          {testing && <LoaderCircle className={classes('spin')} size={13} aria-hidden="true" />}{' '}
          {x('proxy.test')}
        </button>
      </div>
      {error && (
        <p className={classes('danger-text full-field')} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={classes('hint full-field')} role="status" aria-live="polite">
          {notice}
        </p>
      )}
    </fieldset>
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
type HostProxyMode = ProxyMode | 'command';
const proxyTestErrorKeys = {
  invalidTarget: 'proxy.invalidTarget',
  directNoTest: 'proxy.directNoTest',
  passwordRequired: 'proxy.passwordTestRequired',
  usernameRequired: 'proxy.usernameRequired',
} as const;
function messageOf(_value: unknown, x: ReturnType<typeof useI18n>['x']) {
  return x('proxy.operationFailed');
}
