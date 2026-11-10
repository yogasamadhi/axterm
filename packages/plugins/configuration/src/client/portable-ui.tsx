import { CheckCircle2, Download, FileJson2, LoaderCircle, Upload, X } from 'lucide-react';
import presentationStyles, {
  cssText as portablePresentationCss,
} from './portable-presentation.module.css';
export { portablePresentationCss };
const cx = (names: string) =>
  names
    .split(/\s+/u)
    .map((name) => name + ' ' + (presentationStyles[name] ?? ''))
    .join(' ');
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import { Button, Input } from '@axterm/ui/controls';
import type { ConfigurationPortableModel } from './portable.ts';
import styles from './ui.module.css';
export function ConfigurationPortablePanel({
  ctx,
  model,
  t,
}: {
  ctx: Context;
  model: ConfigurationPortableModel;
  t: PropsLocale<'configuration'>['t'];
}) {
  const desktop = location.protocol === 'axterm-app:';
  const upload = useRef<HTMLInputElement>(null);
  const uploadAction = useRef<'inspect' | 'preview'>('preview');
  const downloads = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [applySettings, setApplySettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<
    'portableFailed' | 'portableExported' | 'portableInspected' | 'portableImported'
  >();
  const [unconfirmed, setUnconfirmed] = useState<{ commandId: string; previewId: string }>();
  const active = useRef(false);
  const commitIntent = useRef<{ commandId: string; previewId: string; generation: string }>();
  const alive = useRef(true);
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    alive.current = true;
    const operation = new AbortController(),
      ownedDownloads = downloads.current;
    lifetime.current = operation;
    return () => {
      alive.current = false;
      operation.abort();
      for (const [url, timer] of ownedDownloads) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      ownedDownloads.clear();
    };
  }, []);
  async function run(
    operation: () => Promise<unknown>,
    success?: 'portableExported' | 'portableInspected' | 'portableImported',
  ) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await operation();
      if (alive.current) setNotice(result === false ? undefined : success);
    } catch {
      if (alive.current) setNotice('portableFailed');
    } finally {
      active.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function choose(
    kind: 'open-file' | 'save-file',
    operation: (grantId: string) => Promise<unknown>,
  ) {
    const files = ctx.get('fileGrantActions');
    if (!files) throw new Error('CONFIGURATION_FILE_SELECTION_UNAVAILABLE');
    const grant = await files.create({ kind }, lifetime.current.signal);
    if (!grant) return false;
    try {
      await operation(grant.grantId);
      return true;
    } finally {
      await files.revoke(grant.grantId);
    }
  }
  async function commit(previewId: string, commandId?: string) {
    const facts = model.getSnapshot();
    if (facts.status !== 'ready') throw Error('CONFIGURATION_PORTABLE_NOT_READY');
    const previous = commitIntent.current;
    if (
      previous &&
      (previous.previewId !== previewId ||
        previous.generation !== facts.baseline.generation ||
        (commandId && previous.commandId !== commandId))
    )
      throw Error('CONFIGURATION_IMPORT_OUTCOME_UNCERTAIN');
    const intent = previous ?? {
      previewId,
      commandId: commandId ?? crypto.randomUUID(),
      generation: facts.baseline.generation,
    };
    commitIntent.current = intent;
    if (alive.current) setUnconfirmed({ commandId: intent.commandId, previewId });
    await model.commit(intent.commandId, previewId);
    commitIntent.current = undefined;
    if (alive.current) setUnconfirmed(undefined);
  }
  async function exportFile() {
    if (desktop) return choose('save-file', (id) => model.export(id));
    const blob = await model.exportDownload();
    if (!alive.current) return false;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'axterm-configuration.json';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      downloads.current.delete(url);
    }, 1000);
    downloads.current.set(url, timer);
    return true;
  }
  function selectFile(action: 'inspect' | 'preview') {
    if (desktop) {
      void run(
        () =>
          choose('open-file', (id) =>
            action === 'inspect' ? model.inspect(id) : model.preview(id, applySettings),
          ),
        action === 'inspect' ? 'portableInspected' : undefined,
      );
    } else {
      uploadAction.current = action;
      upload.current?.click();
    }
  }
  const ready = state.status === 'ready';
  const language = useSyncExternalStore(ctx.locale.subscribe, ctx.locale.getSnapshot).active;
  const x = t,
    inspectionResult = ready ? state.inspection : undefined,
    configurationImportResult = ready ? state.receipt : undefined,
    configurationResult = ready ? state.exported : undefined;
  const visibleNotice =
    notice === 'portableFailed' || (notice === 'portableExported' && !configurationResult)
      ? notice
      : undefined;
  return (
    <section
      className={cx('surface data-migration-panel')}
      aria-label={t('portableTitle')}
      data-configuration-portable=""
    >
      <Input
        ref={upload}
        className={styles.fileInput}
        type="file"
        accept="application/json,.json"
        hidden
        data-configuration-upload=""
        aria-label={t('portablePreview')}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (!file) return;
          const action = uploadAction.current;
          void run(
            () =>
              action === 'inspect'
                ? model.inspectUpload(file)
                : model.previewUpload(file, applySettings),
            action === 'inspect' ? 'portableInspected' : undefined,
          );
        }}
      />
      <section className={cx('axterm-config-export')}>
        <div>
          <strong>{x('axtermConfig.title')}</strong>
          <p>{x('axtermConfig.description')}</p>
          <p>{x('axtermConfig.limits')}</p>
          <label className={cx('axterm-config-settings-option')}>
            <input
              checked={applySettings}
              disabled={busy || !ready}
              type="checkbox"
              onChange={(event) => setApplySettings(event.target.checked)}
            />
            <span>{x('axtermConfig.applySettings')}</span>
          </label>
        </div>
        <div className={cx('axterm-config-actions')}>
          <button disabled={busy || !ready} onClick={() => void selectFile('inspect')}>
            {busy ? <LoaderCircle className={cx('spin')} size={14} /> : <FileJson2 size={14} />}
            {x('axtermConfig.inspect')}
          </button>
          <button
            className={cx('primary')}
            disabled={busy || !ready}
            onClick={() => void selectFile('preview')}
          >
            {busy ? <LoaderCircle className={cx('spin')} size={14} /> : <Upload size={14} />}
            {x('axtermConfig.import')}
          </button>
          <button
            disabled={busy || !ready}
            onClick={() => void run(exportFile, 'portableExported')}
          >
            {busy ? <LoaderCircle className={cx('spin')} size={14} /> : <Download size={14} />}
            {x('axtermConfig.export')}
          </button>
        </div>
      </section>

      {!ready && (
        <div role="alert">
          <p>{t('portableUnavailable')}</p>
          <Button disabled={busy || !ready} onClick={() => void run(() => model.retry())}>
            {t('portableReload')}
          </Button>
        </div>
      )}
      {inspectionResult && (
        <div
          data-configuration-inspection=""
          className={cx('data-migration-result axterm-config-inspection')}
          role="status"
        >
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
            <span className={cx('axterm-config-hash')}>SHA-256: {inspectionResult.sha256}</span>
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

      {ready &&
        state.baseline.previews.map((preview) => (
          <section
            key={preview.previewId}
            data-configuration-preview={preview.previewId}
            className={cx('axterm-config-preview')}
            aria-label={x('axtermConfig.preview')}
          >
            <div className={cx('data-migration-preview-head')}>
              <div>
                <small>{x('axtermConfig.preview')}</small>
                <strong>{x('axtermConfig.previewTitle')}</strong>
                <span>
                  {x('axtermConfig.validUntil', {
                    time: new Date(preview.expiresAt).toLocaleTimeString(language),
                  })}
                </span>
              </div>
              <button
                aria-label={x('axtermConfig.cancelPreview')}
                onClick={() => void run(() => model.cancel(preview.previewId))}
              >
                <X size={15} />
              </button>
            </div>
            <div className={cx('data-migration-metrics')}>
              <Metric
                label={x('axtermConfig.create')}
                value={preview.counts.create}
                tone="create"
              />
              <Metric
                label={x('axtermConfig.unchanged')}
                value={preview.counts.unchanged}
                tone="unchanged"
              />
              <Metric
                label={x('axtermConfig.conflict')}
                value={preview.counts.conflict}
                tone="conflict"
              />
              <Metric
                label={x('axtermConfig.preserved')}
                value={preview.counts.skipped}
                tone="skip"
              />
              <Metric label={x('axtermConfig.items')} value={preview.entityCount} />
              <Metric label={x('axtermConfig.issues')} value={preview.issueCount} />
            </div>
            <p className={cx('axterm-config-preview-note')}>
              {preview.settings === 'will-apply'
                ? x('axtermConfig.settingsWillApply')
                : x('axtermConfig.settingsPreserved')}
            </p>
            {preview.issues.length > 0 && (
              <ul className={cx('axterm-config-preview-issues')}>
                {preview.issues.slice(0, 20).map((issue, index) => (
                  <li key={`${issue.kind}:${issue.path}:${index}`}>
                    {issue.kind}: {issue.path}
                  </li>
                ))}
              </ul>
            )}
            {!preview.canCommit && (
              <p className={cx('data-migration-error')} role="alert">
                {x('axtermConfig.cannotImport')}
              </p>
            )}
            <footer className={cx('data-migration-commit')}>
              <span>{x('axtermConfig.commitSafety')}</span>
              <button onClick={() => void run(() => model.cancel(preview.previewId))}>
                {x('common.cancel')}
              </button>
              <button
                className={cx('primary')}
                disabled={
                  busy ||
                  !preview.canCommit ||
                  (preview.counts.create === 0 && preview.settings !== 'will-apply')
                }
                onClick={() => void run(() => commit(preview.previewId), 'portableImported')}
              >
                {busy ? <LoaderCircle className={cx('spin')} size={14} /> : <Upload size={14} />}
                {x('axtermConfig.importCount', { count: preview.counts.create })}
              </button>
            </footer>
          </section>
        ))}

      {configurationImportResult && (
        <div
          data-configuration-import-result=""
          className={cx('data-migration-result')}
          role="status"
        >
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
        <div className={cx('data-migration-result')} role="status">
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
            <span className={cx('axterm-config-hash')}>SHA-256: {configurationResult.sha256}</span>
          </div>
        </div>
      )}

      {unconfirmed && (
        <Button
          disabled={busy || !ready}
          onClick={() =>
            void run(() => commit(unconfirmed.previewId, unconfirmed.commandId), 'portableImported')
          }
        >
          {t('portableRecover')}
        </Button>
      )}
      {visibleNotice && (
        <p role={visibleNotice === 'portableFailed' ? 'alert' : 'status'}>{t(visibleNotice)}</p>
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
    <div className={cx(`data-migration-metric ${tone ?? ''}`)}>
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
