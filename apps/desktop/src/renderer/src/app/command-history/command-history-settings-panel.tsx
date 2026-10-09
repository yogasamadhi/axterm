import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import { useI18n } from '../../i18n/context';

type Client = ReturnType<typeof createRuntimeClient>;

export function CommandHistorySettingsPanel({ client }: { client: Client }) {
  const { x } = useI18n();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: client.settings });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function setEnabled(enabled: boolean) {
    if (!settings.data || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await client.updateSettings(settings.data, {
        privacy: { commandHistoryEnabled: enabled },
      });
      queryClient.setQueryData(['settings'], next);
      await queryClient.invalidateQueries({ queryKey: ['command-history'] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : x('commandHistory.saveError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="surface stack" aria-labelledby="command-history-settings-title">
      <h3 id="command-history-settings-title">{x('commandHistory.title')}</h3>
      <p className="hint">{x('commandHistory.description')}</p>
      <label className="check">
        <input
          checked={settings.data?.privacy.commandHistoryEnabled ?? false}
          disabled={!settings.data || busy}
          onChange={(event) => void setEnabled(event.target.checked)}
          type="checkbox"
        />
        {x('commandHistory.enabled')}
      </label>
      {error && (
        <p className="danger-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
