import { useQuery } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type {
  AiApproval,
  AiContextPreviewInput,
  AiMode,
  AiProviderProtocol,
  AiToolCall,
} from '@workspace/contracts';
import { DEFAULT_AI_ROLE } from '@workspace/contracts';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  History,
  KeyRound,
  LoaderCircle,
  Paperclip,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useI18n } from '../../i18n/context';
import type { AxtermMessageKey } from '../../i18n/core';
import { useWorkspace } from '../../stores/workspace';
import { aiGeneratedCode, aiTerminalInsertion } from '../ai-generated-command';
import { formatBytes } from '../ui/format';
import { ErrorBanner, PanelFrame } from '../ui/panel-scaffold';
import { useAiAttachments } from './use-ai-attachments';
import { useAiContextReview } from './use-ai-context-review';
import { AiContextReview } from './ai-context-review';
import type { TerminalAiDraft } from './use-terminal-ai-actions';
import { importPiModels } from './pi-configuration';
import { AiPromptInput } from './ai-prompt-input';
import { parseAiSkillPrompt } from './ai-skills';
import { useAiRunStream } from './use-ai-run-stream';

type Client = ReturnType<typeof createRuntimeClient>;
type Translator = ReturnType<typeof useI18n>['x'];
class AiInputError extends Error {}

function safeAiMessage(cause: unknown, x: Translator): string {
  return cause instanceof AiInputError ? cause.message : x('common.operationFailed');
}

