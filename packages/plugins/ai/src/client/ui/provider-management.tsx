import { useRef, useState, type FormEvent } from 'react';
import {
  aiProviderSchema,
  type AiProviderPatch,
  type PiCatalogProvider,
  type PiLoginState,
} from '@axterm/plugin-api/ai';
import type { ProviderAction } from './provider-detail.tsx';
import type { AiPanelActions } from './panel-actions.ts';
import { ErrorBanner, Modal } from './panel-scaffold.tsx';
import { ProviderLogin } from './provider-login.tsx';
import { aiFailureMessage } from './failure-message.ts';
import { useI18n } from './i18n.tsx';
import { cx } from './styles.ts';

export function ProviderManagement({
  action,
  client,
  catalog,
  onClose,
  onSuccess,
}: {
  action: ProviderAction;
  client: AiPanelActions;
  catalog: PiCatalogProvider[] | undefined;
  onClose(): void;
  onSuccess(): void;
}) {
  const { x } = useI18n();
  const lock = useRef(false);
  const [generation] = useState(() => {
    const snapshot = client.model.getSnapshot();
    return snapshot.status === 'ready' ? snapshot.baseline.generation : undefined;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [login, setLogin] = useState<PiLoginState>();
  const editing = action.kind === 'edit' ? action.provider : undefined;
  const pi = editing?.engineId === 'pi' ? editing : undefined;
  const piLogin = pi?.pi?.credentialMode === 'pi';
  const loginProvider = piLogin
    ? catalog?.find(
        ({ id, apiKeyAvailable, oauth }) => id === pi.pi?.id && (apiKeyAvailable || oauth),
      )
    : undefined;

  function current() {
    const snapshot = client.model.getSnapshot();
    return (
      snapshot.status === 'ready' &&
      snapshot.baseline.generation === generation &&
      snapshot.baseline.providers.some(
        ({ id, version }) => id === action.provider.id && version === action.provider.version,
      )
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current) return;
    if (!current()) {
      setError(x('ai.providerChanged'));
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    const createdRefs: string[] = [];
    let updateStarted = false;
    try {
      if (!editing) {
        await client.deleteAiProvider(action.provider);
      } else {
        const form = new FormData(event.currentTarget);
        const name = String(form.get('name')).trim();
        const patch: AiProviderPatch = { name, role: String(form.get('role')).trim() };
        const apiKey = String(form.get('apiKey') ?? '');
        const proxyPassword = String(form.get('proxyPassword') ?? '');
        if (pi) {
          const baseUrl = String(form.get('baseUrl')).trim();
          const url = String(form.get('proxyUrl')).trim();
          const username = String(form.get('proxyUsername')).trim();
          const savedProxyRef = username === pi.proxy?.username ? pi.proxy.credentialRef : null;
          if (url && !!username !== !!(proxyPassword || savedProxyRef)) {
            setError(x('ai.providerProxyPairRequired'));
            return;
          }
          patch.timeoutMs = Number(form.get('timeoutMs'));
          if (baseUrl || pi.baseUrl) patch.baseUrl = baseUrl;
          patch.proxy = url
            ? {
                url,
                username: username || null,
                credentialRef: proxyPassword ? 'pending' : savedProxyRef,
              }
            : null;
          if (login?.status === 'succeeded' && login.credentialRef)
            patch.credentialRef = login.credentialRef;
        }
        if (!aiProviderSchema.safeParse({ ...editing, ...patch }).success) {
          setError(x('ai.providerInvalid'));
          return;
        }
        if (apiKey) {
          const { ref } = await client.createCredential({
            kind: 'aiApiKey',
            label: `${name} API Key`,
            secret: apiKey,
          });
          createdRefs.push(ref);
          patch.credentialRef = ref;
        }
        if (patch.proxy && proxyPassword) {
          const { ref } = await client.createCredential({
            kind: 'proxyPassword',
            label: `${name} AI Proxy`,
            secret: proxyPassword,
          });
          createdRefs.push(ref);
          patch.proxy.credentialRef = ref;
        }
        if (!current()) {
          setError(x('ai.providerChanged'));
          return;
        }
        updateStarted = true;
        await client.updateAiProvider(editing, patch);
      }
      onSuccess();
    } catch (cause) {
      const reason =
        cause &&
        typeof cause === 'object' &&
        'code' in cause &&
        cause.code === 'ai/failure' &&
        'details' in cause &&
        cause.details &&
        typeof cause.details === 'object' &&
        'reason' in cause.details
          ? cause.details.reason
          : undefined;
      if (reason === 'precondition' || reason === 'not-found' || reason === 'invalid')
        updateStarted = false;
      setError(
        reason === 'precondition' || reason === 'not-found'
          ? x('ai.providerChanged')
          : reason === 'invalid'
            ? x('ai.providerInvalid')
            : aiFailureMessage(cause, x),
      );
    } finally {
      // An interrupted response can follow a committed update.
      if (!updateStarted)
        await Promise.allSettled(createdRefs.map((ref) => client.deleteCredential(ref)));
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal
      title={x(editing ? 'ai.editProvider' : 'ai.deleteProvider')}
      onClose={() => {
        if (!lock.current) onClose();
      }}
    >
      <form
        className={cx('ai-provider-management')}
        aria-busy={busy}
        onSubmit={(event) => void submit(event)}
      >
        {editing ? (
          <fieldset disabled={busy}>
            <label>
              {x('panels.name')}
              <input
                name="name"
                defaultValue={editing.name}
                maxLength={120}
                data-autofocus
                required
              />
            </label>
            {pi && (
              <>
                <label>
                  {x('panels.baseUrl')}
                  <input name="baseUrl" defaultValue={pi.baseUrl} required={!!pi.baseUrl} />
                </label>
                {loginProvider && (
                  <ProviderLogin provider={loginProvider} client={client} onChange={setLogin} />
                )}
                {!piLogin && (
                  <label>
                    {x('panels.apiKey')}
                    <input
                      name="apiKey"
                      type="password"
                      autoComplete="off"
                      placeholder={x('ai.keepCredential')}
                    />
                  </label>
                )}
                <label>
                  {x('ai.timeout')}
                  <input
                    name="timeoutMs"
                    type="number"
                    min="1000"
                    max="300000"
                    defaultValue={pi.timeoutMs}
                    required
                  />
                </label>
                <label>
                  {x('ai.proxyUrl')}
                  <input name="proxyUrl" defaultValue={pi.proxy?.url} />
                </label>
                <label>
                  {x('ai.proxyUsername')}
                  <input
                    name="proxyUsername"
                    defaultValue={pi.proxy?.username ?? ''}
                    autoComplete="off"
                  />
                </label>
                <label>
                  {x('ai.proxyPassword')}
                  <input
                    name="proxyPassword"
                    type="password"
                    autoComplete="off"
                    placeholder={pi.proxy?.credentialRef ? x('ai.keepCredential') : undefined}
                  />
                </label>
              </>
            )}
            <label>
              {x('ai.systemRole')}
              <textarea
                name="role"
                defaultValue={editing.role}
                rows={3}
                maxLength={16384}
                required
              />
            </label>
          </fieldset>
        ) : (
          <p>{x('ai.deleteProviderConfirm', { name: action.provider.name })}</p>
        )}
        {error && <ErrorBanner text={error} />}
        <div className={cx('ai-provider-dialog-actions')}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            data-autofocus={!editing || undefined}
          >
            {x('common.cancel')}
          </button>
          <button
            type="submit"
            className={cx(editing ? 'primary' : 'ai-provider-delete')}
            disabled={busy || login?.status === 'running'}
          >
            {x(
              editing
                ? busy
                  ? 'ai.providerSaving'
                  : 'common.save'
                : busy
                  ? 'ai.providerDeleting'
                  : 'common.delete',
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
