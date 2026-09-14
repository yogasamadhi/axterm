import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type {
  ElectermDataExportResult,
  ElectermDataImportResult,
  ElectermDataPreview,
  ElectermMigrationEntry,
} from '@workspace/contracts';
import {
  ArchiveRestore,
  CheckCircle2,
  Download,
  FileJson2,
  LoaderCircle,
  Search,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import './electerm-data.css';
import { useI18n } from '../../i18n/context';
import type { AxtermMessageKey } from '../../i18n/core';

type Client = ReturnType<typeof createRuntimeClient>;
type EntryFilter = 'all' | ElectermMigrationEntry['action'];

const kindLabelKeys: Record<ElectermMigrationEntry['kind'], AxtermMessageKey> = {
  group: 'electermData.kindGroup',
  profile: 'electermData.kindProfile',
  sshBookmark: 'electermData.kindSshBookmark',
  bookmark: 'electermData.kindBookmark',
  quickCommand: 'electermData.kindQuickCommand',
  settings: 'electermData.kindSettings',
};

const actionLabelKeys: Record<ElectermMigrationEntry['action'], AxtermMessageKey> = {
  create: 'electermData.actionCreate',
  unchanged: 'electermData.actionUnchanged',
  skip: 'electermData.actionSkip',
};

export function ElectermDataPanel({ client }: { client: Client }) {
  const { language, x } = useI18n();
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<ElectermDataPreview>();
  const [result, setResult] = useState<ElectermDataImportResult>();
  const [exportResult, setExportResult] = useState<ElectermDataExportResult>();
  const [filter, setFilter] = useState<EntryFilter>('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<'preview' | 'commit' | 'export'>();
  const [message, setMessage] = useState('');
  const activePreview = useRef<string | undefined>(undefined);
  const lifecycle = useRef(0);

  useEffect(() => {
    const lifecycleRef = lifecycle;
    const activePreviewRef = activePreview;
    const epoch = ++lifecycleRef.current;
    return () => {
      setTimeout(() => {
        if (lifecycleRef.current !== epoch) return;
        const previewId = activePreviewRef.current;
        activePreviewRef.current = undefined;
        if (previewId) void client.cancelElectermDataPreview(previewId).catch(() => undefined);
      }, 0);
    };
  }, [client]);

  const visibleEntries = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase();
    return (preview?.entries ?? [])
      .filter((entry) => filter === 'all' || entry.action === filter)
      .filter(
        (entry) =>
          !keyword ||
          entry.name.toLocaleLowerCase().includes(keyword) ||
          entry.sourceId.toLocaleLowerCase().includes(keyword) ||
          x(kindLabelKeys[entry.kind]).toLocaleLowerCase().includes(keyword),
      )
      .slice(0, 200);
  }, [filter, preview?.entries, search, x]);

  async function chooseImport() {
    if (busy) return;
    setBusy('preview');
    setMessage('');
    setResult(undefined);
    setExportResult(undefined);
    let grantId: string | undefined;
    try {
      const grant = await client.createFileGrant('open-file');
      if (!grant) return;
      grantId = grant.grantId;
      const next = await client.previewElectermData(grant.grantId);
      const previous = activePreview.current;
      activePreview.current = next.previewId;
      setPreview(next);
      setFilter('all');
      setSearch('');
      if (previous) void client.cancelElectermDataPreview(previous).catch(() => undefined);
    } catch (cause) {
      setMessage(messageOf(cause, x));
    } finally {
      if (grantId) await client.revokeFileGrant(grantId).catch(() => undefined);
      setBusy(undefined);
    }
  }

  async function commit() {
    if (!preview || busy || preview.counts.create === 0) return;
    setBusy('commit');
    setMessage('');
    try {
      const tree = await client.bookmarkTree();
      const committed = await client.commitElectermDataImport(preview.previewId, tree);
      activePreview.current = undefined;
      setResult(committed);
      setPreview(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bookmark-tree'] }),
        queryClient.invalidateQueries({ queryKey: ['hosts'] }),
        queryClient.invalidateQueries({ queryKey: ['connection-profiles'] }),
        queryClient.invalidateQueries({ queryKey: ['quick-commands'] }),
        queryClient.invalidateQueries({ queryKey: ['settings'] }),
      ]);
    } catch (cause) {
      setMessage(messageOf(cause, x));
    } finally {
      setBusy(undefined);
    }
  }

  async function discardPreview() {
    const previewId = activePreview.current;
    activePreview.current = undefined;
    setPreview(undefined);
    if (previewId) await client.cancelElectermDataPreview(previewId).catch(() => undefined);
  }

  async function exportData() {
    if (busy) return;
    setBusy('export');
    setMessage('');
    setResult(undefined);
    let grantId: string | undefined;
    try {
      const grant = await client.createFileGrant('save-file');
      if (!grant) return;
      grantId = grant.grantId;
      setExportResult(await client.exportElectermData(grant.grantId));
    } catch (cause) {
      setMessage(messageOf(cause, x));
    } finally {
      if (grantId) await client.revokeFileGrant(grantId).catch(() => undefined);
      setBusy(undefined);
    }
  }

  return (
    <section className="surface electerm-data-panel" aria-label={x('electermData.panel')}>
      <header className="electerm-data-header">
        <div className="electerm-data-title">
          <span className="electerm-data-icon">
            <ArchiveRestore size={18} />
          </span>
          <div>
            <h3>{x('electermData.title')}</h3>
            <p>{x('electermData.description')}</p>
          </div>
        </div>
        <div className="electerm-data-actions">
          <button disabled={!!busy} onClick={() => void exportData()}>
            {busy === 'export' ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Download size={14} />
            )}
            {x('electermData.export')}
          </button>
          <button className="primary" disabled={!!busy} onClick={() => void chooseImport()}>
            {busy === 'preview' ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Upload size={14} />
            )}
            {x('electermData.chooseFile')}
          </button>
        </div>
      </header>

      <div className="electerm-data-security">
        <ShieldCheck size={15} />
        <span>{x('electermData.security')}</span>
      </div>

      {message && <p className="electerm-data-error">{message}</p>}

      {result && (
        <div className="electerm-data-result" role="status">
          <CheckCircle2 size={18} />
          <div>
            <strong>{x('electermData.importComplete')}</strong>
            <span>{x('electermData.importSummary', result.counts)}</span>
            {result.settingsApplied && <span>{x('electermData.settingsApplied')}</span>}
            {result.credentialMetadataReported > 0 && (
              <span>
                {x('electermData.credentialMetadataReported', {
                  count: result.credentialMetadataReported,
                })}
              </span>
            )}
          </div>
        </div>
      )}

      {exportResult && (
        <div className="electerm-data-result" role="status">
          <CheckCircle2 size={18} />
          <div>
            <strong>{x('electermData.exportComplete')}</strong>
            <span>
              {x('electermData.exportSummary', {
                bytes: formatBytes(exportResult.bytes),
                groups: exportResult.groups,
                sshBookmarks: exportResult.sshBookmarks,
                profiles: exportResult.profiles,
                credentialMetadataCount: exportResult.credentialMetadataCount,
              })}
            </span>
          </div>
        </div>
      )}

      {!preview && !result && !exportResult && (
        <div className="electerm-data-empty">
          <FileJson2 size={25} />
          <strong>{x('electermData.emptyTitle')}</strong>
          <span>{x('electermData.emptyDescription')}</span>
        </div>
      )}

      {preview && (
        <div className="electerm-data-preview">
          <div className="electerm-data-preview-head">
            <div>
              <small>{x('electermData.preview')}</small>
              <strong>{preview.sourceName}</strong>
              <span>
                {x('electermData.validUntil', {
                  time: new Date(preview.expiresAt).toLocaleTimeString(language),
                })}
              </span>
            </div>
            <button
              aria-label={x('electermData.cancelPreview')}
              onClick={() => void discardPreview()}
            >
              <X size={15} />
            </button>
          </div>

          <div className="electerm-data-metrics">
            <Metric
              label={x('electermData.actionCreate')}
              value={preview.counts.create}
              tone="create"
            />
            <Metric
              label={x('electermData.actionUnchanged')}
              value={preview.counts.unchanged}
              tone="unchanged"
            />
            <Metric label={x('electermData.actionSkip')} value={preview.counts.skip} tone="skip" />
            <Metric label={x('electermData.kindGroup')} value={preview.counts.groups} />
            <Metric label={x('electermData.kindSshBookmark')} value={preview.counts.sshBookmarks} />
            <Metric label={x('electermData.kindProfile')} value={preview.counts.profiles} />
            <Metric label={x('electermData.portableSettings')} value={preview.counts.settings} />
            <Metric
              label={x('electermData.credentialMetadata')}
              value={preview.counts.credentialMetadata}
            />
          </div>

          <div className="electerm-data-filterbar">
            <div
              className="electerm-data-filters"
              role="group"
              aria-label={x('electermData.filters')}
            >
              {(['all', 'create', 'unchanged', 'skip'] as const).map((value) => (
                <button
                  className={filter === value ? 'active' : ''}
                  key={value}
                  onClick={() => setFilter(value)}
                >
                  {x(value === 'all' ? 'electermData.all' : actionLabelKeys[value])}
                </button>
              ))}
            </div>
            <label className="electerm-data-search">
              <Search size={13} />
              <input
                aria-label={x('electermData.search')}
                placeholder={x('electermData.searchPlaceholder')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>

          <div
            className="electerm-data-table"
            role="table"
            aria-label={x('electermData.mappingReport')}
          >
            {visibleEntries.map((entry) => (
              <article className="electerm-data-row" key={entry.key} role="row">
                <span className={`electerm-data-state ${entry.action}`}>
                  {x(actionLabelKeys[entry.action])}
                </span>
                <div className="electerm-data-entry">
                  <div>
                    <strong>{entry.name}</strong>
                    <small>{x(kindLabelKeys[entry.kind])}</small>
                  </div>
                  <code>{entry.sourceId}</code>
                  {entry.mappedFields.length > 0 && (
                    <p>{x('electermData.mapped', { fields: entry.mappedFields.join(', ') })}</p>
                  )}
                  {entry.omittedFields.length > 0 && (
                    <p className="omitted">
                      {x('electermData.omitted', { fields: entry.omittedFields.join(', ') })}
                    </p>
                  )}
                  {entry.reasons.map((reason) => (
                    <p className="reason" key={reason}>
                      {reason}
                    </p>
                  ))}
                </div>
              </article>
            ))}
            {visibleEntries.length === 0 && (
              <div className="electerm-data-no-match">{x('electermData.noMatches')}</div>
            )}
          </div>
          <small className="electerm-data-limit">{x('electermData.displayLimit')}</small>

          <footer className="electerm-data-commit">
            <span>{x('electermData.commitSafety')}</span>
            <button onClick={() => void discardPreview()}>{x('common.cancel')}</button>
            <button
              className="primary"
              disabled={!!busy || preview.counts.create === 0}
              onClick={() => void commit()}
            >
              {busy === 'commit' ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <Upload size={14} />
              )}
              {x('electermData.importCount', { count: preview.counts.create })}
            </button>
          </footer>
        </div>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'create' | 'unchanged' | 'skip';
}) {
  return (
    <div className={tone ? `electerm-data-metric ${tone}` : 'electerm-data-metric'}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function messageOf(error: unknown, x: ReturnType<typeof useI18n>['x']) {
  if (error instanceof Error) return error.message;
  return x('common.operationFailed');
}
