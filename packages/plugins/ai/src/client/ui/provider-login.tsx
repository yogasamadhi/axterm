import { useEffect, useState, useId, useRef } from 'react';
import type { PiCatalogProvider, PiLoginState } from '@axterm/plugin-api/ai';
import type { AiPanelActions } from './panel-actions.ts';
import { useI18n } from './i18n.tsx';
import { cx } from './styles.ts';

/** Displays Pi's own prompts; passwords and authorization codes leave React only on Submit. */
export function ProviderLogin({
  provider,
  client,
  authMethod,
  onChange,
}: {
  provider: PiCatalogProvider;
  client: AiPanelActions;
  authMethod?: 'api_key' | 'oauth';
  onChange(value: PiLoginState | undefined): void;
}) {
  const { x } = useI18n();
  const answerId = useId();
  const alive = useRef(true);
  const activeLogin = useRef<string>();
  const answeredPrompt = useRef<string>();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [selectedMethod, setSelectedMethod] = useState<'api_key' | 'oauth'>(
    provider.apiKeyAvailable ? 'api_key' : 'oauth',
  );
  const method = authMethod ?? selectedMethod;
  const openAi = provider.id === 'openai' || provider.id === 'openai-codex';
  const loginLabel =
    method === 'oauth'
      ? ((openAi ? x('ai.signInWithChatGpt') : provider.oauth?.label) ?? x('ai.piLogin'))
      : x('ai.piLogin');
  const [id, setId] = useState<string>();
  const [state, setState] = useState<PiLoginState>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!id) return;
    let closed = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const value = await client.getProviderLogin(id);
        if (closed || activeLogin.current !== id) return;
        failures = 0;
        setFailed(false);
        if (value.prompt?.id === answeredPrompt.current) delete value.prompt;
        setState(value);
        onChange(value);
        if (value.status === 'running') timer = setTimeout(() => void poll(), 300);
      } catch {
        if (closed || activeLogin.current !== id) return;
        setFailed(true);
        if (++failures < 3) timer = setTimeout(() => void poll(), 300);
        else {
          activeLogin.current = undefined;
          setId(undefined);
          setState(undefined);
          onChange(undefined);
        }
      }
    };
    void poll();
    return () => {
      closed = true;
      clearTimeout(timer);
      void client.cancelProviderLogin(id).catch(() => {});
    };
  }, [client, id, onChange]);
  async function begin() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    activeLogin.current = undefined;
    answeredPrompt.current = undefined;
    setId(undefined);
    setState(undefined);
    onChange(undefined);
    try {
      if (id) await client.cancelProviderLogin(id);
      const value = await client.beginProviderLogin(provider.id, method);
      if (!alive.current) {
        await client.cancelProviderLogin(value.id);
        return;
      }
      activeLogin.current = value.id;
      setState(value);
      onChange(value);
      setId(value.id);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  async function respond() {
    if (busy || !id || !state?.prompt || answeredPrompt.current === state.prompt.id) return;
    const control = document.getElementById(answerId) as
      HTMLInputElement | HTMLSelectElement | null;
    if (!control) return;
    setBusy(true);
    const answer = control.value;
    const promptId = state.prompt.id;
    answeredPrompt.current = promptId;
    control.value = '';
    try {
      await client.respondProviderLogin(id, promptId, answer);
      if (alive.current && activeLogin.current === id)
        setState((current) => {
          if (current?.prompt?.id !== promptId) return current;
          const { prompt: _prompt, ...rest } = current;
          return rest;
        });
    } catch {
      if (alive.current && activeLogin.current === id) {
        answeredPrompt.current = undefined;
        setFailed(true);
      }
    } finally {
      setBusy(false);
    }
  }
  async function open(url: string) {
    try {
      await client.openLoginUrl(url);
    } catch {
      setFailed(true);
    }
  }
  return (
    <section className={cx('full-field')} aria-label={loginLabel}>
      {!authMethod && provider.apiKeyAvailable && provider.oauth && (
        <label>
          {x('ai.authMethod')}
          <select
            value={selectedMethod}
            disabled={busy || state?.status === 'running'}
            onChange={(event) => {
              setSelectedMethod(event.currentTarget.value === 'oauth' ? 'oauth' : 'api_key');
              setState(undefined);
              onChange(undefined);
            }}
          >
            <option value="api_key">{x('panels.apiKey')}</option>
            <option value="oauth">{provider.oauth.label}</option>
          </select>
        </label>
      )}
      <button
        type="button"
        disabled={busy || state?.status === 'running'}
        onClick={() => void begin()}
      >
        {loginLabel}
      </button>
      {id && state?.status === 'running' && (
        <button
          type="button"
          onClick={() => {
            void client
              .cancelProviderLogin(id)
              .then(() => {
                if (!alive.current || activeLogin.current !== id) return;
                activeLogin.current = undefined;
                setId(undefined);
                setState(undefined);
                onChange(undefined);
              })
              .catch(() => {
                if (alive.current && activeLogin.current === id) setFailed(true);
              });
          }}
        >
          {x('panels.cancel')}
        </button>
      )}
      {state?.events.map((event, index) => (
        <div key={index}>
          {event.type === 'auth_url' ? (
            <>
              <p>{event.instructions}</p>
              <button type="button" onClick={() => void open(event.url)}>
                {x('ai.openLogin')}
              </button>
            </>
          ) : event.type === 'device_code' ? (
            <>
              <code>{event.userCode}</code>
              <button type="button" onClick={() => void open(event.verificationUri)}>
                {x('ai.openLogin')}
              </button>
            </>
          ) : (
            <>
              <p>{event.message}</p>
              {event.type === 'info' &&
                event.links?.map((link) => (
                  <button key={link.url} type="button" onClick={() => void open(link.url)}>
                    {link.label ?? link.url}
                  </button>
                ))}
            </>
          )}
        </div>
      ))}
      {state?.prompt && (
        <div key={state.prompt.id}>
          <label htmlFor={answerId}>{state.prompt.message}</label>
          {state.prompt.type === 'select' ? (
            <select id={answerId} defaultValue={state.prompt.options?.[0]?.id}>
              {state.prompt.options?.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={answerId}
              type={
                state.prompt.type === 'secret' || state.prompt.type === 'manual_code'
                  ? 'password'
                  : 'text'
              }
              autoComplete="off"
              placeholder={state.prompt.placeholder}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void respond();
                }
              }}
            />
          )}
          <button type="button" disabled={busy} onClick={() => void respond()}>
            {x('ai.loginContinue')}
          </button>
        </div>
      )}
      {state?.status === 'succeeded' && <p role="status">{x('ai.loginSucceeded')}</p>}
      {(failed || state?.status === 'failed' || state?.status === 'canceled') && (
        <p role="alert">{x('common.operationFailed')}</p>
      )}
    </section>
  );
}
