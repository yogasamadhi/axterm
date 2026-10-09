import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type {
  AxtermConfigurationExportResult,
  AxtermConfigurationImportResult,
  AxtermConfigurationInspectResult,
  AxtermConfigurationPreview,
} from '@workspace/contracts';
import { CheckCircle2, Download, FileJson2, LoaderCircle, Upload, X } from 'lucide-react';
import './data-migration.css';
import { useI18n } from '../../i18n/context';
import { useWorkspace } from '../../stores/workspace';

type Client = ReturnType<typeof createRuntimeClient>;

export function DataMigrationPanel({ client }: { client: Client }) {
  const { language, x } = useI18n();
  const queryClient = useQueryClient();
  const [configurationResult, setConfigurationResult] = useState<AxtermConfigurationExportResult>();
  const [inspectionResult, setInspectionResult] = useState<AxtermConfigurationInspectResult>();
  const [configurationPreview, setConfigurationPreview] = useState<AxtermConfigurationPreview>();
  const [configurationImportResult, setConfigurationImportResult] =
    useState<AxtermConfigurationImportResult>();
  const [applyConfigurationSettings, setApplyConfigurationSettings] = useState(false);
  const [busy, setBusy] = useState<
    | 'configuration-export'
    | 'configuration-inspect'
    | 'configuration-preview'
    | 'configuration-commit'
  >();
  const [message, setMessage] = useState('');
  const activeConfigurationPreview = useRef<string | undefined>(undefined);
  const lifecycle = useRef(0);

  useEffect(() => {
    const lifecycleRef = lifecycle;
    const activeConfigurationPreviewRef = activeConfigurationPreview;
    const epoch = ++lifecycleRef.current;
    return () => {
      setTimeout(() => {
        if (lifecycleRef.current !== epoch) return;
        const configurationPreviewId = activeConfigurationPreviewRef.current;
        activeConfigurationPreviewRef.current = undefined;
        if (configurationPreviewId)
          void client
            .cancelAxtermConfigurationPreview(configurationPreviewId)
            .catch(() => undefined);
      }, 0);
    };
  }, [client]);

  async function exportConfiguration() {
    if (busy) return;
    setBusy('configuration-export');
    setMessage('');
    setConfigurationResult(undefined);
    let grantId: string | undefined;
    try {
      const grant = await client.createFileGrant('save-file');
      if (!grant) return;
      grantId = grant.grantId;
      setConfigurationResult(await client.exportAxtermConfiguration(grantId));
    } catch (cause) {
      setMessage(messageOf(cause, x));
    } finally {
      if (grantId) await client.revokeFileGrant(grantId).catch(() => undefined);
      setBusy(undefined);
    }
  }

  async function inspectConfiguration() {
    if (busy) return;
    setBusy('configuration-inspect');
    setMessage('');
    setInspectionResult(undefined);
    let grantId: string | undefined;
    try {
      const grant = await client.createFileGrant('open-file');
      if (!grant) return;
      grantId = grant.grantId;
      setInspectionResult(await client.inspectAxtermConfiguration(grantId));
    } catch (cause) {
      setMessage(messageOf(cause, x));
    } finally {
      if (grantId) await client.revokeFileGrant(grantId).catch(() => undefined);
      setBusy(undefined);
    }
  }

  async function previewConfiguration() {
    if (busy) return;
    setBusy('configuration-preview');
    setMessage('');
    setConfigurationImportResult(undefined);
    let grantId: string | undefined;
    try {
      const grant = await client.createFileGrant('open-file');
      if (!grant) return;
      grantId = grant.grantId;
      const next = await client.previewAxtermConfiguration(grantId, applyConfigurationSettings);
      const previous = activeConfigurationPreview.current;
      activeConfigurationPreview.current = next.previewId;
      setConfigurationPreview(next);
      if (previous) void client.cancelAxtermConfigurationPreview(previous).catch(() => undefined);
    } catch (cause) {
      setMessage(messageOf(cause, x));
    } finally {
      if (grantId) await client.revokeFileGrant(grantId).catch(() => undefined);
      setBusy(undefined);
    }
  }

  async function commitConfiguration() {
    if (
      !configurationPreview ||
      busy ||
      !configurationPreview.canCommit ||
      (configurationPreview.counts.create === 0 && configurationPreview.settings !== 'will-apply')
    )
      return;
    const appliesSettings = configurationPreview.settings === 'will-apply';
    if (appliesSettings) useWorkspace.getState().beginConfigurationSettingsImport();
    let settingsCommitResolved = false;
    setBusy('configuration-commit');
    setMessage('');
    try {
      const next = await client.commitAxtermConfigurationImport(configurationPreview.previewId);
      settingsCommitResolved = true;
      if (appliesSettings) {
        if (next.settings === 'applied')
          useWorkspace.getState().completeConfigurationSettingsImport();
        else useWorkspace.getState().cancelConfigurationSettingsImport();
      }
      activeConfigurationPreview.current = undefined;
      setConfigurationImportResult(next);
      setConfigurationPreview(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bookmark-tree'] }),
        queryClient.invalidateQueries({ queryKey: ['hosts'] }),
        queryClient.invalidateQueries({ queryKey: ['connection-profiles'] }),
        queryClient.invalidateQueries({ queryKey: ['quick-commands'] }),
        queryClient.invalidateQueries({ queryKey: ['terminal-profiles'] }),
        queryClient.invalidateQueries({ queryKey: ['terminal-themes'] }),
        queryClient.invalidateQueries({ queryKey: ['tunnel-profiles'] }),
        queryClient.invalidateQueries({ queryKey: ['triggers'] }),
      ]);
      if (next.settings === 'applied') {
        queryClient.setQueryData(['settings'], await client.settings());
      } else await queryClient.invalidateQueries({ queryKey: ['settings'] });
    } catch (cause) {
      if (appliesSettings && !settingsCommitResolved)
        useWorkspace.getState().protectConfigurationSettingsImport();
      setMessage(messageOf(cause, x));
    } finally {
      setBusy(undefined);
    }
  }

  async function discardConfigurationPreview() {
    const previewId = activeConfigurationPreview.current;
    activeConfigurationPreview.current = undefined;
    setConfigurationPreview(undefined);
    if (previewId) await client.cancelAxtermConfigurationPreview(previewId).catch(() => undefined);
  }

  return (
    <section className="surface data-migration-panel" aria-label={x('axtermConfig.title')}>
      <section className="axterm-config-export">
        <div>
          <strong>{x('axtermConfig.title')}</strong>
          <p>{x('axtermConfig.description')}</p>
          <p>{x('axtermConfig.limits')}</p>
          <label className="axterm-config-settings-option">
            <input
              checked={applyConfigurationSettings}
              disabled={!!busy}
              type="checkbox"
              onChange={(event) => setApplyConfigurationSettings(event.target.checked)}
            />
            <span>{x('axtermConfig.applySettings')}</span>
          </label>
        </div>
        <div className="axterm-config-actions">
          <button disabled={!!busy} onClick={() => void inspectConfiguration()}>
            {busy === 'configuration-inspect' ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <FileJson2 size={14} />
            )}
            {x('axtermConfig.inspect')}
          </button>
          <button className="primary" disabled={!!busy} onClick={() => void previewConfiguration()}>
            {busy === 'configuration-preview' ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Upload size={14} />
            )}
            {x('axtermConfig.import')}
          </button>
          <button disabled={!!busy} onClick={() => void exportConfiguration()}>
            {busy === 'configuration-export' ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Download size={14} />
            )}
            {x('axtermConfig.export')}
          </button>
        </div>
      </section>

      {inspectionResult && (
        <div className="data-migration-result axterm-config-inspection" role="status">
          <FileJson2 size={18} />
          <div>
            <strong>{x('axtermConfig.inspected')}</strong>
            <span>
              {x('axtermConfig.inspectSummary', {
                bytes: formatBytes(inspectionResult.bytes),
                entities: inspectionResult.entityCount,
                issues: inspectionResult.issueCount,
              })}
            </span>
            <span>{x('axtermConfig.inspectOnly')}</span>
            <span className="axterm-config-hash">SHA-256: {inspectionResult.sha256}</span>
            {inspectionResult.issues.length > 0 && (
              <ul>
                {inspectionResult.issues.slice(0, 20).map((issue, index) => (
                  <li key={`${issue.kind}:${issue.path}:${index}`}>
                    {issue.kind}: {issue.path}
                  </li>
                ))}
              </ul>
            )}
            {inspectionResult.issueCount > 20 && <span>{x('axtermConfig.moreIssues')}</span>}
          </div>
        </div>
      )}

      {configurationPreview && (
        <section className="axterm-config-preview" aria-label={x('axtermConfig.preview')}>
          <div className="data-migration-preview-head">
            <div>
              <small>{x('axtermConfig.preview')}</small>
              <strong>{x('axtermConfig.previewTitle')}</strong>
              <span>
                {x('axtermConfig.validUntil', {
                  time: new Date(configurationPreview.expiresAt).toLocaleTimeString(language),
                })}
              </span>
            </div>
            <button
              aria-label={x('axtermConfig.cancelPreview')}
              onClick={() => void discardConfigurationPreview()}
            >
              <X size={15} />
            </button>
          </div>
          <div className="data-migration-metrics">
            <Metric
              label={x('axtermConfig.create')}
              value={configurationPreview.counts.create}
              tone="create"
            />
            <Metric
              label={x('axtermConfig.unchanged')}
              value={configurationPreview.counts.unchanged}
              tone="unchanged"
            />
            <Metric
              label={x('axtermConfig.conflict')}
              value={configurationPreview.counts.conflict}
              tone="conflict"
            />
            <Metric
              label={x('axtermConfig.preserved')}
              value={configurationPreview.counts.skipped}
              tone="skip"
            />
            <Metric label={x('axtermConfig.items')} value={configurationPreview.entityCount} />
            <Metric label={x('axtermConfig.issues')} value={configurationPreview.issueCount} />
          </div>
          <p className="axterm-config-preview-note">
            {configurationPreview.settings === 'will-apply'
              ? x('axtermConfig.settingsWillApply')
              : x('axtermConfig.settingsPreserved')}
          </p>
          {configurationPreview.issues.length > 0 && (
            <ul className="axterm-config-preview-issues">
              {configurationPreview.issues.slice(0, 20).map((issue, index) => (
                <li key={`${issue.kind}:${issue.path}:${index}`}>
                  {issue.kind}: {issue.path}
                </li>
              ))}
            </ul>
          )}
          {!configurationPreview.canCommit && (
            <p className="data-migration-error" role="alert">
              {x('axtermConfig.cannotImport')}
            </p>
          )}
          <footer className="data-migration-commit">
            <span>{x('axtermConfig.commitSafety')}</span>
            <button onClick={() => void discardConfigurationPreview()}>{x('common.cancel')}</button>
            <button
              className="primary"
              disabled={
                !!busy ||
                !configurationPreview.canCommit ||
                (configurationPreview.counts.create === 0 &&
                  configurationPreview.settings !== 'will-apply')
              }
              onClick={() => void commitConfiguration()}
            >
              {busy === 'configuration-commit' ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <Upload size={14} />
              )}
              {x('axtermConfig.importCount', { count: configurationPreview.counts.create })}
            </button>
          </footer>
        </section>
      )}

      {configurationImportResult && (
        <div className="data-migration-result" role="status">
          <CheckCircle2 size={18} />
          <div>
            <strong>{x('axtermConfig.importComplete')}</strong>
            <span>{x('axtermConfig.importSummary', configurationImportResult.counts)}</span>
            <span>
              {configurationImportResult.settings === 'applied'
                ? x('axtermConfig.settingsApplied')
                : x('axtermConfig.settingsPreserved')}
            </span>
          </div>
        </div>
      )}

      {configurationResult && (
        <div className="data-migration-result" role="status">
          <CheckCircle2 size={18} />
          <div>
            <strong>{x('axtermConfig.complete')}</strong>
            <span>
              {x('axtermConfig.summary', {
                bytes: formatBytes(configurationResult.bytes),
                entities: configurationResult.entityCount,
                omissions: configurationResult.omittedFieldCount,
              })}
            </span>
            <span className="axterm-config-hash">SHA-256: {configurationResult.sha256}</span>
          </div>
        </div>
      )}

      {message && (
        <p className="data-migration-error" role="alert">
          {message}
        </p>
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
  tone?: 'create' | 'unchanged' | 'skip' | 'conflict';
}) {
  return (
    <div className={tone ? `data-migration-metric ${tone}` : 'data-migration-metric'}>
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