export function AiPanel({
  client,
  activeTerminalId,
  requestedDraft,
  onDraftConsumed,
  embedded = false,
  workspaceTitle,
}: {
  client: Client;
  activeTerminalId: string | undefined;
  requestedDraft?: TerminalAiDraft | undefined;
  onDraftConsumed?(): void;
  embedded?: boolean;
  workspaceTitle?: string;
}) {
  const { x, language } = useI18n();
  const providers = useQuery({ queryKey: ['ai-providers'], queryFn: client.aiProviders });
  const workspace = useQuery({
    queryKey: ['ai-workspace', activeTerminalId],
    enabled: !!activeTerminalId,
    queryFn: ({ signal }) => client.aiWorkspace(activeTerminalId!, signal),
    refetchInterval: 2_000,
    retry: false,
  });
  const catalog = useQuery({
    queryKey: ['ai-pi-catalog'],
    queryFn: client.aiCatalog,
    staleTime: Infinity,
  });
  const models = useQuery({ queryKey: ['ai-models'], queryFn: client.aiModels });
  const skills = useQuery({
    queryKey: ['ai-skills'],
    queryFn: client.aiSkills,
    staleTime: Infinity,
  });
  const runs = useQuery({ queryKey: ['ai-runs'], queryFn: client.aiRuns, refetchInterval: 1200 });
  const conversations = useQuery({
    queryKey: ['ai-conversations'],
    queryFn: client.aiConversations,
    refetchInterval: 2_500,
    retry: false,
  });
  const approvals = useQuery({
    queryKey: ['ai-approvals'],
    queryFn: client.aiApprovals,
    refetchInterval: 1200,
  });
  const toolCalls = useQuery({
    queryKey: [
      'ai-tool-calls',
      [
        ...new Set([
          ...(runs.data ?? []).map(({ id }) => id),
          ...(approvals.data ?? []).map(({ runId }) => runId),
        ]),
      ]
        .sort()
        .join(',') ?? '',
    ],
    enabled: !!runs.data?.length || !!approvals.data?.length,
    refetchInterval: 1_200,
    queryFn: async () =>
      (
        await Promise.all(
          [
            ...new Set([
              ...(runs.data ?? []).map(({ id }) => id),
              ...(approvals.data ?? []).map(({ runId }) => runId),
            ]),
          ]
            .slice(-100)
            .map((runId) => client.aiToolCalls(runId)),
        )
      ).flat(),
  });
  const insertTerminal = useWorkspace((state) => state.insertTerminal);
  const [setup, setSetup] = useState(false);
  const offeredSetupRef = useRef(false);
  const [error, setError] = useState('');
  const [providerProtocol, setProviderProtocol] = useState<AiProviderProtocol>('openai-chat');
  const [piProviderId, setPiProviderId] = useState('');
  const selectedPiProvider = catalog.data?.find(({ id }) => id === piProviderId);
  const [providerStatus, setProviderStatus] = useState<Record<string, string>>({});
  const [currentConversationId, setCurrentConversationId] = useState<string | null | undefined>(
    () =>
      conversations.isSuccess
        ? (conversations.data.find((item) => item.terminalId === activeTerminalId)?.id ?? null)
        : undefined,
  );
  const [showConversationHistory, setShowConversationHistory] = useState(!embedded);
  const [deleteConversationId, setDeleteConversationId] = useState<string | null>(null);
  const [chatActionStatus, setChatActionStatus] = useState<Record<string, string>>({});
  const [promptDraft, setPromptDraft] = useState('');
  const [mode, setMode] = useState<AiMode>('chat');
  const [draftUseCase, setDraftUseCase] = useState<AiContextPreviewInput['useCase'] | undefined>();
  const [draftModelId, setDraftModelId] = useState<string | undefined>();
  const [includeHistory, setIncludeHistory] = useState(true);
  const attachmentDrafts = useAiAttachments(client);
  const contextReview = useAiContextReview(client, activeTerminalId);
  const acceptedDraft = useRef<string | undefined>(undefined);
  const lastTarget = useRef(activeTerminalId);
  useLayoutEffect(() => {
    if (lastTarget.current === activeTerminalId) return;
    lastTarget.current = activeTerminalId;
    attachmentDrafts.reset();
    setCurrentConversationId(undefined);
    setPromptDraft('');
    setMode('chat');
    setDraftUseCase(undefined);
    setDraftModelId(undefined);
  }, [activeTerminalId, attachmentDrafts]);
  const {
    attachments,
    busy: attachmentBusy,
    previewId: previewAttachmentId,
    setPreviewId: setPreviewAttachmentId,
    choose: chooseAttachment,
    remove: removeAttachment,
    dragOver: attachmentDragOver,
    setDragOver: setAttachmentDragOver,
    importDropped: importDroppedAttachments,
  } = attachmentDrafts;
  useEffect(() => {
    if (!requestedDraft || acceptedDraft.current === requestedDraft.nonce) return;
    acceptedDraft.current = requestedDraft.nonce;
    attachmentDrafts.reset();
    contextReview.dismiss();
    setCurrentConversationId(null);
    setPromptDraft(requestedDraft.prompt);
    setMode('chat');
    setDraftUseCase('explainOutput');
    setDraftModelId(requestedDraft.modelId);
    setIncludeHistory(false);
    onDraftConsumed?.();
  }, [requestedDraft, onDraftConsumed, attachmentDrafts, contextReview]);
  const conversation = useQuery({
    queryKey: ['ai-conversation', currentConversationId],
    enabled: typeof currentConversationId === 'string',
    queryFn: () => client.aiConversation(currentConversationId!),
    refetchInterval: 1_200,
  });
  useEffect(() => {
    if (!conversations.isSuccess) return;
    if (currentConversationId === undefined)
      setCurrentConversationId(
        conversations.data.find((item) => item.terminalId === activeTerminalId)?.id ?? null,
      );
  }, [
    conversations.data,
    conversations.isSuccess,
    currentConversationId,
    activeTerminalId,
    embedded,
  ]);
  useEffect(() => {
    if (!providers.isSuccess || !approvals.isSuccess || offeredSetupRef.current) return;
    offeredSetupRef.current = true;
    const hasPendingApproval = approvals.data.some(({ state }) => state === 'pending');
    if (!embedded && !providers.data.length && !hasPendingApproval) setSetup(true);
  }, [approvals.data, approvals.isSuccess, providers.data, providers.isSuccess, embedded]);
  const currentConversation = conversations.data?.find(({ id }) => id === currentConversationId);
  const availableModels =
    models.data?.filter((model) =>
      providers.data?.some((provider) => provider.id === model.providerId && provider.enabled),
    ) ?? [];
  const selectedModel =
    availableModels.find(({ id }) => id === (draftModelId ?? currentConversation?.modelId)) ??
    availableModels[0];
  const activeConversationRun = runs.data?.find(
    (item) =>
      typeof currentConversationId === 'string' &&
      item.conversationId === currentConversationId &&
      ['queued', 'running', 'waiting_approval'].includes(item.state),
  );
  const pendingConversationRun =
    activeConversationRun ??
    runs.data?.find(
      (item) =>
        typeof currentConversationId === 'string' &&
        item.conversationId === currentConversationId &&
        !conversation.data?.messages.some(
          (message) => message.role === 'assistant' && message.runId === item.id,
        ),
    );
  const streamedRun = useAiRunStream(client, pendingConversationRun?.id);
  const visibleRun = streamedRun ?? pendingConversationRun;
  const messagesElement = useRef<HTMLDivElement>(null);
  const followResponse = useRef(true);
  useLayoutEffect(() => {
    const element = messagesElement.current;
    if (element && followResponse.current) element.scrollTop = element.scrollHeight;
  }, [visibleRun?.result, conversation.data?.messages.length]);
  async function configure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const createdCredentialRefs: string[] = [];
    let providerId = '';
    try {
      const piJson = String(form.get('piModelsJson') ?? '').trim();
      if (piJson) {
        try {
          await importPiModels(client, piJson, String(form.get('apiKey')), catalog.data ?? []);
        } catch {
          throw new AiInputError(x('ai.piImportFailed'));
        }
        setSetup(false);
        await Promise.all([providers.refetch(), models.refetch()]);
        return;
      }
      if (!String(form.get('apiKey')) || !String(form.get('model')))
        throw new AiInputError(x('ai.piImportFailed'));
      const credential = await client.createCredential({
        kind: 'aiApiKey',
        label: `${String(form.get('name'))} API Key`,
        secret: String(form.get('apiKey')),
      });
      createdCredentialRefs.push(credential.ref);
      const proxyUrl = String(form.get('proxyUrl') ?? '').trim();
      const proxyUsername = String(form.get('proxyUsername') ?? '').trim();
      const proxyPassword = String(form.get('proxyPassword') ?? '');
      let proxyCredentialRef: string | null = null;
      if (proxyUrl && (proxyUsername || proxyPassword)) {
        if (!proxyUsername || !proxyPassword)
          throw new AiInputError(x('ai.providerProxyPairRequired'));
        const proxyCredential = await client.createCredential({
          kind: 'proxyPassword',
          label: `${String(form.get('name'))} AI Proxy`,
          secret: proxyPassword,
        });
        proxyCredentialRef = proxyCredential.ref;
        createdCredentialRefs.push(proxyCredential.ref);
      }
      const provider = await client.createAiProvider({
        name: String(form.get('name')),
        baseUrl: String(form.get('baseUrl')),
        protocol: providerProtocol,
        apiPath: String(form.get('apiPath')),
        auth: String(form.get('auth')) as 'bearer' | 'x-api-key',
        role: String(form.get('role')),
        timeoutMs: Number(form.get('timeoutMs')),
        proxy: proxyUrl
          ? {
              url: proxyUrl,
              username: proxyUsername || null,
              credentialRef: proxyCredentialRef,
            }
          : null,
        credentialRef: credential.ref,
        enabled: true,
        ...(selectedPiProvider
          ? {
              pi: {
                id: selectedPiProvider.id,
                models: [],
                modelOverrides: {},
                headerCredentialRefs: {},
              },
            }
          : {}),
      });
      providerId = provider.id;
      await client.createAiModel({
        providerId: provider.id,
        name: String(form.get('model')),
        model: String(form.get('model')),
        capabilities: ['chat', 'tools'],
      });
      setSetup(false);
      setProviderStatus((current) => ({
        ...current,
        [provider.id]: x('ai.providerSaved'),
      }));
      await Promise.all([providers.refetch(), models.refetch()]);
    } catch (cause) {
      let releaseCredentials = !providerId;
      if (providerId) {
        const createdProvider = (await providers.refetch()).data?.find(
          ({ id }) => id === providerId,
        );
        if (createdProvider) {
          try {
            await client.deleteAiProvider(createdProvider);
            releaseCredentials = true;
          } catch {
            releaseCredentials = false;
          }
        } else releaseCredentials = true;
      }
      if (releaseCredentials)
        await Promise.allSettled(createdCredentialRefs.map((ref) => client.deleteCredential(ref)));
      setError(safeAiMessage(cause, x));
    }
  }
  async function testProvider(providerId: string) {
    setProviderStatus((current) => ({ ...current, [providerId]: x('ai.providerTesting') }));
    try {
      const result = await client.testAiProvider(providerId);
      setProviderStatus((current) => ({
        ...current,
        [providerId]: x('ai.providerTestPassed', {
          latency: result.latencyMs,
          models: result.models.length,
        }),
      }));
    } catch (cause) {
      setProviderStatus((current) => ({
        ...current,
        [providerId]: x('ai.providerTestFailed', { message: safeAiMessage(cause, x) }),
      }));
    }
  }
  async function toggleProvider(providerId: string) {
    const provider = providers.data?.find(({ id }) => id === providerId);
    if (!provider) return;
    try {
      await client.updateAiProvider(provider, { enabled: !provider.enabled });
      await providers.refetch();
    } catch (cause) {
      setError(safeAiMessage(cause, x));
    }
  }
  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !availableModels.length ||
      (!!activeTerminalId && (workspace.isPending || workspace.isError))
    )
      return;
    const form = new FormData(event.currentTarget);
    const parsed = parseAiSkillPrompt(String(form.get('prompt')), skills.data ?? []);
    const useCase = parsed.skill?.useCase ?? draftUseCase ?? 'chat';
    const prompt = parsed.prompt.trim();
    if (!prompt && !attachmentDrafts.current().length) return;
    if (parsed.skill) {
      setDraftUseCase(parsed.skill.useCase);
      setPromptDraft(parsed.prompt);
    }
    if (useCase === 'chat' && !attachmentDrafts.current().length) {
      const modelId = String(form.get('modelId'));
      await contextReview.sendDirect(
        async (signal) => {
          let conversationId = currentConversationId;
          if (!conversationId) {
            const created = await client.createAiConversation({
              name: x('ai.newChat'),
              modelId,
              useCase,
              ...(activeTerminalId ? { terminalId: activeTerminalId } : {}),
            });
            if (!signal.aborted) setCurrentConversationId(created.id);
            conversationId = created.id;
          }
          return {
            modelId,
            mode,
            useCase,
            prompt,
            context: '',
            conversationId,
            includeConversationHistory: includeHistory,
            ...(activeTerminalId ? { terminalId: activeTerminalId } : {}),
          };
        },
        async () => {
          setPromptDraft('');
          await Promise.all([runs.refetch(), conversations.refetch(), conversation.refetch()]);
        },
      );
      return;
    }
    await contextReview.prepare(async (signal, current) => {
      const pendingAttachments = attachmentDrafts.current();
      const modelId = String(form.get('modelId'));
      const request: AiContextPreviewInput = {
        modelId,
        mode,
        useCase,
        prompt,
        context: '',
        attachmentIds: pendingAttachments.map(({ id }) => id),
        includeConversationHistory: includeHistory,
        ...(activeTerminalId ? { terminalId: activeTerminalId } : {}),
      };
      if (!currentConversationId) {
        const safe = await client.previewAiContext(request, signal);
        if (!current()) return safe.request;
        const created = await client.createAiConversation({
          name:
            safe.prompt.replace(/\s+/gu, ' ').slice(0, 120) ||
            x('ai.attachmentConversation', { name: pendingAttachments[0]!.name }),
          modelId,
          useCase,
          ...(activeTerminalId ? { terminalId: activeTerminalId } : {}),
        });
        if (current()) {
          setCurrentConversationId(created.id);
          setPromptDraft(safe.prompt);
        }
        return { ...safe.request, conversationId: created.id };
      }
      return { ...request, conversationId: currentConversationId };
    });
  }
  async function sendReviewed() {
    await contextReview.send(async (_run, reviewed) => {
      attachmentDrafts.consume(reviewed.request.attachmentIds);
      setPromptDraft('');
      await Promise.all([runs.refetch(), conversations.refetch(), conversation.refetch()]);
    });
  }
  function selectConversation(id: string | null) {
    contextReview.dismiss();
    attachmentDrafts.reset();
    setPromptDraft('');
    setMode('chat');
    setDraftUseCase(undefined);
    setDraftModelId(undefined);
    setIncludeHistory(true);
    setCurrentConversationId(id);
  }
  async function removeConversation(id: string) {
    try {
      const latest = (await conversations.refetch()).data?.find((item) => item.id === id);
      if (!latest) return;
      await client.deleteAiConversation(latest);
      setDeleteConversationId(null);
      if (currentConversationId === id) selectConversation(null);
      await Promise.all([conversations.refetch(), runs.refetch()]);
    } catch (cause) {
      setError(safeAiMessage(cause, x));
    }
  }
  async function copyGeneratedCode(runId: string, value: string) {
    const code = aiGeneratedCode(value);
    if (!code) {
      setChatActionStatus((current) => ({ ...current, [runId]: x('ai.codeTooLarge') }));
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      setChatActionStatus((current) => ({ ...current, [runId]: x('ai.codeCopied') }));
    } catch {
      setChatActionStatus((current) => ({ ...current, [runId]: x('ai.codeCopyFailed') }));
    }
  }
  function insertGeneratedCode(runId: string, value: string) {
    const code = aiTerminalInsertion(value);
    if (!code || !activeTerminalId) {
      setChatActionStatus((current) => ({
        ...current,
        [runId]: code ? x('ai.noActiveTerminal') : x('ai.codeTooLarge'),
      }));
      return;
    }
    insertTerminal(activeTerminalId, code);
    setChatActionStatus((current) => ({ ...current, [runId]: x('ai.codeInserted') }));
  }
  return (
    <AiPanelFrame
      embedded={embedded}
      eyebrow={x('panels.aiInspector')}
      title={x('panels.aiAssistant')}
      description={x('panels.aiDescription')}
      action={
        <button onClick={() => setSetup(!setup)}>
          <KeyRound size={13} /> {x('panels.provider')}
        </button>
      }
    >
      <div className="ai-workspace-context">
        <strong>{workspaceTitle ?? x('app.currentContext')}</strong>
        <span>
          {x('ai.workspace')}:{' '}
          <code>{workspace.data?.workspaceDirectory ?? x('app.noTerminalSelected')}</code>
        </span>
        {workspace.data && (
          <small>
            {workspace.data.execution === 'ssh' ? x('ai.executionSsh') : x('ai.executionLocal')}
            {workspace.data.commandDirectory ? ` · ${workspace.data.commandDirectory}` : ''}
          </small>
        )}
        {workspace.isError && <small role="alert">{x('ai.workspaceUnavailable')}</small>}
      </div>
      {!setup && Object.values(providerStatus).at(-1) && (
        <p className="ai-provider-notice" role="status">
          {Object.values(providerStatus).at(-1)}
        </p>
      )}
      {(error || attachmentDrafts.error || contextReview.error) && (
        <ErrorBanner text={error || attachmentDrafts.error || contextReview.error} />
      )}
      {contextReview.preview && (
        <AiContextReview
          preview={contextReview.preview}
          busy={contextReview.busy}
          onClose={contextReview.dismiss}
          onSend={() => void sendReviewed()}
        />
      )}
      {conversations.isError && (
        <div className="ai-history-recovery" role="alert">
          <span>{x('ai.historyLoadFailed')}</span>
          <button type="button" onClick={() => void conversations.refetch()}>
            {x('common.retry')}
          </button>
        </div>
      )}
      {setup && (
        <div
          className="ai-provider-modal"
          role="dialog"
          aria-modal="true"
          aria-label={x('ai.configTitle')}
        >
          <form
            className="setup-form surface ai-provider-form"
            onSubmit={(event) => void configure(event)}
          >
            <header className="ai-provider-modal-header">
              <strong>{x('ai.configTitle')}</strong>
              <button type="button" aria-label={x('panels.cancel')} onClick={() => setSetup(false)}>
                <X size={15} />
              </button>
            </header>
            <label className="full-field">
              {x('ai.piProvider')}
              <select
                aria-label={x('ai.piProvider')}
                value={piProviderId}
                onChange={(event) => {
                  const id = event.currentTarget.value;
                  setPiProviderId(id);
                  const api = catalog.data?.find((item) => item.id === id)?.models[0]?.api;
                  setProviderProtocol(
                    api === 'anthropic-messages'
                      ? 'anthropic'
                      : api === 'openai-responses'
                        ? 'openai-responses'
                        : 'openai-chat',
                  );
                }}
              >
                <option value="">{x('ai.piCustom')}</option>
                {catalog.data
                  ?.filter(({ apiKeyAvailable }) => apiKeyAvailable)
                  .map(({ id, name }) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              {x('panels.name')}
              <input
                name="name"
                key={`name-${piProviderId}`}
                defaultValue={selectedPiProvider?.name ?? 'OpenAI Compatible'}
                required
              />
            </label>
            <label>
              {x('ai.providerProtocol')}
              <select
                name="protocol"
                value={providerProtocol}
                onChange={(event) =>
                  setProviderProtocol(event.currentTarget.value as AiProviderProtocol)
                }
              >
                <option value="openai-chat">{x('ai.protocolOpenAiChat')}</option>
                <option value="openai-responses">{x('ai.protocolOpenAiResponses')}</option>
                <option value="anthropic">{x('ai.protocolAnthropic')}</option>
              </select>
            </label>
            <label>
              {x('panels.baseUrl')}
              <input
                name="baseUrl"
                key={`url-${piProviderId}`}
                defaultValue={selectedPiProvider?.baseUrl ?? 'https://api.openai.com/v1/'}
                required
              />
            </label>
            <label>
              {x('ai.apiPath')}
              <input
                name="apiPath"
                key={providerProtocol}
                defaultValue={
                  providerProtocol === 'anthropic'
                    ? '/messages'
                    : providerProtocol === 'openai-responses'
                      ? '/responses'
                      : '/chat/completions'
                }
                required
              />
            </label>
            <label>
              {x('panels.model')}
              <input
                name="model"
                key={`model-${piProviderId}`}
                defaultValue={selectedPiProvider?.models[0]?.id ?? ''}
                list="pi-model-catalog"
                placeholder="gpt-4.1-mini"
              />
              <datalist id="pi-model-catalog">
                {selectedPiProvider?.models.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name ?? id}
                  </option>
                ))}
              </datalist>
            </label>
            <label>
              {x('ai.authMethod')}
              <select
                name="auth"
                key={`${providerProtocol}-auth`}
                defaultValue={providerProtocol === 'anthropic' ? 'x-api-key' : 'bearer'}
              >
                <option value="bearer">{x('ai.authBearer')}</option>
                <option value="x-api-key">{x('ai.authApiKey')}</option>
              </select>
            </label>
            <label>
              {x('panels.apiKey')}
              <input name="apiKey" type="password" autoComplete="off" />
            </label>
            <label>
              {x('ai.timeout')}
              <input
                name="timeoutMs"
                type="number"
                min="1000"
                max="300000"
                defaultValue="60000"
                required
              />
            </label>
            <label className="full-field">
              {x('ai.systemRole')}
              <textarea name="role" defaultValue={DEFAULT_AI_ROLE} rows={3} required />
            </label>
            <label className="full-field">
              {x('ai.piModelsJson')}
              <textarea
                name="piModelsJson"
                rows={4}
                maxLength={262144}
                autoComplete="off"
                placeholder={
                  '{"providers":{"ollama":{"baseUrl":"http://localhost:11434/v1","api":"openai-completions","apiKey":"ollama","models":[{"id":"qwen2.5-coder:7b"}]}}}'
                }
              />
            </label>
            <p className="full-field">{x('ai.piConfigHelp')}</p>
            <label className="full-field">
              {x('ai.proxyUrl')}
              <input name="proxyUrl" placeholder="socks5://127.0.0.1:1080" />
            </label>
            <label>
              {x('ai.proxyUsername')}
              <input name="proxyUsername" autoComplete="off" />
            </label>
            <label>
              {x('ai.proxyPassword')}
              <input name="proxyPassword" type="password" autoComplete="off" />
            </label>
            <button className="primary">
              <Save size={13} /> {x('panels.saveConfiguration')}
            </button>
            {!!providers.data?.length && (
              <section className="full-field ai-provider-grid" aria-label={x('ai.savedProviders')}>
                {providers.data.map((provider) => (
                  <article className="surface ai-provider-card" key={provider.id}>
                    <div>
                      <strong>{provider.name}</strong>
                      <span>{provider.protocol}</span>
                      <small>
                        {provider.baseUrl} · {provider.apiPath}
                      </small>
                    </div>
                    <span className={`run-state ${provider.enabled ? 'succeeded' : 'canceled'}`}>
                      {provider.enabled ? x('ai.enabled') : x('ai.disabled')}
                    </span>
                    <button
                      type="button"
                      onClick={() => void testProvider(provider.id)}
                      disabled={!provider.enabled}
                    >
                      <RefreshCw size={13} /> {x('ai.testConnection')}
                    </button>
                    <button type="button" onClick={() => void toggleProvider(provider.id)}>
                      {provider.enabled ? x('ai.disable') : x('ai.enable')}
                    </button>
                    {providerStatus[provider.id] && (
                      <p role="status">{providerStatus[provider.id]}</p>
                    )}
                  </article>
                ))}
              </section>
            )}
          </form>
        </div>
      )}

      <section
        className={`ai-chat-workspace${showConversationHistory ? '' : ' history-hidden'}`}
        aria-label={x('ai.chatWorkspace')}
      >
        {showConversationHistory && (
          <aside className="surface ai-chat-sessions">
            <div className="ai-chat-sessions-toolbar">
              <strong>{x('ai.chatHistory')}</strong>
            </div>
            <div className="ai-chat-session-list">
              {!conversations.isError && !conversations.data?.length && (
                <div className="ai-chat-empty compact">
                  <Bot size={22} />
                  <span>{x('ai.noChatHistory')}</span>
                </div>
              )}
              {!conversations.isError &&
                conversations.data?.map((item) => (
                  <article
                    key={item.id}
                    className={`ai-chat-session${item.id === currentConversationId ? ' active' : ''}`}
                  >
                    <button
                      type="button"
                      className="ai-chat-session-select"
                      onClick={() => selectConversation(item.id)}
                    >
                      <strong>{item.name}</strong>
                      <span>
                        {x('ai.messageCount', { count: item.messageCount })} ·{' '}
                        {new Date(item.lastMessageAt ?? item.updatedAt).toLocaleString(language)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="danger-icon"
                      aria-label={x('ai.deleteChatNamed', { name: item.name })}
                      onClick={() => setDeleteConversationId(item.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </article>
                ))}
            </div>
          </aside>
        )}
        <div className="surface ai-chat-main">
          <header className="ai-chat-header">
            <div>
              <strong>{currentConversation?.name ?? x('ai.newChat')}</strong>
              <span>
                {currentConversation
                  ? (models.data?.find(({ id }) => id === currentConversation.modelId)?.name ??
                    x('ai.savedModel'))
                  : x('ai.newChatHint')}
              </span>
            </div>
            <button
              type="button"
              aria-label={x('ai.newChat')}
              title={x('ai.newChat')}
              onClick={() => {
                selectConversation(null);
                setShowConversationHistory(false);
              }}
            >
              <Plus size={13} />
            </button>
            <button
              type="button"
              aria-pressed={showConversationHistory}
              onClick={() => setShowConversationHistory((shown) => !shown)}
            >
              <History size={13} /> {x('ai.history')}
            </button>
          </header>
          {deleteConversationId && (
            <div className="ai-chat-delete-confirm" role="alertdialog" aria-modal="true">
              <span>{x('ai.deleteChatConfirm')}</span>
              <button type="button" onClick={() => setDeleteConversationId(null)}>
                {x('panels.cancel')}
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => void removeConversation(deleteConversationId)}
              >
                {x('ai.deleteChat')}
              </button>
            </div>
          )}
          <div
            className="ai-chat-messages"
            aria-live="polite"
            tabIndex={0}
            ref={messagesElement}
            onScroll={(event) => {
              const element = event.currentTarget;
              followResponse.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 48;
            }}
          >
            {!conversations.isError &&
              !conversation.data?.messages.length &&
              !activeConversationRun && (
                <div className="ai-chat-empty">
                  <span className="ai-chat-empty-mark">
                    <WandSparkles size={22} />
                  </span>
                  <strong>{x('ai.emptyConversation')}</strong>
                  <p>{x('ai.emptyConversationHint')}</p>
                </div>
              )}
            {conversation.data?.messages.map((message) => {
              const messageRun = runs.data?.find(({ id }) => id === message.runId);
              return (
                <article className={`ai-chat-message ${message.role}`} key={message.id}>
                  <div className="ai-chat-message-meta">
                    <strong>
                      {message.role === 'user' ? x('ai.you') : x('panels.aiAssistant')}
                    </strong>
                    <span>{new Date(message.createdAt).toLocaleString(language)}</span>
                  </div>
                  {!!message.attachments.length && (
                    <div className="ai-message-attachments" aria-label={x('ai.sentAttachments')}>
                      {message.attachments.map((attachment) => (
                        <span key={`${attachment.name}-${attachment.size}`}>
                          <Paperclip size={10} />
                          {attachment.name}
                          <small>{formatBytes(attachment.size)}</small>
                          {attachment.truncated && <em>{x('ai.truncated')}</em>}
                        </span>
                      ))}
                    </div>
                  )}
                  {(message.content || !message.attachments.length) && (
                    <p>{message.content || x('ai.emptyResponse')}</p>
                  )}
                  {message.errorCode && <small>{message.errorCode}</small>}
                  {message.role === 'assistant' &&
                    messageRun?.useCase === 'generateCommand' &&
                    message.content && (
                      <div className="ai-chat-code-actions">
                        <button
                          type="button"
                          onClick={() => void copyGeneratedCode(message.runId, message.content)}
                        >
                          <Copy size={12} /> {x('ai.copyCode')}
                        </button>
                        <button
                          type="button"
                          disabled={!activeTerminalId || !aiTerminalInsertion(message.content)}
                          onClick={() => insertGeneratedCode(message.runId, message.content)}
                        >
                          <TerminalIcon size={12} /> {x('panels.insertIntoTerminal')}
                        </button>
                        {chatActionStatus[message.runId] && (
                          <span role="status">{chatActionStatus[message.runId]}</span>
                        )}
                      </div>
                    )}
                </article>
              );
            })}
            {visibleRun &&
              !conversation.data?.messages.some(
                (message) => message.role === 'assistant' && message.runId === visibleRun.id,
              ) && (
                <article
                  className="ai-chat-message assistant pending"
                  data-run-id={visibleRun.id}
                  aria-busy={['queued', 'running'].includes(visibleRun.state)}
                >
                  <div className="ai-chat-message-meta">
                    <strong>{x('panels.aiAssistant')}</strong>
                    <span className={`run-state ${visibleRun.state}`}>
                      {visibleRun.state === 'waiting_approval'
                        ? x('ai.waitingApproval')
                        : x('ai.thinking')}
                    </span>
                  </div>
                  <p>{visibleRun.result || x('ai.generatingResponse')}</p>
                  {activeConversationRun && (
                    <button
                      type="button"
                      onClick={() =>
                        void client.cancelAi(activeConversationRun.id).then(async () => {
                          await Promise.all([
                            runs.refetch(),
                            conversations.refetch(),
                            conversation.refetch(),
                          ]);
                        })
                      }
                    >
                      <Square size={11} /> {x('panels.cancel')}
                    </button>
                  )}
                </article>
              )}
          </div>
          <form
            className={`ai-chat-composer${attachmentDragOver ? ' attachment-dragover' : ''}`}
            key={currentConversationId ?? 'new'}
            onSubmit={(event) => void run(event)}
            onDragEnter={(event) => {
              if (!event.dataTransfer.types.includes('Files')) return;
              event.preventDefault();
              setAttachmentDragOver(true);
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes('Files')) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                setAttachmentDragOver(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              void importDroppedAttachments(event.dataTransfer.files);
            }}
          >
            <div className="ai-chat-options">
              <label className="ai-model-choice">
                <span>{x('panels.model')}</span>
                <span className="ai-model-select">
                  <select
                    name="modelId"
                    value={selectedModel?.id ?? ''}
                    onChange={(event) => {
                      contextReview.dismiss();
                      setDraftModelId(event.currentTarget.value);
                    }}
                    required
                  >
                    {availableModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                  <span className="ai-model-select-value" aria-hidden="true">
                    {selectedModel?.name}
                  </span>
                  <ChevronDown size={14} aria-hidden="true" />
                </span>
              </label>
              <label>
                <span>{x('ai.mode')}</span>
                <select
                  name="mode"
                  value={mode}
                  onChange={(event) => {
                    contextReview.dismiss();
                    setMode(event.currentTarget.value as AiMode);
                  }}
                >
                  <option value="chat">{x('ai.chatMode')}</option>
                  <option value="work">{x('ai.workMode')}</option>
                </select>
              </label>
              <button
                type="button"
                className="ai-attachment-button"
                onClick={() => void chooseAttachment()}
                disabled={attachmentBusy || contextReview.busy || attachments.length >= 8}
              >
                {attachmentBusy ? (
                  <LoaderCircle className="spin" size={12} />
                ) : (
                  <Paperclip size={12} />
                )}
                {x('ai.attachTextFile')}
              </button>
              {attachmentBusy && (
                <button
                  type="button"
                  className="ai-attachment-cancel"
                  onClick={attachmentDrafts.cancel}
                >
                  <Square size={10} /> {x('panels.cancel')}
                </button>
              )}
              <label className="ai-history-choice">
                <input
                  type="checkbox"
                  checked={includeHistory}
                  onChange={(event) => setIncludeHistory(event.currentTarget.checked)}
                />
                <span>{x('ai.reviewIncludeHistory')}</span>
              </label>
              {contextReview.busy && (
                <button type="button" onClick={contextReview.dismiss}>
                  {x('panels.cancel')}
                </button>
              )}
            </div>
            {!!attachments.length && (
              <div className="ai-attachment-drafts" aria-label={x('ai.pendingAttachments')}>
                {attachments.map((attachment) => (
                  <span
                    key={attachment.id}
                    className={previewAttachmentId === attachment.id ? 'active' : ''}
                  >
                    <button type="button" onClick={() => setPreviewAttachmentId(attachment.id)}>
                      <Paperclip size={10} />
                      <strong>{attachment.name}</strong>
                      <small>{formatBytes(attachment.size)}</small>
                      {attachment.truncated && <em>{x('ai.truncated')}</em>}
                      {attachment.redacted && <em>{x('ai.redacted')}</em>}
                    </button>
                    <button
                      type="button"
                      aria-label={x('ai.removeAttachmentNamed', { name: attachment.name })}
                      onClick={() => void removeAttachment(attachment.id)}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {previewAttachmentId && (
              <div className="ai-attachment-preview">
                <header>
                  <strong>{x('ai.attachmentPreview')}</strong>
                  <span>{x('ai.attachmentPreviewHint')}</span>
                </header>
                <pre>{attachments.find(({ id }) => id === previewAttachmentId)?.preview ?? ''}</pre>
              </div>
            )}
            <AiPromptInput
              prompt={promptDraft}
              skills={skills.data ?? []}
              selectedSkill={skills.data?.find((skill) => skill.useCase === draftUseCase)}
              onPromptChange={setPromptDraft}
              onSkillChange={(skill) => {
                contextReview.dismiss();
                setDraftUseCase(skill?.useCase);
              }}
              disabled={currentConversationId === undefined}
              sendDisabled={
                currentConversationId === undefined ||
                !availableModels.length ||
                (!!activeTerminalId && (workspace.isPending || workspace.isError)) ||
                contextReview.busy ||
                attachmentBusy ||
                !!activeConversationRun ||
                (!promptDraft.trim() && !attachments.length)
              }
            />
            <small>{attachmentDragOver ? x('ai.dropAttachmentHere') : x('ai.sendHint')}</small>
          </form>
        </div>
      </section>
      <AgentToolCards
        approvals={approvals.data ?? []}
        toolCalls={(toolCalls.data ?? []).filter(
          (call) => !embedded || call.target === activeTerminalId,
        )}
        decide={async (approval, decision) => {
          try {
            await client.decideApproval(approval.id, decision, approval.argsHash);
            await Promise.all([approvals.refetch(), runs.refetch(), toolCalls.refetch()]);
          } catch (cause) {
            setError(safeAiMessage(cause, x));
            await Promise.all([approvals.refetch(), runs.refetch(), toolCalls.refetch()]);
          }
        }}
        cancel={async (runId) => {
          try {
            await client.cancelAi(runId);
            await Promise.all([approvals.refetch(), runs.refetch(), toolCalls.refetch()]);
          } catch (cause) {
            setError(safeAiMessage(cause, x));
          }
        }}
      />
    </AiPanelFrame>
  );
}

function AiPanelFrame({
  embedded,
  children,
  ...props
}: {
  embedded: boolean;
  children: ReactNode;
  eyebrow: string;
  title: string;
  description: string;
  action: ReactNode;
}) {
  return embedded ? (
    <div className="ai-panel-embedded">
      <div className="ai-embedded-toolbar">{props.action}</div>
      {children}
    </div>
  ) : (
    <PanelFrame {...props}>{children}</PanelFrame>
  );
}

function AgentToolCards({
  approvals,
  toolCalls,
  decide,
  cancel,
}: {
  approvals: AiApproval[];
  toolCalls: AiToolCall[];
  decide(approval: AiApproval, decision: 'approve_once' | 'reject'): Promise<unknown>;
  cancel(runId: string): Promise<unknown>;
}) {
  const { x } = useI18n();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  async function runAction(callId: string, action: () => Promise<unknown>) {
    if (busy[callId]) return;
    setExpanded((current) => ({ ...current, [callId]: true }));
    setBusy((current) => ({ ...current, [callId]: true }));
    try {
      await action();
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[callId];
        return next;
      });
    }
  }
  if (!toolCalls.length) return null;
  return (
    <section className="agent-tool-list" aria-label={x('ai.agentActivity')}>
      <header>
        <div>
          <Bot size={16} />
          <span>
            <strong>{x('ai.agentActivity')}</strong>
            <small>{x('ai.agentActivityHint')}</small>
          </span>
        </div>
        <span>{x('ai.toolCount', { count: toolCalls.length })}</span>
      </header>
      {[...toolCalls].reverse().map((call) => {
        const approval = approvals.find((item) => item.toolCallId === call.id);
        const isExpanded =
          expanded[call.id] ?? ['running', 'waiting_approval'].includes(call.state);
        const active = ['proposed', 'running'].includes(call.state);
        return (
          <article
            aria-busy={busy[call.id] || undefined}
            className={`agent-tool-card state-${call.state}`}
            key={call.id}
          >
            <button
              aria-expanded={isExpanded}
              className="agent-tool-card-header"
              type="button"
              onClick={() => setExpanded((current) => ({ ...current, [call.id]: !isExpanded }))}
            >
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <TerminalIcon size={15} />
              <span>
                <strong>{call.toolName}</strong>
                <small>{call.target}</small>
              </span>
              <em className={`risk-${call.risk}`}>{toolRiskLabel(call.risk, x)}</em>
              <i className={`run-state ${call.state}`}>
                {['proposed', 'running'].includes(call.state) && (
                  <LoaderCircle className="spin" size={11} />
                )}
                {call.state === 'succeeded' && <Check size={11} />}
                {['failed', 'canceled'].includes(call.state) && <X size={11} />}
                {toolStateLabel(call.state, x)}
              </i>
            </button>
            {isExpanded && (
              <div className="agent-tool-card-detail">
                <section>
                  <strong>{x('ai.arguments')}</strong>
                  <pre tabIndex={0}>{JSON.stringify(call.args, null, 2)}</pre>
                </section>
                <dl>
                  <div>
                    <dt>{x('ai.target')}</dt>
                    <dd>{call.target}</dd>
                  </div>
                  <div>
                    <dt>{x('ai.argumentsHash')}</dt>
                    <dd>{call.argsHash}</dd>
                  </div>
                  {approval && (
                    <div>
                      <dt>{x('ai.approval')}</dt>
                      <dd>{approvalStateLabel(approval.state, x)}</dd>
                    </div>
                  )}
                </dl>
                {call.resultMetadata && (
                  <section>
                    <strong>{x('ai.result')}</strong>
                    <pre tabIndex={0}>{formatToolResult(call.resultMetadata)}</pre>
                  </section>
                )}
                {call.state === 'failed' && !call.resultMetadata && (
                  <p className="agent-tool-error">{x('ai.toolFailed')}</p>
                )}
                {approval?.state === 'pending' && (
                  <div className="agent-tool-approval">
                    <span>
                      <ShieldAlert size={14} />
                      {x('panels.expiresAt', {
                        time: new Date(approval.expiresAt).toLocaleTimeString(),
                      })}
                    </span>
                    <button
                      type="button"
                      disabled={busy[call.id]}
                      onClick={() => void runAction(call.id, () => decide(approval, 'reject'))}
                    >
                      {x('panels.reject')}
                    </button>
                    <button
                      className="danger"
                      type="button"
                      disabled={busy[call.id]}
                      onClick={() =>
                        void runAction(call.id, () => decide(approval, 'approve_once'))
                      }
                    >
                      {x('panels.runOnce')}
                    </button>
                  </div>
                )}
                {active && (
                  <div className="agent-tool-approval">
                    <span>{x('ai.cancelHint')}</span>
                    <button
                      type="button"
                      disabled={busy[call.id]}
                      onClick={() => void runAction(call.id, () => cancel(call.runId))}
                    >
                      <Square size={11} /> {x('panels.cancel')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}

function formatToolResult(value: Record<string, unknown>): string {
  const output = typeof value.output === 'string' ? value.output : undefined;
  return (output ?? JSON.stringify(value, null, 2)).slice(0, 65_536);
}

function toolStateLabel(state: AiToolCall['state'], x: Translator) {
  const labels: Record<AiToolCall['state'], AxtermMessageKey> = {
    proposed: 'ai.toolProposed',
    waiting_approval: 'ai.toolWaitingApproval',
    running: 'ai.toolRunning',
    succeeded: 'ai.toolSucceeded',
    failed: 'ai.toolFailedState',
    canceled: 'ai.toolCanceled',
  };
  return x(labels[state]);
}

function toolRiskLabel(risk: AiToolCall['risk'], x: Translator) {
  const labels: Record<AiToolCall['risk'], AxtermMessageKey> = {
    read_only: 'ai.riskReadOnly',
    mutating: 'ai.riskMutating',
    destructive: 'ai.riskDestructive',
    privileged: 'ai.riskPrivileged',
  };
  return x(labels[risk]);
}

function approvalStateLabel(state: AiApproval['state'], x: Translator) {
  const labels: Record<AiApproval['state'], AxtermMessageKey> = {
    pending: 'ai.approvalPending',
    approved: 'ai.approvalApproved',
    rejected: 'ai.approvalRejected',
    expired: 'ai.approvalExpired',
  };
  return x(labels[state]);
}
