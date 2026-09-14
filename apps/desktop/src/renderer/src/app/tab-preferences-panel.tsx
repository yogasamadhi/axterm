import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type { Settings } from '@workspace/contracts';
import { useI18n } from '../i18n/context';
import './tab-preferences-panel.css';

type Client = ReturnType<typeof createRuntimeClient>;
type TabPreferences = Pick<Settings['workspace'], 'showTabNumber' | 'switchTabOnHover'>;

export function TabPreferencesPanel({ client }: { client: Client }) {
  const { x } = useI18n();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: client.settings });
  const [busy, setBusy] = useState<keyof TabPreferences>();
  const [error, setError] = useState('');

  async function update(patch: Partial<TabPreferences>) {
    if (!settings.data || busy) return;
    const key = Object.keys(patch)[0] as keyof TabPreferences | undefined;
    if (!key) return;
    setBusy(key);
    setError('');
    try {
      const value = await client.updateSettings(settings.data, { workspace: patch });
      queryClient.setQueryData(['settings'], value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : x('tabPreferences.saveError'));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="surface tab-preferences-panel" aria-labelledby="tab-preferences-title">
      <header>
        <div>
          <h3 id="tab-preferences-title">{x('tabPreferences.title')}</h3>
          <p>{x('tabPreferences.description')}</p>
        </div>
      </header>
      <label className="check">
        <input
          checked={settings.data?.workspace.showTabNumber ?? true}
          disabled={!settings.data || !!busy}
          onChange={(event) => void update({ showTabNumber: event.target.checked })}
          type="checkbox"
        />
        {x('tabPreferences.showNumber')}
      </label>
      <label className="check">
        <input
          checked={settings.data?.workspace.switchTabOnHover ?? false}
          disabled={!settings.data || !!busy}
          onChange={(event) => void update({ switchTabOnHover: event.target.checked })}
          type="checkbox"
        />
        {x('tabPreferences.switchOnHover')}
      </label>
      {error && (
        <p className="danger-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
