import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import { useI18n } from '../../i18n/context';
import { updateCachedSettings } from '../settings-cache';

export function PrivacySettingsPanel({
  client,
}: {
  client: ReturnType<typeof createRuntimeClient>;
}) {
  const { x } = useI18n();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: client.settings });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'error'>();
  const active = useRef(true);
  const submitting = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function setHideAddresses(hideAddresses: boolean) {
    if (!settings.data || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setNotice(undefined);
    try {
      await updateCachedSettings(queryClient, client, settings.data, {
        privacy: { hideAddresses },
      });
      if (active.current) setNotice('saved');
    } catch {
      if (active.current) setNotice('error');
    } finally {
      submitting.current = false;
      if (active.current) setSaving(false);
    }
  }
  return (
    <section className="surface settings-privacy-panel" aria-label={x('settings.privacy')}>
      <header>
        <div>
          <small>{x('settings.privacy')}</small>
          <h3>{x('settings.addressDisplay')}</h3>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.data?.privacy.hideAddresses ?? false}
            disabled={!settings.data || settings.isFetching || saving}
            onChange={(event) => void setHideAddresses(event.currentTarget.checked)}
          />
          {x('settings.hideAddresses')}
        </label>
      </header>
      <p className="hint">{x('settings.hideAddressesHint')}</p>
      {notice && (
        <p className="hint" role={notice === 'error' ? 'alert' : 'status'}>
          {notice === 'error'
            ? x('settings.privacySaveFailed')
            : settings.data?.privacy.hideAddresses
              ? x('settings.addressesHidden')
              : x('settings.addressesVisible')}
        </p>
      )}
    </section>
  );
}
