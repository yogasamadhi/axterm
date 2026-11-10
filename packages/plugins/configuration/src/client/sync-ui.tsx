import { syncFailurePresentation } from './sync-errors.ts';
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale, TranslateNS } from '@axterm/ui';
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
} from '@axterm/ui/controls';
import { RemoteError, remoteErrorOf } from '@axterm/plugin-api';
import {
  syncProfileInputSchema,
  syncProfilePatchSchema,
  type SyncCategory,
  type SyncComparison,
  type SyncProfile,
  type SyncProviderType,
  type SyncOperation,
} from '@axterm/plugin-api/configuration-sync';
import type { CredentialSubmission } from '@axterm/plugin-api/saved-credentials';
import { Check, Cloud, Download, RefreshCw, Trash2, Upload } from 'lucide-react';
import type { SyncModel } from './sync.ts';
import type { SavedCredentialsModel } from './credentials.ts';
import dictionaries from './sync-presentation-locales.json' with { type: 'json' };
import styles from './sync-presentation.module.css';
type SyncKey = keyof typeof dictionaries.en;
type Translate = TranslateNS<'syncPresentation'>;
declare module '@axterm/ui' {
  interface LocaleNamespaceMap {
    syncPresentation: SyncKey;
  }
}
const cx = (value: string) =>
  value
    .split(/\s+/u)
    .filter(Boolean)
    .map((name) => name + ' ' + (styles[name] ?? ''))
    .join(' ');
