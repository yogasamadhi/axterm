import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type {
  ElectermDataPreview,
  SyncCategory,
  SyncComparison,
  SyncProfile,
  SyncProviderType,
} from '@workspace/contracts';
import { Check, Cloud, Download, RefreshCw, Trash2, Upload } from 'lucide-react';
import './data-sync-panel.css';
import { useI18n } from '../../i18n/context';
import type { AxtermMessageKey } from '../../i18n/core';

type Client = ReturnType<typeof createRuntimeClient>;

const providers: Array<{
  id: SyncProviderType;
  labelKey: AxtermMessageKey;
  endpoint: string;
  remoteId: string;
}> = [
  {
    id: 'github',
    labelKey: 'dataSync.providerGithub',
    endpoint: 'https://api.github.com/gists',
    remoteId: '',
  },
  {
    id: 'gitee',
    labelKey: 'dataSync.providerGitee',
    endpoint: 'https://gitee.com/api/v5/gists',
    remoteId: '',
  },
  {
    id: 'webdav',
    labelKey: 'dataSync.providerWebdav',
    endpoint: 'https://',
    remoteId: 'axterm-sync.json',
  },
  { id: 'custom', labelKey: 'dataSync.providerCustom', endpoint: 'https://', remoteId: '' },
];

const categories: Array<{
  id: SyncCategory;
  labelKey: AxtermMessageKey;
  descriptionKey: AxtermMessageKey;
}> = [
  {
    id: 'settings',
    labelKey: 'dataSync.categorySettings',
    descriptionKey: 'dataSync.categorySettingsDescription',
  },
  {
    id: 'bookmarks',
    labelKey: 'dataSync.categoryBookmarks',
    descriptionKey: 'dataSync.categoryBookmarksDescription',
  },
  {
    id: 'terminalThemes',
    labelKey: 'dataSync.categoryThemes',
    descriptionKey: 'dataSync.categoryThemesDescription',
  },
  {
    id: 'quickCommands',
    labelKey: 'dataSync.categoryCommands',
    descriptionKey: 'dataSync.categoryCommandsDescription',
  },
  {
    id: 'profiles',
    labelKey: 'dataSync.categoryProfiles',
    descriptionKey: 'dataSync.categoryProfilesDescription',
  },
  {
    id: 'addressBookmarks',
    labelKey: 'dataSync.categoryAddresses',
    descriptionKey: 'dataSync.categoryAddressesDescription',
  },
  {
    id: 'workspaces',
    labelKey: 'dataSync.categoryWorkspaces',
    descriptionKey: 'dataSync.categoryWorkspacesDescription',
  },
  {
    id: 'triggers',
    labelKey: 'dataSync.categoryTriggers',
    descriptionKey: 'dataSync.categoryTriggersDescription',
  },
];

