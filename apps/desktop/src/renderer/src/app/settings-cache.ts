import type { QueryClient } from '@tanstack/react-query';
import type { Settings, UpdateSettingsInput } from '@workspace/contracts';

type SettingsClient = {
  settings(): Promise<Settings>;
  updateSettings(current: Settings, patch: UpdateSettingsInput): Promise<Settings>;
};

const pendingWrites = new WeakMap<QueryClient, Promise<unknown>>();

/** Keep late reads from replacing a committed settings revision. Never replay a failed mutation. */
export function updateCachedSettings(
  queryClient: QueryClient,
  client: SettingsClient,
  fallback: Settings,
  patch: UpdateSettingsInput,
): Promise<Settings> {
  const previous = pendingWrites.get(queryClient) ?? Promise.resolve();
  const task = previous
    .catch(() => undefined)
    .then(() => saveSettings(queryClient, client, fallback, patch));
  pendingWrites.set(queryClient, task);
  void task
    .finally(() => {
      if (pendingWrites.get(queryClient) === task) pendingWrites.delete(queryClient);
    })
    .catch(() => undefined);
  return task;
}

async function saveSettings(
  queryClient: QueryClient,
  client: SettingsClient,
  fallback: Settings,
  patch: UpdateSettingsInput,
): Promise<Settings> {
  const queryKey = ['settings'];
  await queryClient.cancelQueries({ queryKey });
  const current = queryClient.getQueryData<Settings>(queryKey) ?? fallback;
  let saved: Settings;
  try {
    saved = await client.updateSettings(current, patch);
  } catch (cause) {
    // A rejected If-Match must leave a fresh revision available for the user's next attempt.
    await queryClient.cancelQueries({ queryKey });
    await queryClient
      .fetchQuery({ queryKey, queryFn: client.settings, staleTime: 0 })
      .catch(() => undefined);
    throw cause;
  }
  await queryClient.cancelQueries({ queryKey });
  queryClient.setQueryData<Settings>(queryKey, (latest) =>
    latest && latest.version > saved.version ? latest : saved,
  );
  return saved;
}
