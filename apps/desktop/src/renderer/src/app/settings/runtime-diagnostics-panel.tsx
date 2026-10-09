import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import { useI18n } from '../../i18n/context';

export function RuntimeDiagnosticsPanel({
  client,
}: {
  client: ReturnType<typeof createRuntimeClient>;
}) {
  const { x } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className="surface settings-advanced-diagnostics"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>{x('settings.advancedTitle')}</summary>
      {expanded && <RuntimeDiagnosticsContent client={client} />}
    </details>
  );
}

function RuntimeDiagnosticsContent({ client }: { client: ReturnType<typeof createRuntimeClient> }) {
  const { x } = useI18n();
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'saved'; bytes: number } | { kind: 'error' }>();
  const active = useRef(true);
  const submitting = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const diagnostics = useQuery({
    queryKey: ['diagnostics'],
    queryFn: ({ signal }) => client.diagnostics(signal),
    retry: false,
    refetchInterval: 3000,
  });

  async function exportDiagnostics() {
    if (submitting.current) return;
    submitting.current = true;
    setExporting(true);
    setNotice(undefined);
    let grantId: string | undefined;
    try {
      const grant = await client.createFileGrant('save-file');
      if (!grant) return;
      grantId = grant.grantId;
      if (!active.current) return;
      const result = await client.exportDiagnostics(grantId);
      if (active.current) setNotice({ kind: 'saved', bytes: result.bytes });
    } catch {
      if (active.current) setNotice({ kind: 'error' });
    } finally {
      if (grantId) await client.revokeFileGrant(grantId).catch(() => undefined);
      submitting.current = false;
      if (active.current) setExporting(false);
    }
  }

  return (
    <div className="stack settings-diagnostics-content">
      <p className="hint">{x('settings.advancedDescription')}</p>
      {diagnostics.isPending && <p role="status">{x('settings.updaterLoading')}</p>}
      {diagnostics.isError && (
        <div role="alert" className="stack">
          <p>{x('settings.diagnosticsLoadFailed')}</p>
          <button
            type="button"
            disabled={diagnostics.isFetching}
            onClick={() => void diagnostics.refetch()}
          >
            {x('settings.diagnosticsRetry')}
          </button>
        </div>
      )}
      {diagnostics.data && (
        <div className="diagnostic-grid">
          <Metric label={x('settings.database')} value={diagnostics.data.database} />
          <Metric
            label={x('settings.uptime')}
            value={x('settings.uptimeSeconds', {
              seconds: Math.round(diagnostics.data.uptimeSeconds),
            })}
          />
          {Object.entries(diagnostics.data.resources).map(([key, value]) => (
            <Metric key={key} label={key} value={String(value)} />
          ))}
        </div>
      )}
      <button
        type="button"
        disabled={exporting}
        aria-busy={exporting}
        onClick={() => void exportDiagnostics()}
      >
        {x('settings.exportDiagnostics')}
      </button>
      {notice && (
        <p role={notice.kind === 'error' ? 'alert' : 'status'}>
          {notice.kind === 'error'
            ? x('settings.diagnosticsExportFailed')
            : x('settings.diagnosticsExported', { bytes: formatBytes(notice.bytes) })}
        </p>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span title={label}>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
