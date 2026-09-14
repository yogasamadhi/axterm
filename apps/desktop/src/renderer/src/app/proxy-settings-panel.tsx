import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type { GlobalProxyConfig, Host, Settings } from '@workspace/contracts';
import { LoaderCircle, Network, Save } from 'lucide-react';
import { useI18n } from '../i18n/context';
import type { AxtermMessageKey } from '../i18n/core';
import {
  createProxyTestRequest,
  normalizeProxyUsername,
  proxyCredentialRefs,
  retainedProxyCredentialRef,
  type ProxyDraft,
  type ProxyMode,
} from './proxy-settings-model';

type Client = ReturnType<typeof createRuntimeClient>;

export function ProxySettingsPanel({ client }: { client: Client }) {
  const { x } = useI18n();
  const settings = useQuery({ queryKey: ['settings'], queryFn: client.settings });
  const hosts = useQuery({ queryKey: ['hosts'], queryFn: client.hosts });

  return (
    <section className="surface stack" aria-labelledby="proxy-settings-title">
      <h3 id="proxy-settings-title">
        <Network size={14} aria-hidden="true" /> {x('proxy.title')}
      </h3>
      {settings.isLoading ? (
        <p className="hint" role="status">
          <LoaderCircle className="spin" size={13} aria-hidden="true" /> {x('proxy.loading')}
        </p>
      ) : settings.error || !settings.data ? (
        <p className="danger-text" role="alert">
          {settings.error instanceof Error ? settings.error.message : x('proxy.loadFailed')}
        </p>
      ) : (
        <GlobalProxyForm
          client={client}
          settings={settings.data}
          hosts={hosts.data}
          onSaved={(next) => settings.refetch().then(() => next)}
        />
      )}
    </section>
  );
}

