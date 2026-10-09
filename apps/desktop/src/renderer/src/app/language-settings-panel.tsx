import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type { AppLanguage } from '@workspace/contracts';
import { useI18n } from '../i18n/context';
import { updateCachedSettings } from './settings-cache';

export function LanguageSettingsPanel({
  client,
}: {
  client: ReturnType<typeof createRuntimeClient>;
}) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: client.settings });
  const { language, locales, t, x } = useI18n();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'error' | undefined>();

  async function updateLanguage(nextLanguage: AppLanguage) {
    if (!settings.data || nextLanguage === settings.data.appearance.language) return;
    setSaving(true);
    setNotice(undefined);
    try {
      await updateCachedSettings(queryClient, client, settings.data, {
        appearance: { language: nextLanguage },
      });
      setNotice('saved');
    } catch {
      setNotice('error');
      await settings.refetch();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="surface language-settings-panel" aria-labelledby="language-settings-title">
      <header>
        <div>
          <small>{t('setting', 'SETTING').toLocaleUpperCase(language)}</small>
          <h2 id="language-settings-title">{t('language', x('language.title'))}</h2>
        </div>
      </header>
      <p className="hint">{x('language.description')}</p>
      <label>
        {t('language', x('language.title'))}
        <select
          aria-label={t('language', x('language.title'))}
          data-testid="application-language"
          disabled={!settings.data || saving}
          value={settings.data?.appearance.language ?? language}
          onChange={(event) => void updateLanguage(event.currentTarget.value as AppLanguage)}
        >
          {locales.map((locale) => (
            <option key={locale.id} value={locale.id}>
              {locale.flag} {locale.name}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">{saving ? x('language.saving') : x('language.fallback')}</p>
      {notice && (
        <p className="hint" role="status">
          {notice === 'saved' ? x('language.saved') : x('language.saveFailed')}
        </p>
      )}
    </section>
  );
}
