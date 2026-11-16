// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  aiProviderSchema,
  type AiProvider,
  type AiProviderInput,
  type AiProviderPatch,
  type PiCatalogProvider,
  type PiLoginState,
} from '@axterm/plugin-api/ai';
import type { AiPanelActions } from '../src/client/ui/panel-actions.ts';
import { AiPanel } from '../src/client/ui/ai-panel.tsx';
import { AiI18nProvider } from '../src/client/ui/i18n.tsx';
import { dictionaries } from '../src/client/ui/locales.ts';

const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    value: vi.fn(),
    configurable: true,
  });
});
afterEach(() => {
  cleanup();
  if (scroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scroll);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

const savedProvider = aiProviderSchema.parse({
  id: 'c327bcc2-742f-49e4-9c0a-d763b83b0897',
  version: 4,
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
  name: 'Local assistant',
  baseUrl: 'http://127.0.0.1:8080/v1',
  credentialRef: 'saved-key-ref',
  enabled: false,
  timeoutMs: 45000,
  role: 'Saved instructions',
  proxy: {
    url: 'socks5://127.0.0.1:1080',
    username: 'operator',
    credentialRef: 'saved-proxy-ref',
  },
  pi: { id: 'axterm-custom', models: [{ id: 'fixture-model', api: 'openai-completions' }] },
});

function fixture(saved?: AiProvider, catalog: PiCatalogProvider[] = []) {
  let unavailable = false;
  const disconnected = { status: 'error' };
  const listeners = new Set<() => void>();
  let snapshot = {
    status: 'ready',
    baseline: {
      generation: 'fixture',
      providers: saved ? [saved] : [],
      models: [],
      runs: [],
      conversations: [],
      approvals: [],
      engines: [{ id: 'pi', label: 'Pi', state: 'ready', capabilities: { tools: true } }],
    },
  };
  const states = new Map<string, object>();
  const client = {
    model: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: () => (unavailable ? disconnected : snapshot),
      retry: vi.fn(async () => {
        throw Error('PRIVATE_READ_FAILURE');
      }),
    },
    queries: {
      open: (kind: string) => {
        let state = states.get(kind);
        if (!state) {
          state = {
            data:
              kind === 'provider'
                ? saved
                : kind === 'catalog'
                  ? catalog
                  : ['workspace', 'conversation'].includes(kind)
                    ? undefined
                    : [],
            isSuccess: true,
            isPending: false,
            isError: false,
          };
          states.set(kind, state);
        }
        return {
          resource: { getSnapshot: () => state, subscribe: () => () => {} },
          dispose: async () => {},
        };
      },
    },
    createCredential: vi.fn(async (_input: { secret: string }) => ({ ref: 'fixture-vault-ref' })),
    createAiProvider: vi.fn(async (_input: AiProviderInput) => ({ id: 'fixture-provider' })),
    createAiModel: vi.fn(async () => ({ id: 'fixture-model' })),
    deleteCredential: vi.fn(async () => {}),
    beginProviderLogin: vi.fn<() => Promise<PiLoginState>>(),
    getProviderLogin: vi.fn<() => Promise<PiLoginState>>(),
    cancelProviderLogin: vi.fn(async () => {}),
    openLoginUrl: vi.fn(async () => {}),
    updateAiProvider: vi.fn(async (row: AiProvider, patch: AiProviderPatch) => {
      snapshot = {
        ...snapshot,
        baseline: {
          ...snapshot.baseline,
          providers: snapshot.baseline.providers.map((provider) =>
            provider.id === row.id ? aiProviderSchema.parse({ ...provider, ...patch }) : provider,
          ),
        },
      };
      for (const listener of listeners) listener();
    }),
    deleteAiProvider: vi.fn(async (_row: { id: string; version: number }) => {
      snapshot = { ...snapshot, baseline: { ...snapshot.baseline, providers: [] } };
      for (const listener of listeners) listener();
    }),
  };
  const view = render(
    <AiI18nProvider
      value={{
        language: 'en',
        x: (key, variables) =>
          dictionaries.en[key].replace(/\{(\w+)\}/gu, (token, name: string) =>
            String(variables?.[name] ?? token),
          ),
      }}
    >
      <AiPanel
        client={client as unknown as AiPanelActions}
        activeTerminalId={undefined}
        settingsOnly
      />
    </AiI18nProvider>,
  );
  fireEvent.change(view.getByLabelText('Model', { exact: true }), {
    target: { value: 'fixture-model' },
  });
  fireEvent.change(view.getByLabelText('API Key', { exact: true }), {
    target: { value: 'FIXTURE_KEY' },
  });
  return {
    ...view,
    client,
    disconnect: () => {
      unavailable = true;
    },
  };
}

it('shows saving progress, prevents duplicate writes and confirms success even if the read refresh fails', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<{ id: string }>();
  f.client.createAiProvider.mockImplementationOnce(() => pending.promise);
  fireEvent.click(f.getByRole('button', { name: 'Save configuration' }));
  const saving = await f.findByRole('button', { name: 'Saving configuration…' });
  expect((saving as HTMLButtonElement).disabled).toBe(true);
  fireEvent.submit(saving.closest('form')!);
  await waitFor(() => expect(f.client.createAiProvider).toHaveBeenCalledTimes(1));
  f.disconnect();
  pending.resolve({ id: 'fixture-provider' });
  await f.findByText('Provider saved. Test the connection before using it.');
  await waitFor(() => expect(f.client.model.retry).toHaveBeenCalled());
  expect(f.client.createAiModel).toHaveBeenCalledTimes(1);
  expect(f.client.deleteAiProvider).not.toHaveBeenCalled();
  expect(f.client.deleteCredential).not.toHaveBeenCalled();
});

