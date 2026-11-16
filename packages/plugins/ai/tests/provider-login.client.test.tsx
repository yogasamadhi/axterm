// @vitest-environment jsdom
import { fireEvent, render, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PiCatalogProvider, PiLoginState } from '@axterm/plugin-api/ai';
import type { AiPanelActions } from '../src/client/ui/panel-actions.ts';
import { ProviderLogin } from '../src/client/ui/provider-login.tsx';
import { AiI18nProvider } from '../src/client/ui/i18n.tsx';
import { dictionaries } from '../src/client/ui/locales.ts';

afterEach(cleanup);
const provider = { id: 'minimax-cn', apiKeyAvailable: true } as PiCatalogProvider;
const running: PiLoginState = {
  id: 'login',
  provider: provider.id,
  status: 'running',
  events: [],
  models: [],
  prompt: { id: 'key', type: 'secret', message: 'Enter API key' },
};
function fixture(initial = running) {
  const client = {
    beginProviderLogin: vi.fn(async () => structuredClone(initial)),
    getProviderLogin: vi.fn(async () => structuredClone(initial)),
    cancelProviderLogin: vi.fn(async () => {}),
    respondProviderLogin: vi.fn(async () => {}),
  };
  const changed = vi.fn();
  const view = render(
    <AiI18nProvider value={{ language: 'en', x: (key) => dictionaries.en[key] }}>
      <ProviderLogin
        provider={provider}
        client={client as unknown as AiPanelActions}
        onChange={changed}
      />
    </AiI18nProvider>,
  );
  return { ...view, client, changed };
}
it('recovers from an interrupted status read instead of leaving login permanently disabled', async () => {
  const f = fixture();
  f.client.getProviderLogin.mockRejectedValueOnce(Error('connection interrupted'));
  fireEvent.click(f.getByRole('button', { name: 'Sign in with Pi' }));
  await waitFor(() => expect(f.client.getProviderLogin).toHaveBeenCalledTimes(2), {
    timeout: 1500,
  });
  expect(f.queryByRole('alert')).toBeNull();
  expect(f.getByLabelText('Enter API key')).toBeTruthy();
});
it('consumes an accepted prompt once even before the next status poll', async () => {
  const f = fixture();
  fireEvent.click(f.getByRole('button', { name: 'Sign in with Pi' }));
  const field = await f.findByLabelText('Enter API key');
  fireEvent.change(field, { target: { value: 'FIXTURE_KEY' } });
  fireEvent.click(f.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(f.client.respondProviderLogin).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(f.queryByLabelText('Enter API key')).toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(f.queryByLabelText('Enter API key')).toBeNull();
});
it('revokes the previous successful selection immediately when starting another login', async () => {
  const succeeded = { ...running, status: 'succeeded' as const, credentialRef: 'old-grant' };
  delete succeeded.prompt;
  const f = fixture(succeeded);
  fireEvent.click(f.getByRole('button', { name: 'Sign in with Pi' }));
  await f.findByRole('status');
  const next = Promise.withResolvers<PiLoginState>();
  f.client.beginProviderLogin.mockImplementationOnce(() => next.promise);
  fireEvent.click(f.getByRole('button', { name: 'Sign in with Pi' }));
  expect(f.changed.mock.lastCall?.[0]).toBeUndefined();
  expect(f.queryByRole('status')).toBeNull();
  next.resolve({ ...running, id: 'next-login' });
  await waitFor(() => expect(f.changed.mock.lastCall?.[0]?.id).toBe('next-login'));
});
it('releases a repeatedly unavailable login and enables a fresh attempt after three reads', async () => {
  const f = fixture();
  f.client.getProviderLogin.mockRejectedValue(Error('host unavailable'));
  fireEvent.click(f.getByRole('button', { name: 'Sign in with Pi' }));
  await waitFor(() => expect(f.client.cancelProviderLogin).toHaveBeenCalledWith('login'), {
    timeout: 1500,
  });
  expect(f.client.getProviderLogin).toHaveBeenCalledTimes(3);
  expect((f.getByRole('button', { name: 'Sign in with Pi' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect(f.queryByRole('alert')).not.toBeNull();
  expect(f.changed.mock.lastCall?.[0]).toBeUndefined();
});
it('cancels a late login returned after its configuration view closes', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<PiLoginState>();
  f.client.beginProviderLogin.mockImplementationOnce(() => pending.promise);
  fireEvent.click(f.getByRole('button', { name: 'Sign in with Pi' }));
  f.unmount();
  pending.resolve(running);
  await waitFor(() => expect(f.client.cancelProviderLogin).toHaveBeenCalledWith('login'));
  expect(f.changed.mock.calls.every(([state]) => state === undefined)).toBe(true);
});
it('does not let a late cancellation erase a newer login', async () => {
  const f = fixture();
  fireEvent.click(f.getByRole('button', { name: 'Sign in with Pi' }));
  await f.findByLabelText('Enter API key');
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  f.client.cancelProviderLogin
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  fireEvent.click(f.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(f.getByRole('button', { name: 'Cancel' }));
  first.resolve();
  await waitFor(() => expect(f.queryByLabelText('Enter API key')).toBeNull());
  f.client.beginProviderLogin.mockResolvedValueOnce({ ...running, id: 'new-login' });
  f.client.getProviderLogin.mockResolvedValue({ ...running, id: 'new-login' });
  fireEvent.click(f.getByRole('button', { name: 'Sign in with Pi' }));
  await f.findByLabelText('Enter API key');
  second.resolve();
  await waitFor(() => expect(f.client.cancelProviderLogin).toHaveBeenCalledTimes(3));
  expect(f.queryByLabelText('Enter API key')).not.toBeNull();
  expect(f.changed.mock.lastCall?.[0]?.id).toBe('new-login');
});
