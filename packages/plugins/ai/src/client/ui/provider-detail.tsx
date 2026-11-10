import { useI18n } from './i18n.tsx';
import type { AiPanelQueries } from '../panel-queries.ts';
import { useAiRead } from './use-ai-read.ts';
/** Cards request only their visible page's detail; metadata filtering never needs transport or Vault refs. */
export function ProviderDetail({ id, queries }: { id: string; queries: AiPanelQueries }) {
  const { x } = useI18n();
  const detail = useAiRead(queries, 'provider', id);
  if (detail.isError)
    return (
      <span role="alert">
        {x('common.operationFailed')}{' '}
        <button type="button" onClick={() => void detail.refetch()}>
          {x('common.retry')}
        </button>
      </span>
    );
  if (!detail.data) return null;
  return (
    <>
      <span>{detail.data.engineId === 'pi' ? detail.data.protocol : detail.data.engineId}</span>
      {detail.data.engineId === 'pi' && (
        <small>
          {detail.data.baseUrl} · {detail.data.apiPath}
        </small>
      )}
    </>
  );
}