export function DataSyncPanel({ client }: { client: Client }) {
  const { language, x } = useI18n();
  const queryClient = useQueryClient();
  const profiles = useQuery({
    queryKey: ['sync-profiles'],
    queryFn: client.syncProfiles,
    refetchInterval: 5_000,
  });
  const [provider, setProvider] = useState<SyncProviderType>('github');
  const [comparison, setComparison] = useState<SyncComparison>();
  const [preview, setPreview] = useState<ElectermDataPreview>();
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const current = profiles.data?.find((item) => item.provider === provider);
  const providerInfo = providers.find(({ id }) => id === provider)!;
  const pendingPreview = useQuery({
    queryKey: ['sync-download-preview', current?.id],
    queryFn: () => client.dataSyncDownloadPreview(current!.id),
    enabled: current?.state === 'download-preview',
    retry: false,
  });
  const reviewedPreview = preview ?? pendingPreview.data;

  async function refreshProfiles() {
    await queryClient.invalidateQueries({ queryKey: ['sync-profiles'] });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const selectedCategories = categories
      .filter(({ id }) => form.getAll('category').includes(id))
      .map(({ id }) => id);
    if (!selectedCategories.length) {
      setMessage(x('dataSync.selectCategory'));
      return;
    }
    const accessSecret = String(form.get('accessSecret') ?? '');
    const encryptionSecret = String(form.get('encryptionSecret') ?? '');
    const encryptionEnabled = form.get('encryptionEnabled') === 'on';
    if (!current?.accessCredentialConfigured && !accessSecret) {
      setMessage(
        provider === 'webdav' ? x('dataSync.enterWebdavPassword') : x('dataSync.enterAccessSecret'),
      );
      return;
    }
    if (encryptionEnabled && !current?.encryptionConfigured && !encryptionSecret) {
      setMessage(x('dataSync.encryptionPasswordRequired'));
      return;
    }

    setBusy('save');
    setMessage('');
    const createdRefs: string[] = [];
    try {
      const accessCredentialRef = accessSecret
        ? (
            await client.createCredential({
              kind: 'syncAccessToken',
              label: x('dataSync.accessCredentialLabel', { provider: x(providerInfo.labelKey) }),
              secret: accessSecret,
            })
          ).ref
        : undefined;
      if (accessCredentialRef) createdRefs.push(accessCredentialRef);
      const encryptionCredentialRef =
        encryptionEnabled && encryptionSecret
          ? (
              await client.createCredential({
                kind: 'syncEncryptionPassword',
                label: x('dataSync.encryptionCredentialLabel', {
                  provider: x(providerInfo.labelKey),
                }),
                secret: encryptionSecret,
              })
            ).ref
          : undefined;
      if (encryptionCredentialRef) createdRefs.push(encryptionCredentialRef);
      const common = {
        name: String(form.get('name') ?? '').trim(),
        endpointUrl: String(form.get('endpointUrl') ?? '').trim(),
        remoteId: String(form.get('remoteId') ?? '').trim(),
        username: provider === 'webdav' ? String(form.get('username') ?? '').trim() : null,
        selectedCategories,
        autoSyncEnabled: form.get('autoSyncEnabled') === 'on',
        autoSyncIntervalMinutes: Number(form.get('autoSyncIntervalMinutes')),
        autoSyncDirection:
          form.get('autoSyncDirection') === 'download'
            ? ('download' as const)
            : ('upload' as const),
      };
      if (current) {
        await client.updateSyncProfile(current, {
          ...common,
          ...(accessCredentialRef ? { accessCredentialRef } : {}),
          ...(encryptionCredentialRef ? { encryptionCredentialRef } : {}),
          ...(!encryptionEnabled && current.encryptionConfigured
            ? { clearEncryptionCredential: true }
            : {}),
        });
      } else {
        await client.createSyncProfile({
          provider,
          ...common,
          accessCredentialRef: accessCredentialRef!,
          encryptionCredentialRef: encryptionCredentialRef ?? null,
        });
      }
      createdRefs.length = 0;
      formElement.reset();
      setComparison(undefined);
      setPreview(undefined);
      setMessage(x('dataSync.savedLocally'));
      await refreshProfiles();
    } catch (error) {
      await Promise.allSettled(createdRefs.map((ref) => client.deleteCredential(ref)));
      setMessage(messageOf(error, x));
    } finally {
      setBusy('');
    }
  }

  async function run(action: string, operation: () => Promise<void>) {
    setBusy(action);
    setMessage('');
    try {
      await operation();
      await refreshProfiles();
    } catch (error) {
      setMessage(messageOf(error, x));
    } finally {
      setBusy('');
    }
  }

  async function remove() {
    if (!current || !window.confirm(x('dataSync.deleteConfirm', { name: current.name }))) return;
    await run('delete', async () => {
      await client.deleteSyncProfile(current);
      setComparison(undefined);
      setPreview(undefined);
      setMessage(x('dataSync.deleted'));
    });
  }

  async function commitPreview() {
    if (!current || !reviewedPreview) return;
    await run('commit', async () => {
      const tree = await client.bookmarkTree();
      await client.commitDataSyncDownload(current.id, reviewedPreview.previewId, tree);
      setPreview(undefined);
      queryClient.removeQueries({ queryKey: ['sync-download-preview', current.id] });
      setComparison(undefined);
      setMessage(x('dataSync.previewCommitted'));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['settings'] }),
        queryClient.invalidateQueries({ queryKey: ['bookmark-tree'] }),
        queryClient.invalidateQueries({ queryKey: ['quick-command-tree'] }),
        queryClient.invalidateQueries({ queryKey: ['terminal-themes'] }),
        queryClient.invalidateQueries({ queryKey: ['triggers'] }),
      ]);
    });
  }

  return (
    <section className="data-sync-panel" aria-labelledby="data-sync-title">
      <header className="data-sync-heading">
        <div>
          <small>{x('dataSync.eyebrow')}</small>
          <h3 id="data-sync-title">{x('dataSync.title')}</h3>
          <p>{x('dataSync.description')}</p>
        </div>
        <Cloud size={24} aria-hidden="true" />
      </header>

      <div className="data-sync-provider-tabs" role="tablist" aria-label={x('dataSync.services')}>
        {providers.map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={provider === item.id}
            className={provider === item.id ? 'active' : ''}
            key={item.id}
            onClick={() => {
              setProvider(item.id);
              setComparison(undefined);
              setPreview(undefined);
              setMessage('');
            }}
          >
            {x(item.labelKey)}
            {profiles.data?.some(({ provider: configured }) => configured === item.id) && (
              <Check size={13} aria-label={x('dataSync.configured')} />
            )}
          </button>
        ))}
      </div>

      {provider === 'gitee' && <p className="data-sync-warning">{x('dataSync.giteeWarning')}</p>}

      <form
        className="surface data-sync-form"
        key={`${provider}:${current?.version ?? 0}`}
        onSubmit={save}
      >
        <div className="data-sync-form-grid">
          <label>
            {x('dataSync.profileName')}
            <input
              name="name"
              required
              maxLength={100}
              defaultValue={current?.name ?? x(providerInfo.labelKey)}
            />
          </label>
          <label>
            {x('dataSync.serviceUrl')}
            <input
              name="endpointUrl"
              required
              type="url"
              maxLength={2048}
              defaultValue={current?.endpointUrl ?? providerInfo.endpoint}
            />
          </label>
          <label>
            {provider === 'custom'
              ? x('dataSync.userId')
              : provider === 'webdav'
                ? x('dataSync.remoteFileName')
                : x('dataSync.gistId')}
            <input
              name="remoteId"
              required
              maxLength={256}
              defaultValue={current?.remoteId ?? providerInfo.remoteId}
            />
          </label>
          {provider === 'webdav' && (
            <label>
              {x('dataSync.username')}
              <input
                name="username"
                required
                maxLength={256}
                defaultValue={current?.username ?? ''}
              />
            </label>
          )}
          <label>
            {provider === 'webdav'
              ? x('dataSync.webdavPassword')
              : provider === 'custom'
                ? x('dataSync.jwtSecret')
                : x('dataSync.accessToken')}
            <input
              name="accessSecret"
              type="password"
              autoComplete="new-password"
              maxLength={131072}
              placeholder={
                current?.accessCredentialConfigured
                  ? x('dataSync.savedKeepBlank')
                  : x('dataSync.localVaultOnly')
              }
            />
          </label>
          <label className="data-sync-encryption-secret">
            {x('dataSync.encryptionPassword')}
            <input
              name="encryptionSecret"
              type="password"
              autoComplete="new-password"
              maxLength={131072}
              placeholder={
                current?.encryptionConfigured
                  ? x('dataSync.savedKeepBlank')
                  : x('dataSync.encryptionOptional')
              }
            />
          </label>
        </div>

        <label className="check data-sync-encryption-toggle">
          <input
            name="encryptionEnabled"
            type="checkbox"
            defaultChecked={current?.encryptionConfigured ?? false}
          />
          {x('dataSync.encryptBeforeUpload')}
        </label>

        <fieldset className="data-sync-categories">
          <legend>{x('dataSync.data')}</legend>
          {categories.map((category) => (
            <label key={category.id}>
              <input
                type="checkbox"
                name="category"
                value={category.id}
                defaultChecked={current?.selectedCategories.includes(category.id) ?? true}
              />
              <span>
                <strong>{x(category.labelKey)}</strong>
                <small>{x(category.descriptionKey)}</small>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="data-sync-auto-row">
          <label className="check">
            <input
              name="autoSyncEnabled"
              type="checkbox"
              defaultChecked={current?.autoSyncEnabled ?? false}
            />
            {x('dataSync.autoSync')}
          </label>
          <label>
            {x('dataSync.every')}
            <input
              name="autoSyncIntervalMinutes"
              type="number"
              min={1}
              max={1440}
              defaultValue={current?.autoSyncIntervalMinutes ?? 5}
            />
            {x('dataSync.minutes')}
          </label>
          <label>
            {x('dataSync.direction')}
            <select name="autoSyncDirection" defaultValue={current?.autoSyncDirection ?? 'upload'}>
              <option value="upload">{x('dataSync.upload')}</option>
              <option value="download">{x('dataSync.downloadForReview')}</option>
            </select>
          </label>
        </div>

        <div className="data-sync-actions">
          <button className="primary" disabled={!!busy}>
            {busy === 'save' ? x('dataSync.saving') : x('dataSync.saveProfile')}
          </button>
          {current && (
            <>
              <button
                type="button"
                disabled={!!busy}
                onClick={() =>
                  void run('test', async () => {
                    const result = await client.testSyncProfile(current.id);
                    setMessage(
                      result.remoteExists ? x('dataSync.testFound') : x('dataSync.testEmpty'),
                    );
                  })
                }
              >
                <RefreshCw size={14} />
                {x('dataSync.test')}
              </button>
              <button
                type="button"
                disabled={!!busy}
                onClick={() =>
                  void run('compare', async () => {
                    setComparison(await client.compareSyncProfile(current.id));
                    setMessage(x('dataSync.comparisonUpdated'));
                  })
                }
              >
                {x('dataSync.compare')}
              </button>
              <button
                type="button"
                disabled={!!busy}
                onClick={() =>
                  void run('upload', async () => {
                    await client.runDataSync(current.id, 'upload');
                    setComparison(undefined);
                    setMessage(x('dataSync.uploaded'));
                  })
                }
              >
                <Upload size={14} />
                {x('dataSync.upload')}
              </button>
              <button
                type="button"
                disabled={!!busy}
                onClick={() =>
                  void run('download', async () => {
                    const result = await client.runDataSync(current.id, 'download');
                    setPreview(result.preview ?? undefined);
                    setMessage(x('dataSync.downloadedForReview'));
                  })
                }
              >
                <Download size={14} />
                {x('dataSync.download')}
              </button>
              {!!busy && ['test', 'compare', 'upload', 'download'].includes(busy) && (
                <button
                  type="button"
                  onClick={() => {
                    setMessage(x('dataSync.canceling'));
                    void client.cancelDataSyncRun(current.id).catch((error) => {
                      setMessage(messageOf(error, x));
                    });
                  }}
                >
                  {x('dataSync.cancelCurrent')}
                </button>
              )}
              <button
                type="button"
                className="danger"
                disabled={!!busy}
                onClick={() => void remove()}
              >
                <Trash2 size={14} />
                {x('dataSync.delete')}
              </button>
            </>
          )}
        </div>
      </form>

      {current && (
        <div className="surface data-sync-status" aria-live="polite">
          <span className={`sync-state state-${current.state}`}>
            {stateLabel(current.state, x)}
          </span>
          <span>
            {x('dataSync.lastSync', {
              value: current.lastSyncAt
                ? new Date(current.lastSyncAt).toLocaleString(language)
                : x('dataSync.never'),
            })}
          </span>
          <span>
            {x('dataSync.remoteRevision', {
              value: current.remoteRevision
                ? shorten(current.remoteRevision)
                : x('dataSync.unknown'),
            })}
          </span>
          {current.lastErrorCode && <span className="error">{current.lastErrorCode}</span>}
        </div>
      )}

      {comparison && (
        <section
          className="surface data-sync-comparison"
          aria-label={x('dataSync.comparisonResults')}
        >
          <header>
            <strong>{x('dataSync.dataComparison')}</strong>
            <small>
              {comparison.deviceName ?? x('dataSync.unknownDevice')} ·{' '}
              {new Date(comparison.checkedAt).toLocaleString(language)}
            </small>
          </header>
          <div className="data-sync-compare-table">
            <div className="head">
              <span>{x('dataSync.category')}</span>
              <span>{x('dataSync.local')}</span>
              <span>{x('dataSync.remote')}</span>
              <span>{x('dataSync.status')}</span>
            </div>
            {comparison.categories.map((item) => (
              <div key={item.category}>
                <span>{categoryLabel(item.category, x)}</span>
                <span>{item.localCount}</span>
                <span>{item.remoteCount}</span>
                <span className={`compare-${item.state}`}>{comparisonLabel(item.state, x)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {reviewedPreview && current && (
        <section className="surface data-sync-preview" aria-label={x('dataSync.downloadPreview')}>
          <header>
            <div>
              <strong>{x('dataSync.downloadPreview')}</strong>
              <small>
                {x('dataSync.previewSummary', {
                  source: reviewedPreview.sourceName,
                  create: reviewedPreview.counts.create,
                  unchanged: reviewedPreview.counts.unchanged,
                  skip: reviewedPreview.counts.skip,
                })}
              </small>
            </div>
          </header>
          <div className="data-sync-preview-list">
            {reviewedPreview.entries.slice(0, 80).map((entry) => (
              <div key={entry.key}>
                <span>{entry.name}</span>
                <small>
                  {entry.action === 'create'
                    ? x('dataSync.willApply')
                    : entry.action === 'unchanged'
                      ? x('dataSync.unchanged')
                      : x('dataSync.skip')}
                </small>
              </div>
            ))}
          </div>
          <div className="data-sync-actions">
            <button
              className="primary"
              type="button"
              disabled={!!busy}
              onClick={() => void commitPreview()}
            >
              {x('dataSync.confirmApply')}
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() =>
                void run('cancel', async () => {
                  await client.cancelDataSyncDownload(current.id);
                  setPreview(undefined);
                  queryClient.removeQueries({ queryKey: ['sync-download-preview', current.id] });
                  setMessage(x('dataSync.previewDiscarded'));
                })
              }
            >
              {x('common.cancel')}
            </button>
          </div>
        </section>
      )}

      {message && (
        <p className="data-sync-message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

function categoryLabel(category: SyncCategory, x: ReturnType<typeof useI18n>['x']) {
  const key = categories.find(({ id }) => id === category)?.labelKey;
  return key ? x(key) : category;
}

function stateLabel(state: SyncProfile['state'], x: ReturnType<typeof useI18n>['x']) {
  return (
    {
      idle: x('dataSync.stateIdle'),
      checking: x('dataSync.stateChecking'),
      uploading: x('dataSync.stateUploading'),
      'download-preview': x('dataSync.stateDownloadPreview'),
      failed: x('dataSync.stateFailed'),
    } as const
  )[state];
}

function comparisonLabel(
  state: SyncComparison['categories'][number]['state'],
  x: ReturnType<typeof useI18n>['x'],
) {
  return (
    {
      equal: x('dataSync.compareEqual'),
      'local-only': x('dataSync.compareLocalOnly'),
      'remote-only': x('dataSync.compareRemoteOnly'),
      different: x('dataSync.compareDifferent'),
    } as const
  )[state];
}

function shorten(value: string) {
  return value.length > 28 ? `${value.slice(0, 25)}…` : value;
}

function messageOf(value: unknown, x: ReturnType<typeof useI18n>['x']) {
  return value instanceof Error ? value.message : x('dataSync.operationFailed');
}
