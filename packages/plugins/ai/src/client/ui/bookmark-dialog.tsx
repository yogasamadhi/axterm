import { useState, useSyncExternalStore, type FormEvent } from 'react';
import type { AiBookmarkDraft, BookmarkTree } from '@axterm/plugin-api/catalog';
import { DEFAULT_SSH_CONNECTION_OPTIONS, DEFAULT_SSH_STARTUP } from '@axterm/plugin-api/catalog';
import {
  Bot,
  ListChecks,
  Save,
  WandSparkles,
  ShieldAlert,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react';
import type { AiBookmarkFlow } from './bookmark-flow.ts';
import { parseAiBookmarkDraft } from './bookmark-draft.ts';
import { useI18n } from './i18n.tsx';
import { Modal, ErrorBanner } from './panel-scaffold.tsx';
import { cx } from './styles.ts';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@axterm/ui/controls';
export function AiBookmarkDialog({
  flow,
  bookmarkTree,
  defaultGroupId,
  onClose,
  onSaved,
}: {
  flow: AiBookmarkFlow;
  bookmarkTree: BookmarkTree;
  defaultGroupId: string | null;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const { x } = useI18n();
  const facts = useSyncExternalStore(flow.model.subscribe, flow.model.getSnapshot);
  const models = facts.status === 'ready' ? facts.baseline.models : [];
  const [uncertain, setUncertain] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [modelId, setModelId] = useState('');
  const [draft, setDraft] = useState<AiBookmarkDraft>();
  const [groupId, setGroupId] = useState(defaultGroupId ?? '');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const selectedModelId = modelId || models[0]?.id || '';

  function close() {
    onClose();
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedModelId || !prompt.trim() || generating) return;
    setGenerating(true);
    setError('');
    try {
      setDraft(
        await flow.generate({
          modelId: selectedModelId,
          prompt: prompt.trim(),
        }),
      );
    } catch {
      setError(x('aiBookmark.generationFailed'));
    } finally {
      setGenerating(false);
    }
  }

  function updateDraft<K extends keyof AiBookmarkDraft>(key: K, value: AiBookmarkDraft[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || saving) return;
    setSaving(true);
    setError('');
    try {
      const reviewed = parseAiBookmarkDraft(JSON.stringify(draft));
      await flow.save({
        host: {
          name: reviewed.name,
          hostname: reviewed.hostname,
          port: reviewed.port,
          username: reviewed.username,
          authType: reviewed.authType,
          credentialRef: null,
          passphraseCredentialRef: null,
          certificateCredentialRef: null,
          jumpHostId: null,
          jumpHostIds: [],
          favorite: reviewed.favorite,
          proxy: { mode: 'inherit' },
          connectionOptions: {
            ...DEFAULT_SSH_CONNECTION_OPTIONS,
            algorithms: {
              kex: [...DEFAULT_SSH_CONNECTION_OPTIONS.algorithms.kex],
              cipher: [...DEFAULT_SSH_CONNECTION_OPTIONS.algorithms.cipher],
              serverHostKey: [...DEFAULT_SSH_CONNECTION_OPTIONS.algorithms.serverHostKey],
              hmac: [...DEFAULT_SSH_CONNECTION_OPTIONS.algorithms.hmac],
            },
            reconnectPolicy: { ...DEFAULT_SSH_CONNECTION_OPTIONS.reconnectPolicy },
          },
          startup: {
            ...DEFAULT_SSH_STARTUP,
            environment: { ...DEFAULT_SSH_STARTUP.environment },
            loginScripts: [...DEFAULT_SSH_STARTUP.loginScripts],
            runScripts: [...DEFAULT_SSH_STARTUP.runScripts],
          },
          x11: { enabled: false, display: null },
          sshAgent: { enabled: true, path: null },
        },
        bookmark: {
          groupId: groupId || null,
          title: reviewed.title,
          color: null,
          description: reviewed.description,
          profileId: null,
          connectionProfileId: null,
          quickCommands: [],
          triggers: [],
        },
      });
      setUncertain(false);
      await onSaved();
    } catch {
      setUncertain(flow.saveUncertain);
      setError(x('common.operationFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal className={cx('ai-bookmark-modal')} title={x('aiBookmark.title')} onClose={close}>
      <div className={cx('ai-bookmark-progress')} aria-label={x('aiBookmark.progress')}>
        <span className={cx('complete')}>
          <Bot size={14} /> {x('aiBookmark.describeStep')}
        </span>
        <i />
        <span className={draft ? cx('complete') : ''}>
          <ListChecks size={14} /> {x('aiBookmark.reviewStep')}
        </span>
        <i />
        <span>
          <Save size={14} /> {x('aiBookmark.saveStep')}
        </span>
      </div>
      {!draft ? (
        <form className={cx('ai-bookmark-generate')} onSubmit={(event) => void generate(event)}>
          <div className={cx('ai-bookmark-hero')}>
            <span>
              <WandSparkles size={20} />
            </span>
            <div>
              <strong>{x('aiBookmark.describeTitle')}</strong>
              <p>{x('aiBookmark.describeHint')}</p>
            </div>
          </div>
          {error && <ErrorBanner text={error} />}
          <label>
            {x('aiBookmark.model')}
            <BookmarkSelect
              label={x('aiBookmark.model')}
              value={selectedModelId}
              onValueChange={setModelId}
              required
              options={[
                { value: '', label: x('aiBookmark.selectModel') },
                ...models.map((model) => ({ value: model.id, label: model.name })),
              ]}
            />
          </label>
          <label>
            {x('aiBookmark.description')}
            <textarea
              autoFocus
              data-autofocus
              maxLength={16_384}
              name="description"
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={x('aiBookmark.descriptionPlaceholder')}
              required
              rows={7}
              value={prompt}
            />
          </label>
          <p className={cx('ai-bookmark-security')}>
            <ShieldAlert size={14} /> {x('aiBookmark.noSecrets')}
          </p>
          {facts.status === 'ready' && !models.length && (
            <p className={cx('hint')}>{x('aiBookmark.noModels')}</p>
          )}
          <div className={cx('modal-actions')}>
            <button type="button" onClick={close}>
              {x('common.cancel')}
            </button>
            <button
              className={cx('primary')}
              disabled={generating || !selectedModelId || !prompt.trim()}
              type="submit"
            >
              {generating ? <LoaderCircle className={cx('spin')} size={14} /> : <Bot size={14} />}
              {generating ? x('aiBookmark.generating') : x('aiBookmark.generate')}
            </button>
          </div>
        </form>
      ) : (
        <form
          className={cx('ai-bookmark-review', 'form-grid')}
          onSubmit={(event) => void save(event)}
        >
          <div className={cx('ai-bookmark-review-heading', 'full-field')}>
            <div>
              <strong>{x('aiBookmark.reviewTitle')}</strong>
              <p>{x('aiBookmark.reviewHint')}</p>
            </div>
            <button
              type="button"
              disabled={saving || uncertain}
              onClick={() => setDraft(undefined)}
            >
              <RefreshCw size={13} /> {x('aiBookmark.regenerate')}
            </button>
          </div>
          {error && <ErrorBanner text={error} />}
          <label>
            {x('hosts.displayName')}
            <input
              maxLength={100}
              disabled={saving || uncertain}
              onChange={(event) => updateDraft('name', event.target.value)}
              required
              value={draft.name}
            />
          </label>
          <label>
            {x('hosts.bookmarkTitle')}
            <input
              maxLength={100}
              disabled={saving || uncertain}
              onChange={(event) => updateDraft('title', event.target.value)}
              required
              value={draft.title}
            />
          </label>
          <label>
            {x('hosts.address')}
            <input
              maxLength={253}
              disabled={saving || uncertain}
              onChange={(event) => updateDraft('hostname', event.target.value)}
              required
              value={draft.hostname}
            />
          </label>
          <label>
            {x('hosts.port')}
            <input
              max={65_535}
              min={1}
              disabled={saving || uncertain}
              onChange={(event) => updateDraft('port', Number(event.target.value))}
              required
              type="number"
              value={draft.port}
            />
          </label>
          <label>
            {x('hosts.username')}
            <input
              maxLength={128}
              disabled={saving || uncertain}
              onChange={(event) => updateDraft('username', event.target.value)}
              required
              value={draft.username}
            />
          </label>
          <label>
            {x('hosts.authMethod')}
            <BookmarkSelect
              label={x('hosts.authMethod')}
              disabled={saving || uncertain}
              value={draft.authType}
              onValueChange={(value) =>
                updateDraft('authType', value as AiBookmarkDraft['authType'])
              }
              options={[
                { value: 'password', label: x('hosts.password') },
                { value: 'privateKey', label: x('hosts.privateKey') },
                { value: 'keyboardInteractive', label: x('aiBookmark.keyboardInteractive') },
                { value: 'agent', label: x('hosts.authAgent') },
              ]}
            />
          </label>
          <label>
            {x('hosts.group')}
            <BookmarkSelect
              label={x('hosts.group')}
              disabled={saving || uncertain}
              value={groupId}
              onValueChange={setGroupId}
              options={[
                { value: '', label: x('hosts.uncategorized') },
                ...bookmarkTree.groups.map((group) => ({ value: group.id, label: group.name })),
              ]}
            />
          </label>
          <label className={cx('check', 'ai-bookmark-favorite')}>
            <input
              checked={draft.favorite}
              disabled={saving || uncertain}
              onChange={(event) => updateDraft('favorite', event.target.checked)}
              type="checkbox"
            />{' '}
            {x('hosts.favorite')}
          </label>
          <label className={cx('full-field')}>
            {x('hosts.descriptionField')}
            <textarea
              maxLength={2_000}
              disabled={saving || uncertain}
              onChange={(event) => updateDraft('description', event.target.value)}
              rows={3}
              value={draft.description}
            />
          </label>
          <p className={cx('ai-bookmark-security', 'full-field')}>
            <ShieldAlert size={14} /> {x('aiBookmark.credentialAfterSave')}
          </p>
          <div className={cx('modal-actions')}>
            <button type="button" onClick={close}>
              {x('common.cancel')}
            </button>
            <button className={cx('primary')} disabled={saving} type="submit">
              {saving ? <LoaderCircle className={cx('spin')} size={14} /> : <Save size={14} />}
              {saving
                ? x('aiBookmark.saving')
                : uncertain
                  ? x('aiBookmark.retrySave')
                  : x('aiBookmark.save')}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function BookmarkSelect({
  label,
  value,
  onValueChange,
  options,
  disabled = false,
  required = false,
}: {
  label: string;
  value: string;
  onValueChange(value: string): void;
  options: readonly { value: string; label: string }[];
  disabled?: boolean;
  required?: boolean;
}) {
  return (
    <Select
      value={value || '__none__'}
      onValueChange={(value) => onValueChange(value === '__none__' ? '' : value)}
      disabled={disabled}
      required={required}
    >
      <SelectTrigger className={cx('ai-bookmark-select')} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value || '__none__'}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
