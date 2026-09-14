import { useCallback, useEffect, useRef, useState } from 'react';
import { RuntimeClientError, type createRuntimeClient } from '@workspace/client';
import {
  sshConfigImportDraftSchema,
  type BookmarkTree,
  type SshConfigImportDraft,
  type SshConfigImportPreview,
  type SshConfigImportResult,
} from '@workspace/contracts';
import type { FileGrant } from '@workspace/contracts/desktop';
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
} from './ssh-config-import-model';
import './ssh-config-import.css';
import { useI18n } from '../../i18n/context';

type Client = ReturnType<typeof createRuntimeClient>;

export function SshConfigImportDialog({
  client,
  rootGrant,
  groupId,
  bookmarkTree,
  onClose,
  onCommitted,
  onTreeStale,
}: {
  client: Client;
  rootGrant: FileGrant;
  groupId: string | null;
  bookmarkTree: BookmarkTree;
  onClose(): void;
  onCommitted(result: SshConfigImportResult): Promise<void> | void;
  onTreeStale(): Promise<void> | void;
}) {
  const { x } = useI18n();
  const [preview, setPreview] = useState<SshConfigImportPreview>();
  const [drafts, setDrafts] = useState<SshConfigImportDraft[]>([]);
  const [bindings, setBindings] = useState<IncludeGrantBinding[]>([]);
  const [result, setResult] = useState<SshConfigImportResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string>();
  const [editValue, setEditValue] = useState('');
  const [editError, setEditError] = useState('');
  const loadedRoot = useRef<string | undefined>(undefined);
  const grants = useRef(new Set([rootGrant.grantId]));
  const closing = useRef(false);
  const lifecycleEpoch = useRef(0);

  const loadPreview = useCallback(
    async (nextBindings: IncludeGrantBinding[]) => {
      setBusy(true);
      setError('');
      try {
        const next = await client.previewSshConfigImport({
          grantId: rootGrant.grantId,
          includeGrants: nextBindings,
        });
        setPreview(next);
        setDrafts(draftsFromPreview(next.items));
        setEditingId(undefined);
        setEditError('');
        setResult(undefined);
        return true;
      } catch (cause) {
        setError(messageOf(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [client, rootGrant.grantId],
  );

  useEffect(() => {
    const lifecycleEpochRef = lifecycleEpoch;
    const grantsRef = grants;
    const epoch = ++lifecycleEpochRef.current;
    if (loadedRoot.current !== rootGrant.grantId) {
      loadedRoot.current = rootGrant.grantId;
      void loadPreview([]).then((loaded) => {
        if (loaded) return;
        const failedGrants = [...grantsRef.current];
        grantsRef.current.clear();
        void Promise.allSettled(failedGrants.map((grantId) => client.revokeFileGrant(grantId)));
      });
    }
    return () => {
      // React development StrictMode immediately mounts the same component again.
      // Deferring one task lets that remount cancel the disposal while a real parent,
      // root-grant or generation teardown deterministically revokes every capability.
      setTimeout(() => {
        if (lifecycleEpochRef.current !== epoch) return;
        const activeGrants = [...grantsRef.current];
        grantsRef.current.clear();
        void Promise.allSettled(activeGrants.map((grantId) => client.revokeFileGrant(grantId)));
      }, 0);
    };
  }, [client, loadPreview, rootGrant.grantId]);

  async function close() {
    if (closing.current) return;
    closing.current = true;
    const activeGrants = [...grants.current];
    grants.current.clear();
    onClose();
    await Promise.allSettled(activeGrants.map((grantId) => client.revokeFileGrant(grantId)));
  }

  async function authorizeInclude(includeId: string, kind: 'open-file' | 'open-directory') {
    if (busy) return;
    setBusy(true);
    setError('');
    let grant: FileGrant | undefined;
    try {
      grant = await client.createFileGrant(kind);
      if (!grant) return;
      grants.current.add(grant.grantId);
      const replacement = replaceIncludeGrant(bindings, {
        includeId,
        grantId: grant.grantId,
      });
      if (!(await loadPreview(replacement.bindings))) {
        grants.current.delete(grant.grantId);
        void client.revokeFileGrant(grant.grantId).catch(() => undefined);
        return;
      }
      setBindings(replacement.bindings);
      for (const grantId of replacement.removedGrantIds) grants.current.delete(grantId);
      await Promise.allSettled(
        replacement.removedGrantIds.map((grantId) => client.revokeFileGrant(grantId)),
      );
    } catch (cause) {
      if (grant) {
        grants.current.delete(grant.grantId);
        void client.revokeFileGrant(grant.grantId).catch(() => undefined);
      }
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  function beginEdit(draft: SshConfigImportDraft) {
    setEditingId(draft.id);
    setEditValue(JSON.stringify(draft, null, 2));
    setEditError('');
  }

  function confirmEdit() {
    if (!editingId) return;
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
      setEditError(messageOf(cause));
    }
  }

  function setSelected(id: string, selected: boolean) {
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
      setResult(committed);
      await onCommitted(committed);
    } catch (cause) {
      if (cause instanceof RuntimeClientError && cause.status === 412) {
        setError(x('sshConfigImport.stalePreview'));
        await onTreeStale();
      } else {
        setError(messageOf(cause));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void close();
      }}
    >
      <section
        className="modal ssh-config-import-modal"
        role="dialog"
        aria-modal="true"
        aria-label={x('sshConfigImport.title')}
      >
        <header>
          <div>
            <h2>{x('sshConfigImport.load')}</h2>
            <small>{rootGrant.name}</small>
          </div>
          <button aria-label={x('sshConfigImport.close')} onClick={() => void close()}>
            ×
          </button>
        </header>

        {error && <div className="ssh-import-error">{error}</div>}
        {busy && !preview && (
          <div className="ssh-import-loading">
            <RefreshCw className="spin" size={15} /> {x('sshConfigImport.parsing')}
          </div>
        )}

        {preview && !result && (
          <div className="ssh-import-body">
            <div className="ssh-import-toolbar">
              <button
                className="ssh-import-reload"
                disabled={busy}
                onClick={() => void loadPreview(bindings)}
              >
                <RefreshCw className={busy ? 'spin' : ''} size={13} /> {x('sshConfigImport.reload')}
              </button>
              <output
                className="ssh-import-summary"
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
                className="ssh-import-includes"
                aria-label={x('sshConfigImport.includeGrants')}
              >
                <div className="ssh-import-section-title">
                  <strong>{x('sshConfigImport.includeAuthorization')}</strong>
                  <span>{x('sshConfigImport.includeDescription')}</span>
                </div>
                {preview.includes.map((include) => (
                  <div className="ssh-import-include" key={include.id}>
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
                    <span className={`include-status ${include.status}`}>
                      {
                        {
                          'authorization-required': x('sshConfigImport.authorizationRequired'),
                          authorized: x('sshConfigImport.filesRead', { count: include.fileCount }),
                          skipped: x('sshConfigImport.skipped'),
                        }[include.status]
                      }
                    </span>
                    <div className="ssh-import-include-actions">
                      <button
                        disabled={busy}
                        aria-label={x('sshConfigImport.chooseFileFor', {
                          pattern: include.pattern,
                        })}
                        onClick={() => void authorizeInclude(include.id, 'open-file')}
                      >
                        <FilePlus2 size={12} /> {x('sshConfigImport.file')}
                      </button>
                      <button
                        disabled={busy}
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
              className="ssh-import-items ssh-config-list"
              aria-label={x('sshConfigImport.items')}
            >
              {preview.items.map((item, index) => {
                const draft = drafts.find(({ id }) => id === item.id);
                if (draft && !draft.selected) return null;
                return (
                  <article className="ssh-import-item" key={item.id}>
                    <div className="ssh-import-item-heading">
                      <b>[{index + 1}]</b>
                      {draft && (
                        <div className="ssh-import-item-actions">
                          <button
                            title="Edit"
                            aria-label={x('sshConfigImport.editNamed', { name: item.alias })}
                            onClick={() => beginEdit(draft)}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            title="Delete"
                            aria-label={x('sshConfigImport.excludeNamed', { name: item.alias })}
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
                      <div className="ssh-import-editor">
                        <label htmlFor={`ssh-import-edit-${item.id}`}>
                          {x('sshConfigImport.editSafeFields')}
                        </label>
                        <textarea
                          id={`ssh-import-edit-${item.id}`}
                          aria-label={x('sshConfigImport.editJson', { name: item.alias })}
                          rows={14}
                          value={editValue}
                          onChange={(event) => setEditValue(event.target.value)}
                        />
                        {editError && <p className="ssh-import-edit-error">{editError}</p>}
                        <div>
                          <button
                            onClick={() => {
                              setEditingId(undefined);
                              setEditError('');
                            }}
                          >
                            <X size={12} /> {x('common.cancel')}
                          </button>
                          <button className="primary" onClick={confirmEdit}>
                            <Check size={12} /> {x('sshConfigImport.applyChanges')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <pre className="ssh-config-item-content">
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
              <p className="ssh-import-global-notice" key={`${notice.code}:${notice.line}`}>
                {x('sshConfigImport.noticeLine', { line: notice.line, message: notice.message })}
              </p>
            ))}
            <footer className="ssh-import-footer">
              <div>
                <button
                  aria-label={x('sshConfigImport.confirmCount', {
                    count: selectedDraftCount(drafts),
                  })}
                  className="primary"
                  disabled={busy || selectedDraftCount(drafts) === 0}
                  onClick={() => void commit()}
                >
                  {x(busy ? 'sshConfigImport.importing' : 'sshConfigImport.import')}
                </button>
                <button onClick={() => void close()}>{x('common.cancel')}</button>
              </div>
              <span>{x('sshConfigImport.atomicCommit')}</span>
            </footer>
          </div>
        )}

        {result && (
          <div className="ssh-import-body" aria-label={x('sshConfigImport.report')}>
            <div className="ssh-import-metrics">
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
            <section className="ssh-import-items" aria-label={x('sshConfigImport.resultItems')}>
              {result.items.map((item) => (
                <article className="ssh-import-item" key={`${item.index}:${item.alias}`}>
                  <div className="ssh-import-item-heading">
                    <span className={`import-status ${item.status}`}>
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
            <footer className="ssh-import-footer">
              <span>{x('sshConfigImport.resultSaved')}</span>
              <button className="primary" onClick={() => void close()}>
                {x('sshConfigImport.done')}
              </button>
            </footer>
          </div>
        )}
      </section>
    </div>
  );
}

function ImportMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="ssh-import-metric">
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

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