it('edits a disabled saved provider in place and keeps its credentials when passwords are blank', async () => {
  const f = fixture(savedProvider);
  const edit = await f.findByRole('button', { name: 'Edit provider' });
  await waitFor(() => expect((edit as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(edit);
  const dialog = within(f.getByRole('dialog', { name: 'Edit provider' }));
  const name = dialog.getByLabelText('Name') as HTMLInputElement;
  const url = dialog.getByLabelText('Base URL') as HTMLInputElement;
  expect(name.value).toBe(savedProvider.name);
  expect(url.value).toBe(savedProvider.baseUrl);
  expect((dialog.getByLabelText('API Key') as HTMLInputElement).value).toBe('');
  expect((dialog.getByLabelText('Proxy password') as HTMLInputElement).value).toBe('');
  fireEvent.change(name, { target: { value: 'Renamed assistant' } });
  fireEvent.change(url, { target: { value: 'http://127.0.0.1:8081/v1' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
  await f.findByText('Provider saved. Test the connection before using it.');
  expect(f.client.updateAiProvider).toHaveBeenCalledExactlyOnceWith(savedProvider, {
    name: 'Renamed assistant',
    baseUrl: 'http://127.0.0.1:8081/v1',
    role: savedProvider.role,
    timeoutMs: savedProvider.timeoutMs,
    proxy: savedProvider.proxy,
  });
  expect(f.client.createCredential).not.toHaveBeenCalled();
  expect(f.client.createAiProvider).not.toHaveBeenCalled();
});

it('passes a replacement key only to Vault and releases its reference when the version check rejects the update', async () => {
  const f = fixture(savedProvider);
  await waitFor(() => {
    expect((f.getByRole('button', { name: 'Edit provider' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
  fireEvent.click(f.getByRole('button', { name: 'Edit provider' }));
  const dialog = within(f.getByRole('dialog'));
  f.client.updateAiProvider.mockRejectedValueOnce({
    code: 'ai/failure',
    details: { reason: 'precondition' },
  });
  fireEvent.change(dialog.getByLabelText('API Key'), { target: { value: 'REPLACEMENT_KEY' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
  await dialog.findByText('This provider changed. Close this dialog and reopen the configuration.');
  expect(f.client.createCredential).toHaveBeenCalledExactlyOnceWith({
    kind: 'aiApiKey',
    label: `${savedProvider.name} API Key`,
    secret: 'REPLACEMENT_KEY',
  });
  expect(f.client.updateAiProvider).toHaveBeenCalledExactlyOnceWith(
    savedProvider,
    expect.objectContaining({ credentialRef: 'fixture-vault-ref' }),
  );
  expect(JSON.stringify(f.client.updateAiProvider.mock.calls)).not.toContain('REPLACEMENT_KEY');
  await waitFor(() =>
    expect(f.client.deleteCredential).toHaveBeenCalledExactlyOnceWith('fixture-vault-ref'),
  );
});

it('requires confirmation to delete a saved configuration and removes the card after the update', async () => {
  const f = fixture(savedProvider);
  const remove = f.getByRole('button', { name: 'Delete' });
  fireEvent.click(remove);
  const dialog = within(f.getByRole('dialog', { name: 'Delete provider' }));
  expect(dialog.getByText('Delete the saved configuration for Local assistant?')).toBeTruthy();
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
  expect(f.client.deleteAiProvider).not.toHaveBeenCalled();
  fireEvent.click(remove);
  fireEvent.click(within(f.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
  await f.findByText('Provider configuration deleted.');
  expect(f.client.deleteAiProvider).toHaveBeenCalledExactlyOnceWith(savedProvider);
  expect(f.queryByText(savedProvider.name)).toBeNull();
  expect(f.client.deleteCredential).not.toHaveBeenCalled();
});

it('shows delete only while the provider is disabled', async () => {
  const f = fixture({ ...savedProvider, enabled: true });
  const card = within(f.getByRole('article', { name: savedProvider.name }));
  expect(card.queryByRole('button', { name: 'Delete' })).toBeNull();
  expect(card.getByRole('button', { name: 'Edit provider' })).toBeTruthy();
  fireEvent.click(card.getByRole('button', { name: 'Disable' }));
  expect(await card.findByRole('button', { name: 'Delete' })).toBeTruthy();
  fireEvent.click(card.getByRole('button', { name: 'Enable' }));
  await waitFor(() => expect(card.queryByRole('button', { name: 'Delete' })).toBeNull());
});

it('uses the selected catalog model endpoint for a new built-in API Key configuration', async () => {
  const catalog: PiCatalogProvider = {
    id: 'opencode-go',
    name: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/inference/go/anthropic',
    apiKeyAvailable: true,
    models: [
      { id: 'claude-haiku-5-5', api: 'anthropic-messages' },
      { id: 'deepseek-v4-pro', api: 'openai-completions' },
    ],
  };
  const f = fixture(undefined, [catalog]);
  const signedIn: PiLoginState = {
    id: 'go-login',
    provider: catalog.id,
    status: 'succeeded',
    models: catalog.models,
    events: [],
    credentialRef: 'go-vault-grant',
  };
  f.client.beginProviderLogin.mockResolvedValue(signedIn);
  f.client.getProviderLogin.mockResolvedValue(signedIn);
  await f.findByRole('option', { name: catalog.name });
  fireEvent.change(f.getByLabelText('Pi provider'), { target: { value: catalog.id } });
  expect((f.getByLabelText('Base URL') as HTMLInputElement).value).toBe('');
  fireEvent.click(f.getByRole('button', { name: 'Sign in with Pi' }));
  await f.findByText('Signed in. Credentials are saved in the application Vault.');
  fireEvent.change(f.getByLabelText('Model'), { target: { value: 'deepseek-v4-pro' } });
  fireEvent.click(f.getByRole('button', { name: 'Save configuration' }));
  await f.findByText('Provider saved. Test the connection before using it.');
  expect(f.client.createAiProvider.mock.calls[0]?.[0]).not.toHaveProperty('baseUrl');
  expect(f.client.createAiModel).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'deepseek-v4-pro' }),
  );
});

it('can replace a Pi-managed login using only the new grant reference', async () => {
  const registered = aiProviderSchema.parse({
    ...savedProvider,
    pi: { id: 'minimax-cn', credentialMode: 'pi' },
  });
  const f = fixture(registered, [
    {
      id: 'minimax-cn',
      name: 'MiniMax CN',
      baseUrl: 'https://example.test/v1',
      apiKeyAvailable: true,
      models: [],
    },
  ]);
  const login: PiLoginState = {
    id: 'login-fixture',
    provider: 'minimax-cn',
    status: 'succeeded',
    events: [],
    models: [],
    credentialRef: 'new-pi-grant',
  };
  f.client.beginProviderLogin.mockResolvedValue(login);
  f.client.getProviderLogin.mockResolvedValue(login);
  const edit = await f.findByRole('button', { name: 'Edit provider' });
  await waitFor(() => expect((edit as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(edit);
  const dialog = within(f.getByRole('dialog'));
  fireEvent.click(dialog.getByRole('button', { name: 'Sign in with Pi' }));
  await dialog.findByRole('status');
  fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
  await f.findByText('Provider saved. Test the connection before using it.');
  expect(f.client.beginProviderLogin).toHaveBeenCalledWith('minimax-cn', 'api_key');
  expect(f.client.updateAiProvider).toHaveBeenCalledExactlyOnceWith(
    registered,
    expect.objectContaining({ credentialRef: 'new-pi-grant' }),
  );
  expect(f.client.createCredential).not.toHaveBeenCalled();
});

it('offers Codex and other account sign-ins separately from API keys and saves the authenticated model', async () => {
  const codex: PiCatalogProvider = {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    baseUrl: 'https://chatgpt.com/backend-api',
    apiKeyAvailable: false,
    oauth: { name: 'OpenAI (ChatGPT Plus/Pro)', label: 'OpenAI Codex', subscription: true },
    models: [{ id: 'codex-fixture', api: 'openai-codex-responses' }],
  };
  const f = fixture(undefined, [
    {
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyAvailable: true,
      oauth: {
        name: 'OpenAI (ChatGPT subscription)',
        label: 'Sign in with ChatGPT',
        subscription: true,
      },
      models: [{ id: 'openai-fixture', api: 'openai-responses' }],
    },
    codex,
    {
      id: 'github-copilot',
      name: 'GitHub Copilot',
      baseUrl: 'https://api.githubcopilot.com',
      apiKeyAvailable: false,
      oauth: { name: 'GitHub Copilot', label: 'Sign in with GitHub', subscription: true },
      models: [{ id: 'copilot-fixture', api: 'openai-completions' }],
    },
  ]);
  await f.findByRole('option', { name: 'OpenAI' });
  expect(f.queryByRole('option', { name: /Codex/ })).toBeNull();
  fireEvent.click(f.getByRole('button', { name: 'Account or subscription' }));
  expect(f.getByRole('option', { name: 'OpenAI (ChatGPT subscription)' })).toBeTruthy();
  expect(f.getByRole('option', { name: 'GitHub Copilot' })).toBeTruthy();
  expect((f.getByLabelText('Pi provider') as HTMLSelectElement).value).toBe('openai-codex');
  expect(f.queryByLabelText('API Key', { exact: true })).toBeNull();
  const save = f.getByRole('button', { name: 'Save configuration' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);

  const url = 'https://auth.openai.com/oauth/authorize';
  const running: PiLoginState = {
    id: 'codex-login',
    provider: 'openai-codex',
    status: 'running',
    events: [{ type: 'auth_url', url }],
    models: [],
  };
  const signedIn = Promise.withResolvers<PiLoginState>();
  f.client.beginProviderLogin.mockResolvedValue(running);
  f.client.getProviderLogin.mockImplementation(() => signedIn.promise);
  fireEvent.click(f.getByRole('button', { name: 'Sign in with ChatGPT' }));
  fireEvent.click(await f.findByRole('button', { name: 'Open sign-in page' }));
  expect(f.client.beginProviderLogin).toHaveBeenCalledExactlyOnceWith('openai-codex', 'oauth');
  expect(f.client.openLoginUrl).toHaveBeenCalledExactlyOnceWith(url);
  signedIn.resolve({
    ...running,
    status: 'succeeded',
    models: codex.models,
    credentialRef: 'codex-vault-grant',
  });
  await waitFor(() => expect(save.disabled).toBe(false));
  fireEvent.click(save);
  await f.findByText('Provider saved. Test the connection before using it.');
  expect(f.client.createAiProvider).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      credentialRef: 'codex-vault-grant',
      pi: expect.objectContaining({ id: 'openai-codex', credentialMode: 'pi' }),
    }),
  );
  expect(f.client.createAiModel).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'codex-fixture' }),
  );
  expect(f.client.createCredential).not.toHaveBeenCalled();
  fireEvent.click(f.getByRole('button', { name: 'API Key' }));
  expect(f.getByLabelText('API Key', { exact: true })).toBeTruthy();
  expect(f.queryByRole('button', { name: 'Sign in with ChatGPT' })).toBeNull();
  await waitFor(() => expect(f.client.cancelProviderLogin).toHaveBeenCalledWith('codex-login'));
});

it('reports a rejected save inside the form and preserves entered values without exposing a raw cause', async () => {
  const f = fixture();
  f.client.createAiProvider.mockRejectedValueOnce(Error('PRIVATE_SAVE_FAILURE'));
  fireEvent.click(f.getByRole('button', { name: 'Save configuration' }));
  const alert = await f.findByText('Operation failed');
  expect(alert.closest('form')).not.toBeNull();
  expect((f.getByLabelText('Model', { exact: true }) as HTMLInputElement).value).toBe(
    'fixture-model',
  );
  expect(f.container.textContent).not.toContain('PRIVATE_SAVE_FAILURE');
  expect(f.client.createAiModel).not.toHaveBeenCalled();
});

it('keeps a failed model save visible even when compensation cannot read provider facts', async () => {
  const f = fixture();
  f.client.createAiModel.mockImplementationOnce(async () => {
    f.disconnect();
    throw Error('PRIVATE_MODEL_FAILURE');
  });
  fireEvent.click(f.getByRole('button', { name: 'Save configuration' }));
  const alert = await f.findByText('Operation failed');
  expect(alert.closest('form')).not.toBeNull();
  await waitFor(() => expect(f.client.model.retry).toHaveBeenCalled());
  expect(f.queryByText('Provider saved. Test the connection before using it.')).toBeNull();
  expect(f.client.deleteCredential).not.toHaveBeenCalled();
});
