import type { AiProvider, AiProviderHeader } from '@axterm/plugin-api/ai';
import { Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { useI18n } from './i18n.tsx';
import type { AiPanelQueries } from '../panel-queries.ts';
import { cx } from './styles.ts';
import { useAiRead } from './use-ai-read.ts';

export type ProviderAction =
  { kind: 'edit'; provider: AiProvider } | { kind: 'delete'; provider: AiProviderHeader };

/** Cards request only their visible page's detail; metadata filtering never needs transport or Vault refs. */
export function ProviderCard({
  provider,
  queries,
  status,
  onTest,
  onToggle,
  onAction,
}: {
  provider: AiProviderHeader;
  queries: AiPanelQueries;
  status: string | undefined;
  onTest(): void;
  onToggle(): void;
  onAction(action: ProviderAction): void;
}) {
  const { x } = useI18n();
  const detail = useAiRead(queries, 'provider', provider.id);
  const data = detail.data;
  const editable = data && data.version === provider.version ? data : undefined;
  return (
    <article className={cx('surface ai-provider-card')} aria-label={provider.name}>
      <div className={cx('ai-provider-summary')}>
        <strong>{provider.name}</strong>
        {detail.isError ? (
          <span role="alert">
            {x('common.operationFailed')}{' '}
            <button type="button" onClick={() => void detail.refetch()}>
              {x('common.retry')}
            </button>
          </span>
        ) : (
          data && (
            <>
              <span>{data.pi?.id ?? (data.engineId === 'pi' ? data.protocol : data.engineId)}</span>
              {data.engineId === 'pi' && data.baseUrl && (
                <small>
                  {data.baseUrl}
                  {!data.pi && ` · ${data.apiPath}`}
                </small>
              )}
            </>
          )
        )}
      </div>
      <span className={cx(`run-state ${provider.enabled ? 'succeeded' : 'canceled'}`)}>
        {provider.enabled ? x('ai.enabled') : x('ai.disabled')}
      </span>
      <div className={cx('ai-provider-actions')}>
        <button type="button" onClick={onTest} disabled={!provider.enabled}>
          <RefreshCw size={13} /> {x('ai.testConnection')}
        </button>
        <button type="button" onClick={onToggle}>
          {provider.enabled ? x('ai.disable') : x('ai.enable')}
        </button>
        <button
          type="button"
          disabled={!editable || detail.isError}
          onClick={() => {
            if (editable) onAction({ kind: 'edit', provider: editable });
          }}
        >
          <Pencil size={13} /> {x('ai.editProvider')}
        </button>
        {!provider.enabled && (
          <button type="button" onClick={() => onAction({ kind: 'delete', provider })}>
            <Trash2 size={13} /> {x('common.delete')}
          </button>
        )}
      </div>
      {status && <p role="status">{status}</p>}
    </article>
  );
}