function GlobalProxyForm({
  client,
  settings,
  hosts,
  onSaved,
}: {
  client: Client;
  settings: Settings;
  hosts: Host[] | undefined;
  onSaved(next: Settings): Promise<unknown>;
}) {
  const { x } = useI18n();
  const current = settings.network.proxy;
  const [mode, setMode] = useState<ProxyMode>(current.mode);
  const [busy, setBusy] = useState<'save' | 'test'>();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const action =
      ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value ?? 'save';
    setError('');
    setNotice('');
    if (action === 'test') {
      const draft = proxyDraftFromForm(form, mode);
      const request = createProxyTestRequest(draft, current);
      if (!request.ok) {
        setError(x(proxyTestErrorKeys[request.code]));
        return;
      }
      setBusy('test');
      try {
        const result = await client.testProxy(request.value);
        setNotice(
          x('proxy.availableVia', {
            protocol: result.protocol.toUpperCase(),
            host: result.proxyHost,
            port: result.proxyPort,
            latency: result.latencyMs,
          }),
        );
      } catch (cause) {
        setError(messageOf(cause, x));
      } finally {
        setBusy(undefined);
      }
      return;
    }

    setBusy('save');
    let createdCredentialRef: string | undefined;
    try {
      const nextProxy = await persistedGlobalProxy(client, current, form, x, (ref) => {
        createdCredentialRef = ref;
      });
      const next = await client.updateSettings(settings, { network: { proxy: nextProxy } });
      createdCredentialRef = undefined;
      const passwordInput = formElement.elements.namedItem('proxyPassword');
      if (passwordInput instanceof HTMLInputElement) passwordInput.value = '';
      const oldRef = proxyCredentialRefs(current)[0];
      if (
        oldRef &&
        oldRef !== proxyCredentialRefs(nextProxy)[0] &&
        hosts &&
        !hosts.some((host) => proxyCredentialRefs(host.proxy).includes(oldRef))
      )
        await client.deleteCredential(oldRef).catch(() => undefined);
      setNotice(x('proxy.saved'));
      await onSaved(next);
    } catch (cause) {
      if (createdCredentialRef)
        await client.deleteCredential(createdCredentialRef).catch(() => undefined);
      setError(messageOf(cause, x));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <form className="stack" onSubmit={(event) => void submit(event)}>
      <p className="hint">{x('proxy.globalDescription')}</p>
      <div className="form-grid">
        <label>
          {x('proxy.connectionMode')}
          <select
            name="proxyMode"
            value={mode}
            disabled={!!busy}
            onChange={(event) => setMode(event.target.value as ProxyMode)}
          >
            <option value="direct">{x('proxy.direct')}</option>
            <option value="custom">{x('proxy.custom')}</option>
          </select>
        </label>
        {mode === 'custom' && (
          <>
            <label className="full-field">
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
        <button type="submit" name="action" value="test" disabled={!!busy || mode === 'direct'}>
          {busy === 'test' && <LoaderCircle className="spin" size={13} aria-hidden="true" />}
          {x('proxy.test')}
        </button>
        <button className="primary" type="submit" name="action" value="save" disabled={!!busy}>
          {busy === 'save' ? (
            <LoaderCircle className="spin" size={13} aria-hidden="true" />
          ) : (
            <Save size={13} aria-hidden="true" />
          )}
          {x('proxy.save')}
        </button>
      </div>
    </form>
  );
}

export function HostProxyFields({
  client,
  host,
  className = '',
  dataTab,
}: {
  client: Client;
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
      const result = await client.testProxy(request.value);
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
    <fieldset className={`connection-options full-field ${className}`.trim()} data-tab={dataTab}>
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
          <label className="full-field">
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
          <label className="full-field">
            {x('proxy.executable')}
            <input
              name="proxyCommandExecutable"
              required
              autoComplete="off"
              placeholder={x('proxy.executablePlaceholder')}
              defaultValue={current?.mode === 'command' ? current.command.executable : ''}
            />
          </label>
          <label className="full-field">
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
      <p className="hint">
        {mode === 'command' ? x('proxy.commandDescription') : x('proxy.hostDescription')}
      </p>
      <div className="modal-actions full-field">
        <button
          type="button"
          disabled={testing || mode === 'direct' || mode === 'command'}
          onClick={(event) => void test(event.currentTarget.form)}
        >
          {testing && <LoaderCircle className="spin" size={13} aria-hidden="true" />}{' '}
          {x('proxy.test')}
        </button>
      </div>
      {error && (
        <p className="danger-text full-field" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="hint full-field" role="status" aria-live="polite">
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

async function persistedGlobalProxy(
  client: Client,
  current: GlobalProxyConfig,
  form: FormData,
  x: ReturnType<typeof useI18n>['x'],
  created: (ref: string) => void,
): Promise<GlobalProxyConfig> {
  if (String(form.get('proxyMode')) === 'direct') return { mode: 'direct' };
  const url = String(form.get('proxyUrl') ?? '').trim();
  const username = normalizeProxyUsername(String(form.get('proxyUsername') ?? ''));
  const password = String(form.get('proxyPassword') ?? '');
  if (!username && password) throw new Error(x('proxy.usernameRequired'));
  let credentialRef = username ? retainedProxyCredentialRef(current, username) : null;
  if (username && password) {
    credentialRef = (
      await client.createCredential({
        kind: 'proxyPassword',
        label: x('proxy.credentialLabel', { url }),
        secret: password,
      })
    ).ref;
    created(credentialRef);
  }
  if (username && !credentialRef) throw new Error(x('proxy.passwordSaveRequired'));
  return { mode: 'custom', endpoint: { url, username, credentialRef } };
}

const proxyTestErrorKeys = {
  invalidTarget: 'proxy.invalidTarget',
  directNoTest: 'proxy.directNoTest',
  passwordRequired: 'proxy.passwordTestRequired',
  usernameRequired: 'proxy.usernameRequired',
} as const satisfies Record<string, AxtermMessageKey>;

function messageOf(value: unknown, x: ReturnType<typeof useI18n>['x']): string {
  return value instanceof Error && value.message.trim()
    ? value.message
    : x('proxy.operationFailed');
}
