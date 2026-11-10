import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { remoteErrorOf } from '@axterm/plugin-api';
import type { ImportDialogActions } from './import-actions.ts';
import { Dialog, DialogContent, DialogTitle } from '@axterm/ui/controls';
import styles from './import.module.css';
import {
  sshConfigImportDraftSchema,
  type BookmarkTree,
  type SshConfigImportDraft,
  type SshConfigImportPreview,
  type SshConfigImportResult,
} from '@axterm/plugin-api/catalog';
import type { FileGrant } from '@axterm/plugin-api/files';
import { Check, FilePlus2, FolderOpen, Pencil, RefreshCw, Trash2, X } from 'lucide-react';
import {
  draftsFromPreview,
  importStatusLabelKeys,
  parseEditedDraft,
  replaceDraft,
  replaceIncludeGrant,
  resultStatusLabelKeys,
  selectedDraftCount,
  type IncludeGrantBinding,
} from './import-model.ts';
import { useI18n } from './i18n.tsx';

type Client = ImportDialogActions;
const cx = (...names: string[]) =>
  names
    .join(' ')
    .split(/\s+/u)
    .filter(Boolean)
    .map((name) => name + ' ' + (styles[name] ?? ''))
    .join(' ');

export function SshConfigImportDialog({
  client,
  rootGrant,
  groupId,
  bookmarkTree,
  onClose,
  onTreeStale,
}: {
  client: Client;
  rootGrant: FileGrant;
  groupId: string | null;
  bookmarkTree: BookmarkTree;
  onClose(): void;
  onTreeStale(): Promise<void> | void;
}) {
  const { x } = useI18n();
  const [preview, setPreview] = useState<SshConfigImportPreview>();
  const [drafts, setDrafts] = useState<SshConfigImportDraft[]>([]);
  const [bindings, setBindings] = useState<IncludeGrantBinding[]>([]);
  const [result, setResult] = useState<SshConfigImportResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<
    | ''
    | 'sshConfigImport.stalePreview'
    | 'sshConfigImport.directoryUnavailable'
    | 'sshConfigImport.failed'
  >('');
  const [editingId, setEditingId] = useState<string>();
  const [editValue, setEditValue] = useState('');
  const [editError, setEditError] = useState('');
  const mounted = useRef(false);
  const request = useRef<AbortController>();
  const command = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const locked = busy || command.status !== 'idle';

  const loadPreview = useCallback(
    async (nextBindings: IncludeGrantBinding[]) => {
      request.current?.abort();
      const current = new AbortController();
      request.current = current;
      setBusy(true);
      setError('');
      try {
        const next = await client.previewSshConfigImport(
          {
            grantId: rootGrant.grantId,
            includeGrants: nextBindings,
          },
          current.signal,
        );
        if (!mounted.current || request.current !== current) return false;
        setPreview(next);
        setDrafts(draftsFromPreview(next.items));
        setEditingId(undefined);
        setEditError('');
        setResult(undefined);
        return true;
      } catch (cause) {
        if (mounted.current && request.current === current) setError(errorKey(cause));
        return false;
      } finally {
        if (mounted.current && request.current === current) setBusy(false);
      }
    },
    [client, rootGrant.grantId],
  );

  useEffect(() => {
    mounted.current = true;
    let active = true;
    queueMicrotask(() => {
      if (active) void loadPreview([]);
    });
    return () => {
      active = false;
      mounted.current = false;
      request.current?.abort();
    };
  }, [loadPreview]);
  async function close() {
    onClose();
  }

  async function authorizeInclude(includeId: string, kind: 'open-file' | 'open-directory') {
    if (locked) return;
    setBusy(true);
    setError('');
    let grant: FileGrant | undefined;
    try {
      grant = await client.createFileGrant(kind);
      if (!grant) return;
      const replacement = replaceIncludeGrant(bindings, {
        includeId,
        grantId: grant.grantId,
      });
      if (!(await loadPreview(replacement.bindings))) {
        await client.revokeFileGrant(grant.grantId);
        return;
      }
      if (!mounted.current) return;
      setBindings(replacement.bindings);
      await Promise.all(
        replacement.removedGrantIds.map((grantId) => client.revokeFileGrant(grantId)),
      );
    } catch (cause) {
      if (grant) {
        await client.revokeFileGrant(grant.grantId).catch(() => undefined);
      }
      if (!mounted.current) return;
      setError(errorKey(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  function beginEdit(draft: SshConfigImportDraft) {
    setEditingId(draft.id);
    setEditValue(JSON.stringify(draft, null, 2));
    setEditError('');
  }

  function confirmEdit() {
    if (locked || !editingId) return;
    try {
      const parsed = parseEditedDraft(
        editValue,
        editingId,
        (value) => {
          const result = sshConfigImportDraftSchema.safeParse(value);
          if (result.success) return result.data;
          const issue = result.error.issues[0];
          const field = issue?.path.length ? `${issue.path.join('.')}: ` : '';
          throw new Error(`${field}${issue?.message ?? x('sshConfigImport.invalidItem')}`);
        },
        {
          invalidJson: x('sshConfigImport.invalidJson'),
          immutableId: x('sshConfigImport.immutableId'),
        },
      );
      setDrafts((current) => replaceDraft(current, parsed));
      setEditingId(undefined);
      setEditError('');
    } catch (cause) {
      setEditError(cause instanceof Error ? cause.message : x('sshConfigImport.invalidItem'));
    }
  }

  function setSelected(id: string, selected: boolean) {
    if (locked) return;
    setDrafts((current) =>
      current.map((draft) => (draft.id === id ? { ...draft, selected } : draft)),
    );
  }

  async function commit() {
    if (!preview || busy || selectedDraftCount(drafts) === 0) return;
    setBusy(true);
    setError('');
    try {
      const committed = await client.commitSshConfigImport(
        { previewId: preview.previewId, groupId, items: drafts },
        bookmarkTree,
      );
      if (!mounted.current) return;
      setResult(committed);
    } catch (cause) {
      if (!mounted.current) return;
      if (isStale(cause)) {
        setError('sshConfigImport.stalePreview');
        await onTreeStale();
      } else {
        setError(errorKey(cause));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogContent
        className={cx('modal', 'ssh-config-import-modal')}
        overlayClassName={cx('import-backdrop')}
        aria-describedby={undefined}
      >
        <header>
          <div>
            <DialogTitle asChild>
              <h2>{x('sshConfigImport.load')}</h2>
            </DialogTitle>
            <small>{rootGrant.name}</small>
          </div>
          <button aria-label={x('sshConfigImport.close')} onClick={() => void close()}>
            ×
          </button>
        </header>

        {command.status === 'uncertain' && (
          <div className={cx('ssh-import-error')}>{x('sshConfigImport.uncertain')}</div>
        )}
        {error && <div className={cx('ssh-import-error')}>{x(error)}</div>}
        {busy && !preview && (
          <div className={cx('ssh-import-loading')}>
            <RefreshCw className={cx('spin')} size={15} /> {x('sshConfigImport.parsing')}
          </div>
        )}

        {preview && !result && (
          <div className={cx('ssh-import-body')}>
            <div className={cx('ssh-import-toolbar')}>
              <button
                className={cx('ssh-import-reload')}
                disabled={locked}
                onClick={() => void loadPreview(bindings)}
              >
                <RefreshCw className={cx(busy ? 'spin' : '')} size={13} />{' '}
                {x('sshConfigImport.reload')}
              </button>
              <output
                className={cx('ssh-import-summary')}
                aria-label={x('sshConfigImport.previewSummary', {
                  imported: preview.summary.imported,
                  linked: preview.summary.linked,
                  unchanged: preview.summary.unchanged,
                  skipped: preview.summary.skipped,
                  selected: selectedDraftCount(drafts),
                  warnings: preview.summary.warningCount,
                })}
              />
            </div>

            {preview.includes.length > 0 && (
              <section
                className={cx('ssh-import-includes')}
                aria-label={x('sshConfigImport.includeGrants')}
              >
                <div className={cx('ssh-import-section-title')}>
                  <strong>{x('sshConfigImport.includeAuthorization')}</strong>
                  <span>{x('sshConfigImport.includeDescription')}</span>
                </div>
                {preview.includes.map((include) => (
                  <div className={cx('ssh-import-include')} key={include.id}>
                    <div>
                      <strong>{include.pattern}</strong>
                      <small>
                        {x('sshConfigImport.sourceLine', {
                          source: include.sourceName,
                          line: include.line,
                        })}
                      </small>
                      {include.grantName && (
                        <span>
                          {x('sshConfigImport.authorizedAs', { name: include.grantName })}
                        </span>
                      )}
                      {include.notice && <p>{include.notice.message}</p>}
                    </div>
                    <span className={cx(`include-status ${include.status}`)}>
                      {
                        {
                          'authorization-required': x('sshConfigImport.authorizationRequired'),
                          authorized: x('sshConfigImport.filesRead', { count: include.fileCount }),
                          skipped: x('sshConfigImport.skipped'),
                        }[include.status]
                      }
                    </span>
                    <div className={cx('ssh-import-include-actions')}>
                      <button
                        disabled={locked}
                        aria-label={x('sshConfigImport.chooseFileFor', {
                          pattern: include.pattern,
                        })}
                        onClick={() => void authorizeInclude(include.id, 'open-file')}
                      >
                        <FilePlus2 size={12} /> {x('sshConfigImport.file')}
                      </button>
                      <button
                        disabled={locked}
                        aria-label={x('sshConfigImport.chooseDirectoryFor', {
                          pattern: include.pattern,
                        })}
                        onClick={() => void authorizeInclude(include.id, 'open-directory')}
                      >
                        <FolderOpen size={12} /> {x('sshConfigImport.directory')}
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            )}

            <section
              className={cx('ssh-import-items ssh-config-list')}
              aria-label={x('sshConfigImport.items')}
            >
              {preview.items.map((item, index) => {
                const draft = drafts.find(({ id }) => id === item.id);
                if (draft && !draft.selected) return null;
                return (
                  <article className={cx('ssh-import-item')} key={item.id}>
                    <div className={cx('ssh-import-item-heading')}>
                      <b>[{index + 1}]</b>
                      {draft && (
                        <div className={cx('ssh-import-item-actions')}>
                          <button
                            title="Edit"
                            aria-label={x('sshConfigImport.editNamed', { name: item.alias })}
                            disabled={locked}
                            onClick={() => beginEdit(draft)}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            title="Delete"
                            aria-label={x('sshConfigImport.excludeNamed', { name: item.alias })}
                            disabled={locked}
                            onClick={() => setSelected(draft.id, false)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                    {item.notices.map((notice) => (
                      <p key={`${notice.code}:${notice.line}`}>{notice.message}</p>
                    ))}
                    {editingId === item.id ? (
                      <div className={cx('ssh-import-editor')}>
                        <label htmlFor={`ssh-import-edit-${item.id}`}>
                          {x('sshConfigImport.editSafeFields')}
                        </label>
                        <textarea
                          disabled={locked}
                          id={`ssh-import-edit-${item.id}`}
                          aria-label={x('sshConfigImport.editJson', { name: item.alias })}
                          rows={14}
                          value={editValue}
                          onChange={(event) => setEditValue(event.target.value)}
                        />
                        {editError && <p className={cx('ssh-import-edit-error')}>{editError}</p>}
                        <div>
                          <button
                            onClick={() => {
                              setEditingId(undefined);
                              setEditError('');
                            }}
                          >
                            <X size={12} /> {x('common.cancel')}
                          </button>
                          <button className={cx('primary')} disabled={locked} onClick={confirmEdit}>
                            <Check size={12} /> {x('sshConfigImport.applyChanges')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <pre className={cx('ssh-config-item-content')}>
                        {JSON.stringify(
                          draft
                            ? upstreamSshConfigPreview(draft)
                            : { title: item.alias, status: x(importStatusLabelKeys[item.status]) },
                          null,
                          2,
                        )}
                      </pre>
                    )}
                  </article>
                );
              })}
            </section>

            {preview.notices.map((notice) => (
              <p className={cx('ssh-import-global-notice')} key={`${notice.code}:${notice.line}`}>
                {x('sshConfigImport.noticeLine', { line: notice.line, message: notice.message })}
              </p>
            ))}
            <footer className={cx('ssh-import-footer')}>
              <div>
                <button
                  aria-label={x('sshConfigImport.confirmCount', {
                    count: selectedDraftCount(drafts),
                  })}
                  className={cx('primary')}
                  disabled={busy || selectedDraftCount(drafts) === 0}
                  onClick={() => void commit()}
                >
                  {x(
                    busy
                      ? 'sshConfigImport.importing'
                      : command.receipt
                        ? 'sshConfigImport.retryReport'
                        : 'sshConfigImport.import',
                  )}
                </button>
                <button onClick={() => void close()}>{x('common.cancel')}</button>
              </div>
              <span>{x('sshConfigImport.atomicCommit')}</span>
            </footer>
          </div>
        )}

        {result && (
          <div className={cx('ssh-import-body')} aria-label={x('sshConfigImport.report')}>
            <div className={cx('ssh-import-metrics')}>
              <ImportMetric label={x('sshConfigImport.created')} value={result.summary.imported} />
              <ImportMetric
                label={x('sshConfigImport.linkedBookmarks')}
                value={result.summary.linked}
              />
              <ImportMetric
                label={x('sshConfigImport.noChange')}
                value={result.summary.unchanged}
              />
              <ImportMetric label={x('sshConfigImport.skip')} value={result.summary.skipped} />
              <ImportMetric
                label={x('sshConfigImport.warnings')}
                value={result.summary.warningCount}
              />
            </div>
            <section
              className={cx('ssh-import-items')}
              aria-label={x('sshConfigImport.resultItems')}
            >
              {result.items.map((item) => (
                <article className={cx('ssh-import-item')} key={`${item.index}:${item.alias}`}>
                  <div className={cx('ssh-import-item-heading')}>
                    <span className={cx(`import-status ${item.status}`)}>
                      {x(resultStatusLabelKeys[item.status])}
                    </span>
                    <div>
                      <strong>
                        {result.tree.bookmarks.find(({ id }) => id === item.bookmarkId)?.title ??
                          item.alias}
                      </strong>
                      <small>
                        {x('sshConfigImport.aliasLine', { alias: item.alias, line: item.line })}
                      </small>
                    </div>
                  </div>
                  {item.notices.map((notice) => (
                    <p key={`${notice.code}:${notice.line}`}>{notice.message}</p>
                  ))}
                </article>
              ))}
            </section>
            <footer className={cx('ssh-import-footer')}>
              <span>{x('sshConfigImport.resultSaved')}</span>
              <button className={cx('primary')} onClick={() => void close()}>
                {x('sshConfigImport.done')}
              </button>
            </footer>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ImportMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className={cx('ssh-import-metric')}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function upstreamSshConfigPreview(draft: SshConfigImportDraft) {
  return {
    title: draft.title,
    host: draft.hostname,
    port: draft.port,
    username: draft.username,
    term: 'xterm-256color',
    compression: draft.connectionOptions.compression,
    serverAliveInterval: Math.floor(draft.connectionOptions.keepaliveIntervalMs / 1_000),
  };
}

function errorKey(
  cause: unknown,
): 'sshConfigImport.directoryUnavailable' | 'sshConfigImport.failed' {
  return cause instanceof Error && cause.message === 'CATALOG_IMPORT_DIRECTORY_UNAVAILABLE'
    ? 'sshConfigImport.directoryUnavailable'
    : 'sshConfigImport.failed';
}

function isStale(cause: unknown): boolean {
  const marked = remoteErrorOf(cause);
  return marked?.code === 'catalog/failure' && marked.details.reason === 'precondition-failed';
}