class SyncFormError extends Error {
  constructor(readonly key: SyncKey) {
    super('SYNC_FORM');
  }
}
const providers: Array<{
  id: SyncProviderType;
  labelKey: SyncKey;
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
  labelKey: SyncKey;
  descriptionKey: SyncKey;
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

export function SyncPanel({
  ctx,
  model,
  credentials,
  t,
}: {
  ctx: Context;
  model: SyncModel;
  credentials: SavedCredentialsModel;
  t: PropsLocale<'configuration'>['t'];
}) {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot),
    saved = useSyncExternalStore(credentials.subscribe, credentials.getSnapshot);
  const language = useSyncExternalStore(ctx.locale.subscribe, ctx.locale.getSnapshot).active,
    x = ctx.locale.bind('syncPresentation');
  const [provider, setProvider] = useState<SyncProviderType>('github'),
    [busy, setBusy] = useState(''),
    [message, setMessageState] = useState(''),
    [showGistRecovery, setShowGistRecovery] = useState(false);
  const [showComparison, setShowComparison] = useState(false),
    [showPreview, setShowPreview] = useState(true),
    [deleting, setDeleting] = useState<string>();
  const [pending, setPending] = useState<string>(),
    [, changed] = useState(0);
  const [mutationPending, setMutationPending] = useState(false),
    [credentialPending, setCredentialPending] = useState(false);
  const active = useRef(false),
    alive = useRef(true),
    lifetime = useRef(new AbortController());
  const mutation = useRef<{
    generation: string;
    provider: SyncProviderType;
    apply(): Promise<unknown>;
  }>();
  const credential = useRef<{
    submission: CredentialSubmission;
    provider: SyncProviderType;
    kind: 'syncAccessToken' | 'syncEncryptionPassword';
  }>();
  const drafts = useRef(new Map<string, { generation: string; ref: string }>());
  const profiles = state.status === 'ready' ? state.baseline.profiles : [],
    current = profiles.find(
      (item) => item.provider === provider && item.format === 'axterm-sync-v1',
    );
  const providerInfo = providers.find((item) => item.id === provider)!;
  const ready =
    state.status === 'ready' &&
    saved.status === 'ready' &&
    state.baseline.generation === saved.baseline.generation;
  const comparison =
    showComparison &&
    state.status === 'ready' &&
    state.outcome &&
    state.outcome.receipt.profileId === current?.id &&
    state.outcome.result?.operation === 'compare'
      ? state.outcome.result.value
      : undefined;
  const reviewedAxtermPreview =
    showPreview &&
    state.status === 'ready' &&
    state.preview?.previewId === current?.pendingPreviewId
      ? state.preview
      : undefined;
  useEffect(() => {
    alive.current = true;
    const operation = new AbortController();
    lifetime.current = operation;
    return () => {
      alive.current = false;
      operation.abort();
    };
  }, []);
  const observedGeneration = state.status === 'ready' ? state.baseline.generation : undefined;
  useEffect(() => {
    if (!observedGeneration) return;
    for (const [key, value] of drafts.current)
      if (value.generation !== observedGeneration) drafts.current.delete(key);
  }, [observedGeneration]);
  function clearMutation() {
    mutation.current = undefined;
    if (alive.current) setMutationPending(false);
  }
  function clearCredential() {
    credential.current = undefined;
    if (alive.current) setCredentialPending(false);
  }
  function generation() {
    lifetime.current.signal.throwIfAborted();
    const latest = model.getSnapshot();
    if (latest.status !== 'ready') throw Error('SYNC_UNAVAILABLE');
    return latest.baseline.generation;
  }
  function setMessage(value: string) {
    if (alive.current) {
      setShowGistRecovery(false);
      setMessageState(value);
    }
  }
  function setSyncError(error: unknown) {
    if (!alive.current) return;
    const presentation = syncFailurePresentation(error);
    setShowGistRecovery(presentation.showGistRecovery);
    setMessageState(error instanceof SyncFormError ? x(error.key) : x(presentation.key));
  }

  useEffect(() => {
    if (!ready || busy || !current?.pendingPreviewId || reviewedAxtermPreview) return;
    let active = true;
    void model.preview(current.id).catch((error) => {
      if (!active || !alive.current) return;
      const presentation = syncFailurePresentation(error);
      setShowGistRecovery(presentation.showGistRecovery);
      setMessageState(
        ctx.locale.bind('syncPresentation')(
          error instanceof SyncFormError ? error.key : presentation.key,
        ),
      );
    });
    return () => {
      active = false;
    };
  }, [ready, busy, current?.id, current?.pendingPreviewId, reviewedAxtermPreview, model, ctx]);

  async function run(kind: string, operation: () => Promise<unknown>) {
    if (active.current || !ready) return;
    active.current = true;
    setBusy(kind);
    setMessage('');
    try {
      await operation();
    } catch (error) {
      setSyncError(error);
    } finally {
      active.current = false;
      if (alive.current) setBusy('');
    }
  }
  async function applyMutation() {
    const captured = mutation.current;
    if (!captured || generation() !== captured.generation) throw Error('SYNC_GENERATION_RETIRED');
    try {
      await captured.apply();
      if (generation() !== captured.generation) throw Error('SYNC_GENERATION_RETIRED');
      if (mutation.current === captured) clearMutation();
      drafts.current.delete(captured.provider + ':syncAccessToken');
      drafts.current.delete(captured.provider + ':syncEncryptionPassword');
    } catch (error) {
      const marked = remoteErrorOf(error);
      if (
        marked?.code === 'configuration/sync-failure' &&
        [
          'invalid-input',
          'stale-generation',
          'not-found',
          'conflict',
          'capacity',
          'not-configured',
        ].includes(marked.details?.reason ?? '')
      )
        clearMutation();
      throw error;
    } finally {
      if (alive.current) changed((value) => value + 1);
    }
  }
  function draft(kind: 'syncAccessToken' | 'syncEncryptionPassword') {
    const captured = drafts.current.get(provider + ':' + kind);
    return captured?.generation === generation() ? captured.ref : undefined;
  }
  function acceptCredential(receipt: Awaited<CredentialSubmission['result']>) {
    const captured = credential.current;
    if (
      !captured ||
      receipt.commandId !== captured.submission.commandId ||
      receipt.generation !== captured.submission.generation ||
      generation() !== receipt.generation
    )
      throw Error('SYNC_CREDENTIAL_RETIRED');
    if (receipt.status !== 'completed') {
      if (receipt.status === 'failed' || receipt.status === 'expired') clearCredential();
      throw Error('SYNC_CREDENTIAL_NOT_CONFIRMED');
    }
    drafts.current.set(captured.provider + ':' + captured.kind, {
      generation: receipt.generation,
      ref: receipt.ref,
    });
    clearCredential();
    if (alive.current) changed((value) => value + 1);
    return receipt.ref;
  }
  async function storeCredential(
    kind: 'syncAccessToken' | 'syncEncryptionPassword',
    secret: string,
    form: HTMLFormElement,
    field: string,
  ) {
    if (credential.current) throw Error('SYNC_CREDENTIAL_PENDING');
    const submission = credentials.create({
      kind,
      label: x(
        kind === 'syncAccessToken'
          ? 'dataSync.accessCredentialLabel'
          : 'dataSync.encryptionCredentialLabel',
        { provider: x(providerInfo.labelKey) },
      ),
      secret,
    });
    credential.current = { submission, provider, kind };
    if (alive.current) setCredentialPending(true);
    const input = form.elements.namedItem(field);
    if (input instanceof HTMLInputElement) input.value = '';
    try {
      return acceptCredential(await submission.result);
    } finally {
      if (alive.current) changed((value) => value + 1);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.current || credential.current) return;
    const formElement = event.currentTarget;
    await run('save', async () => {
      const form = new FormData(formElement),
        selectedCategories = categories
          .filter(({ id }) => form.getAll('category').includes(id))
          .map(({ id }) => id);
      if (!selectedCategories.length) throw new SyncFormError('dataSync.selectCategory');
      const accessSecret = String(form.get('accessSecret') ?? ''),
        encryptionSecret = String(form.get('encryptionSecret') ?? ''),
        encryptionEnabled = form.get('encryptionEnabled') === 'on';
      if (!current?.accessCredentialConfigured && !accessSecret && !draft('syncAccessToken'))
        throw new SyncFormError(
          provider === 'webdav' ? 'dataSync.enterWebdavPassword' : 'dataSync.enterAccessSecret',
        );
      if (
        encryptionEnabled &&
        !current?.encryptionConfigured &&
        !encryptionSecret &&
        !draft('syncEncryptionPassword')
      )
        throw new SyncFormError('dataSync.encryptionPasswordRequired');
      const accessRef = accessSecret
        ? await storeCredential('syncAccessToken', accessSecret, formElement, 'accessSecret')
        : draft('syncAccessToken');
      const encryptionRef =
        encryptionEnabled && encryptionSecret
          ? await storeCredential(
              'syncEncryptionPassword',
              encryptionSecret,
              formElement,
              'encryptionSecret',
            )
          : draft('syncEncryptionPassword');
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
      const key = crypto.randomUUID(),
        capturedGeneration = generation();
      if (current) {
        const input = syncProfilePatchSchema.parse({
          ...common,
          ...(accessRef ? { accessCredentialRef: accessRef } : {}),
          ...(encryptionEnabled && encryptionRef ? { encryptionCredentialRef: encryptionRef } : {}),
          ...(!encryptionEnabled && current.encryptionConfigured
            ? { clearEncryptionCredential: true }
            : {}),
        });
        mutation.current = {
          generation: capturedGeneration,
          provider,
          apply: () => model.update(current.id, input, current.version, key, capturedGeneration),
        };
      } else {
        const input = syncProfileInputSchema.parse({
          provider,
          ...common,
          accessCredentialRef: accessRef!,
          encryptionCredentialRef: encryptionEnabled ? (encryptionRef ?? null) : null,
        });
        mutation.current = {
          generation: capturedGeneration,
          provider,
          apply: () => model.create(input, key, capturedGeneration),
        };
      }
      if (alive.current) setMutationPending(true);
      await applyMutation();
      drafts.current.delete(provider + ':syncAccessToken');
      drafts.current.delete(provider + ':syncEncryptionPassword');
      if (alive.current) {
        formElement.reset();
        setShowComparison(false);
        setShowPreview(false);
        setMessage(x('dataSync.savedLocally'));
      }
    });
  }
  async function execute(profile: SyncProfile, operation: SyncOperation, grantId?: string) {
    const capturedGeneration = generation();
    const command = model.run(profile.id, operation, grantId);
    setPending(command.commandId);
    const outcome = await command.result;
    if (generation() !== capturedGeneration || outcome.receipt.generation !== capturedGeneration)
      throw Error('SYNC_GENERATION_RETIRED');
    if (outcome.receipt.status !== 'completed' || !outcome.result) {
      if (outcome.receipt.status === 'failed' || outcome.receipt.status === 'expired')
        setPending(undefined);
      throw new RemoteError('configuration/sync-failure', 'The sync action was not confirmed', {
        reason: outcome.receipt.reason ?? 'uncertain',
      });
    }
    if (operation === 'download-preview') await model.preview(profile.id);
    if (alive.current) setPending(undefined);
    return outcome.result;
  }
  async function remove() {
    if (current) setDeleting(current.id);
  }
  async function confirmRemove() {
    if (!current || current.id !== deleting || mutation.current) return;
    const key = crypto.randomUUID(),
      capturedGeneration = generation();
    mutation.current = {
      generation: capturedGeneration,
      provider,
      apply: () => model.remove(current.id, current.version, key, capturedGeneration),
    };
    if (alive.current) setMutationPending(true);
    await applyMutation();
    if (alive.current) setDeleting(undefined);
    setMessage(x('dataSync.deleted'));
  }
  async function backupRemote() {
    if (!current) return;
    await run('backup', async () => {
      const files = ctx.get('fileGrantActions');
      if (!files) throw Error('SYNC_FILE_SELECTION_UNAVAILABLE');
      const grant = await files.create({ kind: 'save-file' }, lifetime.current.signal);
      if (!grant) return;
      try {
        const result = await execute(current, 'backup', grant.grantId);
        if (result.operation !== 'backup') throw Error('SYNC_RESULT_INVALID');
        setMessage(
          x('dataSync.backupComplete', { bytes: result.value.bytes, sha256: result.value.sha256 }),
        );
      } finally {
        await files.revoke(grant.grantId);
      }
    });
  }
  const commit = useRef<{ id: string; previewId: string; commandId: string; generation: string }>();
  async function commitAxtermPreview() {
    if (!current || !reviewedAxtermPreview) return;
    await run('commit', async () => {
      commit.current ??= {
        id: current.id,
        previewId: reviewedAxtermPreview.previewId,
        commandId: crypto.randomUUID(),
        generation: generation(),
      };
      if (
        commit.current.id !== current.id ||
        commit.current.previewId !== reviewedAxtermPreview.previewId ||
        commit.current.generation !== generation()
      )
        throw Error('SYNC_PREVIEW_RETIRED');
      await model.commit(commit.current.id, commit.current.previewId, commit.current.commandId);
      commit.current = undefined;
      setShowPreview(false);
      setShowComparison(false);
      setMessage(x('dataSync.previewCommitted'));
    });
  }
  return (
    <Tabs
      value={provider}
      onValueChange={(value) => {
        setProvider(value as SyncProviderType);
        setShowComparison(false);
        setShowPreview(true);
        setMessage('');
      }}
      asChild
    >
      <section className={cx('data-sync-panel')} aria-labelledby="data-sync-title">
        <header className={cx('data-sync-heading')}>
          <div>
            <small>{x('dataSync.eyebrow')}</small>
            <h2 id="data-sync-title">{x('dataSync.title')}</h2>
            <p>{x('dataSync.description')}</p>
          </div>
          <Cloud size={24} aria-hidden="true" />
        </header>

        {!ready && (
          <div role="alert">
            <p>{t('syncUnavailable')}</p>
            <Button
              disabled={!!busy}
              onClick={() => {
                void Promise.all([model.retry(), credentials.retry()]).catch(setSyncError);
              }}
            >
              {t('syncReload')}
            </Button>
          </div>
        )}
        <TabsList className={cx('data-sync-provider-tabs')} aria-label={x('dataSync.services')}>
          {providers.map((item) => (
            <TabsTrigger
              key={item.id}
              value={item.id}
              className={cx(provider === item.id ? 'active' : '')}
            >
              {x(item.labelKey)}
              {profiles.some(({ provider: configured }) => configured === item.id) && (
                <Check size={13} aria-label={x('dataSync.configured')} />
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={provider} className={cx('provider-body')}>
          {provider === 'gitee' && (
            <p className={cx('data-sync-warning')}>{x('dataSync.giteeWarning')}</p>
          )}

          <form
            className={cx('surface data-sync-form')}
            key={`${provider}:${current?.version ?? 0}`}
            onSubmit={save}
          >
            <div className={cx('data-sync-form-grid')}>
              <label>
                {x('dataSync.profileName')}
                <input
                  disabled={!ready || !!busy || mutationPending || credentialPending}
                  name="name"
                  required
                  maxLength={100}
                  defaultValue={current?.name ?? x(providerInfo.labelKey)}
                />
              </label>
              <label>
                {x('dataSync.serviceUrl')}
                <input
                  disabled={!ready || !!busy || mutationPending || credentialPending}
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
                  disabled={!ready || !!busy || mutationPending || credentialPending}
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
                    disabled={!ready || !!busy || mutationPending || credentialPending}
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
                  disabled={!ready || !!busy || mutationPending || credentialPending}
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
              <label className={cx('data-sync-encryption-secret')}>
                {x('dataSync.encryptionPassword')}
                <input
                  disabled={!ready || !!busy || mutationPending || credentialPending}
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

            <label className={cx('check data-sync-encryption-toggle')}>
              <input
                disabled={!ready || !!busy || mutationPending || credentialPending}
                name="encryptionEnabled"
                type="checkbox"
                defaultChecked={current?.encryptionConfigured ?? false}
              />
              {x('dataSync.encryptBeforeUpload')}
            </label>

            <fieldset className={cx('data-sync-categories')}>
              <legend>{x('dataSync.data')}</legend>
              {categories.map((category) => (
                <label key={category.id}>
                  <input
                    disabled={!ready || !!busy || mutationPending || credentialPending}
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

            <div className={cx('data-sync-auto-row')}>
              <label className={cx('check')}>
                <input
                  disabled={!ready || !!busy || mutationPending || credentialPending}
                  name="autoSyncEnabled"
                  type="checkbox"
                  defaultChecked={current?.autoSyncEnabled ?? false}
                />
                {x('dataSync.autoSync')}
              </label>
              <label>
                {x('dataSync.every')}
                <input
                  disabled={!ready || !!busy || mutationPending || credentialPending}
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
                <select
                  disabled={!ready || !!busy || mutationPending || credentialPending}
                  name="autoSyncDirection"
                  defaultValue={current?.autoSyncDirection ?? 'upload'}
                >
                  <option value="upload">{x('dataSync.upload')}</option>
                  <option value="download">{x('dataSync.downloadForReview')}</option>
                </select>
              </label>
            </div>

            <div className={cx('data-sync-actions')}>
              <button
                className={cx('primary')}
                disabled={!ready || !!busy || mutationPending || credentialPending}
              >
                {busy === 'save' ? x('dataSync.saving') : x('dataSync.saveProfile')}
              </button>
              {current && (
                <>
                  <button
                    type="button"
                    disabled={!ready || !!busy || mutationPending || credentialPending}
                    onClick={() =>
                      void run('test', async () => {
                        const outcome = await execute(current, 'test');
                        if (outcome.operation !== 'test') throw Error('SYNC_RESULT_INVALID');
                        const result = outcome.value;
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
                    disabled={!ready || !!busy || mutationPending || credentialPending}
                    onClick={() =>
                      void run('compare', async () => {
                        await execute(current, 'compare');
                        setShowComparison(true);
                        setMessage(x('dataSync.comparisonUpdated'));
                      })
                    }
                  >
                    {x('dataSync.compare')}
                  </button>
                  <button
                    type="button"
                    disabled={!ready || !!busy || mutationPending || credentialPending}
                    onClick={() =>
                      void run('upload', async () => {
                        await execute(current, 'upload');
                        setShowComparison(false);
                        setMessage(x('dataSync.uploaded'));
                      })
                    }
                  >
                    <Upload size={14} />
                    {x('dataSync.upload')}
                  </button>
                  <button
                    type="button"
                    disabled={!ready || !!busy || mutationPending || credentialPending}
                    onClick={() =>
                      void run('download', async () => {
                        await execute(current, 'download-preview');
                        setShowPreview(true);
                        setMessage(x('dataSync.downloadedForReview'));
                      })
                    }
                  >
                    <Download size={14} />
                    {x('dataSync.download')}
                  </button>
                  <button
                    type="button"
                    disabled={!ready || !!busy || mutationPending || credentialPending}
                    onClick={() => void backupRemote()}
                  >
                    <Download size={14} />
                    {x('dataSync.backupRemote')}
                  </button>
                  {!!busy && ['test', 'compare', 'upload', 'download', 'backup'].includes(busy) && (
                    <button
                      type="button"
                      onClick={() => {
                        setMessage(x('dataSync.canceling'));
                        const commandId =
                          pending ??
                          (state.status === 'ready'
                            ? state.baseline.runs.find(
                                (run) =>
                                  run.profileId === current.id &&
                                  (run.status === 'queued' || run.status === 'running'),
                              )?.commandId
                            : undefined);
                        if (!commandId) return;
                        void model.cancel(commandId).catch((error) => {
                          setSyncError(error);
                        });
                      }}
                    >
                      {x('dataSync.cancelCurrent')}
                    </button>
                  )}
                  <button
                    type="button"
                    className={cx('danger')}
                    disabled={!ready || !!busy || mutationPending || credentialPending}
                    onClick={() => void remove()}
                  >
                    <Trash2 size={14} />
                    {x('dataSync.delete')}
                  </button>
                </>
              )}
            </div>
            {current && <p className={cx('data-sync-warning')}>{x('dataSync.backupPrivacy')}</p>}
          </form>

          {current && (
            <div className={cx('surface data-sync-status')} aria-live="polite">
              <span className={cx(`sync-state state-${current.state}`)}>
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
              {current.lastErrorCode && (
                <span className={cx('error')}>{current.lastErrorCode}</span>
              )}
            </div>
          )}

          {comparison && (
            <section
              className={cx('surface data-sync-comparison')}
              aria-label={x('dataSync.comparisonResults')}
            >
              <header>
                <strong>{x('dataSync.dataComparison')}</strong>
                <small>
                  {comparison.deviceName ?? x('dataSync.unknownDevice')} ·{' '}
                  {new Date(comparison.checkedAt).toLocaleString(language)}
                </small>
              </header>
              <div className={cx('data-sync-compare-table')}>
                <div className={cx('head')}>
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
                    <span className={cx(`compare-${item.state}`)}>
                      {comparisonLabel(item.state, x)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {reviewedAxtermPreview && current && (
            <section
              className={cx('surface data-sync-preview')}
              aria-label={x('dataSync.downloadPreview')}
            >
              <header>
                <div>
                  <strong>{x('dataSync.downloadPreview')}</strong>
                  <small>
                    {x('axtermConfig.importSummary', {
                      create: reviewedAxtermPreview.counts.create,
                      unchanged: reviewedAxtermPreview.counts.unchanged,
                      conflict: reviewedAxtermPreview.counts.conflict,
                      skipped: reviewedAxtermPreview.counts.skipped,
                    })}
                  </small>
                </div>
              </header>
              <div className={cx('data-sync-preview-list data-sync-axterm-preview')}>
                <div>
                  <span>{x('axtermConfig.items')}</span>
                  <small>{reviewedAxtermPreview.entityCount}</small>
                </div>
                <div>
                  <span>{x('axtermConfig.settingsWillApply')}</span>
                  <small>
                    {reviewedAxtermPreview.settings === 'will-apply'
                      ? x('dataSync.willApply')
                      : x('axtermConfig.preserved')}
                  </small>
                </div>
                {reviewedAxtermPreview.issueCount > 0 && (
                  <div>
                    <span>{x('axtermConfig.issues')}</span>
                    <small>{reviewedAxtermPreview.issueCount}</small>
                  </div>
                )}
              </div>
              {!reviewedAxtermPreview.canCommit && (
                <p className={cx('data-sync-warning')}>{x('axtermConfig.cannotImport')}</p>
              )}
              <div className={cx('data-sync-actions')}>
                <button
                  className={cx('primary')}
                  type="button"
                  disabled={!!busy || !reviewedAxtermPreview.canCommit}
                  onClick={() => void commitAxtermPreview()}
                >
                  {x('dataSync.confirmApply')}
                </button>
                <button
                  type="button"
                  disabled={!ready || !!busy || mutationPending || credentialPending}
                  onClick={() =>
                    void run('cancel', async () => {
                      await model.cancelDownload(current.id);
                      setShowPreview(false);
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
            <div className={cx('data-sync-message')} role="status">
              <p>{message}</p>
              {showGistRecovery && (
                <details className={cx('data-sync-gist-recovery')}>
                  <summary>{x('dataSync.gistRecoveryTitle')}</summary>
                  <ol>
                    <li>{x('dataSync.gistRecoveryStepOpen')}</li>
                    <li>{x('dataSync.gistRecoveryStepClone')}</li>
                    <li>{x('dataSync.gistRecoveryStepBackup')}</li>
                    <li>{x('dataSync.gistRecoveryStepVerify')}</li>
                  </ol>
                </details>
              )}
            </div>
          )}

          {deleting && current?.id === deleting && (
            <Dialog
              open
              onOpenChange={(open) => {
                if (!open && !busy) setDeleting(undefined);
              }}
            >
              <DialogContent aria-describedby={undefined}>
                <DialogTitle>{t('syncConfirmDelete')}</DialogTitle>
                <p>{x('dataSync.deleteConfirm', { name: current.name })}</p>
                <Button disabled={!!busy} onClick={() => void run('delete', confirmRemove)}>
                  {t('syncConfirmDelete')}
                </Button>
                <Button disabled={!!busy} onClick={() => setDeleting(undefined)}>
                  {t('syncCancel')}
                </Button>
              </DialogContent>
            </Dialog>
          )}
          {!busy && credentialPending && (
            <div role="alert" data-sync-credential-pending="">
              <p>{t('credentialUncertain')}</p>
              <Button
                disabled={!!busy}
                data-sync-credential-outcome=""
                onClick={() =>
                  void run('credential-outcome', async () => {
                    const captured = credential.current;
                    if (!captured || captured.submission.generation !== generation())
                      throw Error('SYNC_CREDENTIAL_RETIRED');
                    acceptCredential(await credentials.outcome(captured.submission.commandId));
                  })
                }
              >
                {t('credentialOutcome')}
              </Button>
            </div>
          )}
          {!busy && mutationPending && (
            <div role="alert" data-sync-mutation-pending="">
              <p>{t('syncFailed')}</p>
              <Button
                disabled={!!busy}
                data-sync-retry-original=""
                onClick={() => void run('retry-original', applyMutation)}
              >
                {t('syncRetryOriginal')}
              </Button>
            </div>
          )}
          {pending && (
            <div role="status">
              <Button
                disabled={!!busy}
                onClick={() =>
                  void run('outcome', async () => {
                    const outcome = await model.outcome(pending);
                    if (
                      outcome.receipt.status === 'completed' ||
                      outcome.receipt.status === 'failed' ||
                      outcome.receipt.status === 'expired'
                    )
                      setPending(undefined);
                  })
                }
              >
                {t('syncOutcome')}
              </Button>
              <Button onClick={() => void model.cancel(pending).catch(setSyncError)}>
                {t('syncStop')}
              </Button>
            </div>
          )}
          {state.status === 'ready' && state.baseline.runs.length > 0 && (
            <details>
              <summary>{t('syncRuns')}</summary>
              {state.baseline.runs.slice(0, 50).map((receipt) => (
                <div key={receipt.commandId}>
                  <span>
                    {receipt.operation} · {receipt.status}
                  </span>
                  <Button
                    disabled={!!busy}
                    onClick={() => void run('outcome', () => model.outcome(receipt.commandId))}
                  >
                    {t('syncOutcome')}
                  </Button>
                </div>
              ))}
            </details>
          )}
        </TabsContent>
      </section>
    </Tabs>
  );
}
function categoryLabel(category: SyncCategory, x: Translate) {
  const key = categories.find(({ id }) => id === category)?.labelKey;
  return key ? x(key) : category;
}

function stateLabel(state: SyncProfile['state'], x: Translate) {
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

function comparisonLabel(state: SyncComparison['categories'][number]['state'], x: Translate) {
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
