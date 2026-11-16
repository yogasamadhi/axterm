import { Button, Dialog, DialogContent, DialogTitle } from '@axterm/ui/controls';
import { useAiRead } from './use-ai-read.ts';
import { useAiFacts, useSelectedRun } from './use-ai-facts.ts';
import { aiFailureMessage } from './failure-message.ts';
import { ProviderCard, type ProviderAction } from './provider-detail.tsx';
import { ProviderManagement } from './provider-management.tsx';
import { cx } from './styles.ts';
import type { AiPanelActions } from './panel-actions.ts';
import type {
  AiApproval,
  AiContextPreviewInput,
  AiMode,
  PiLoginState,
  AiToolCall,
} from '@axterm/plugin-api/ai';
import { aiWorkspaceSchema, DEFAULT_AI_ROLE, piApiSchema } from '@axterm/plugin-api/ai';
import { createPortal } from 'react-dom';
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
  Fragment,
} from 'react';
import { useI18n } from './i18n.tsx';
import type { AxtermMessageKey } from './i18n.tsx';
import { aiGeneratedCode, aiTerminalInsertion } from './generated-command.ts';
import { formatBytes } from './format.ts';
import { ErrorBanner, Modal, PanelFrame } from './panel-scaffold.tsx';
import { useAiAttachments } from './use-ai-attachments';
import { useAiContextReview } from './use-ai-context-review';
import { AiContextReview } from './ai-context-review';
import type { TerminalAiDraft } from './panel-actions.ts';
import { importPiModels, piConfigurationForModel } from './pi-configuration';
import { ProviderLogin } from './provider-login.tsx';
import { PiModelPicker } from './pi-model-picker.tsx';
import { AiPromptInput } from './ai-prompt-input';
import { parseAiSkillPrompt } from './ai-skills';

type Client = AiPanelActions;
type Translator = ReturnType<typeof useI18n>['x'];
class AiInputError extends Error {}

function safeAiMessage(cause: unknown, x: Translator): string {
  return cause instanceof AiInputError ? cause.message : aiFailureMessage(cause, x);
}

export function AiPanel({
  client,
  activeTerminalId,
  requestedDraft,
  onDraftConsumed,
  embedded = false,
  active = true,
  workspaceTitle,
  settingsOnly = false,
  terminalTabs = [],
  terminalChoice = '',
  onTerminalChange,
}: {
  client: Client;
  activeTerminalId: string | undefined;
  requestedDraft?: TerminalAiDraft | undefined;
  onDraftConsumed?(): void;
  embedded?: boolean;
  active?: boolean;
  workspaceTitle?: string;
  settingsOnly?: boolean;
  terminalTabs?: readonly { id: string; title: string; tabNumber?: number }[];
  terminalChoice?: string;
  onTerminalChange?(id: string): void;
}) {
  const { x, language } = useI18n();
  const { providers, models, runs, conversations, approvals, engines } = useAiFacts(client.model);
  const workspace = useAiRead(client.queries, 'workspace', activeTerminalId);
  const catalog = useAiRead(client.queries, 'catalog');
  const skills = useAiRead(client.queries, 'skills');
  const insertTerminal = client.insertTerminal;
  const [setup, setSetup] = useState(false);
  const setupLock = useRef(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [setupNotice, setSetupNotice] = useState('');
  const setupFeedback = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!setupError) return;
    setupFeedback.current?.focus({ preventScroll: true });
    setupFeedback.current?.scrollIntoView({ block: 'center' });
  }, [setupError]);
  const [engineId, setEngineId] = useState('pi');
  const selectedEngine = engines.data?.find((engine) => engine.id === engineId);
  const [providerPage, setProviderPage] = useState(0);
  const [approvalPage, setApprovalPage] = useState(0);
  useEffect(() => {
    if (providerPage > 0 && providerPage * 20 >= (providers.data?.length ?? 0)) setProviderPage(0);
    if (approvalPage > 0 && approvalPage * 8 >= (approvals.data?.length ?? 0)) setApprovalPage(0);
  }, [providerPage, approvalPage, providers.data?.length, approvals.data?.length]);
  const toolCalls = useAiRead(client.queries, 'tools', String(approvalPage * 8));
  const offeredSetupRef = useRef(false);
  const [error, setError] = useState('');
  const [piAuthMethod, setPiAuthMethod] = useState<'api_key' | 'oauth'>('api_key');
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [piLogin, setPiLogin] = useState<PiLoginState>();
  useEffect(() => {
    if (piLogin?.status === 'succeeded') setSetupError('');
  }, [piLogin?.status, piLogin?.provider]);
  const accountLogin = piAuthMethod === 'oauth';
  const piProviders = catalog.data?.filter(({ apiKeyAvailable, oauth }) =>
    accountLogin ? !!oauth : apiKeyAvailable,
  );
  const selectedPiProvider =
    piProviders?.find(({ id }) => id === selectedProviderId) ??
    (accountLogin
      ? (piProviders?.find(({ id }) => id === 'openai-codex') ?? piProviders?.[0])
      : undefined);
  const piProviderId = selectedPiProvider?.id ?? '';
  const [providerStatus, setProviderStatus] = useState<Record<string, string>>({});
  const [providerAction, setProviderAction] = useState<ProviderAction>();
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
  const dismissContextReview = contextReview.dismiss,
    cancelAttachments = attachmentDrafts.cancel;
  useEffect(() => {
    if (!active) {
      dismissContextReview();
      cancelAttachments();
    }
  }, [active, dismissContextReview, cancelAttachments]);
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
  const [messageWindow, setMessageWindow] = useState<{
    id: string;
    direction: 'earlier' | 'later';
    cursor: number;
  }>();
  const windowSelection = messageWindow?.id === currentConversationId ? messageWindow : undefined;
  const windowKey = currentConversationId
    ? `${currentConversationId}:${windowSelection?.direction ?? 'latest'}:${windowSelection?.cursor ?? 0}`
    : undefined;
  const conversation = useAiRead(client.queries, 'conversation', windowKey);
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
  const latestConversationRun = runs.data?.find(
    (item) =>
      typeof currentConversationId === 'string' && item.conversationId === currentConversationId,
  );
  const pendingConversationRun =
    activeConversationRun ??
    (!conversation.data?.hasLater &&
    latestConversationRun &&
    !conversation.data?.messages.some(
      (message) => message.role === 'assistant' && message.runId === latestConversationRun.id,
    )
      ? latestConversationRun
      : undefined);
  const selectedRun = useSelectedRun(
    client.model,
    pendingConversationRun?.id ?? latestConversationRun?.id,
  );
  const historyRunIds = [
    ...new Set(
      conversation.data?.messages
        .filter(
          (message) =>
            message.runId &&
            message.runId !== (pendingConversationRun?.id ?? latestConversationRun?.id),
        )
        .map((message) => message.runId!) ?? [],
    ),
  ].filter((id) =>
    runs.data?.some((run) => run.id === id && ['chat', 'diagnose'].includes(run.useCase)),
  );
  const historicalTools = useAiRead(
    client.queries,
    'toolsByRuns',
    active && !setup && historyRunIds.length ? JSON.stringify(historyRunIds) : undefined,
  );
  const activityTools = [
    ...new Map(
      [...(historicalTools.data ?? []), ...selectedRun.tools, ...(toolCalls.data ?? [])].map(
        (call) => [call.id, call],
      ),
    ).values(),
  ];
  const activityApprovals = [
    ...new Map(
      [...(approvals.data ?? []), ...selectedRun.approvals].map((approval) => [
        approval.id,
        approval,
      ]),
    ).values(),
  ];
  const decideTool = async (approval: AiApproval, decision: 'approve_once' | 'reject') => {
    await client.decideApproval(approval.id, decision, approval.argsHash);
    await Promise.all([approvals.refetch(), runs.refetch(), toolCalls.refetch()]);
  };
  const cancelTool = async (id: string) => {
    await client.cancelAi(id);
    await Promise.all([approvals.refetch(), runs.refetch(), toolCalls.refetch()]);
  };
  const inlineTools = (id: string) => (
    <AgentToolCards
      visible={active}
      toolCalls={activityTools.filter((call) => call.runId === id)}
      approvals={activityApprovals}
      decide={decideTool}
      cancel={cancelTool}
    />
  );
  const streamedRun = selectedRun.value;
  const visibleRun = conversation.data?.hasLater
    ? undefined
    : (streamedRun ??
      (pendingConversationRun ? { ...pendingConversationRun, result: undefined } : undefined));
  const messagesElement = useRef<HTMLDivElement>(null);
  const followResponse = useRef(true);
  useLayoutEffect(() => {
    const element = messagesElement.current;
    if (element && followResponse.current) element.scrollTop = element.scrollHeight;
  }, [
    visibleRun?.result,
    conversation.data?.messages.length,
    selectedRun.tools,
    historicalTools.data,
  ]);
  async function configure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (setupLock.current) return;
    setupLock.current = true;
    setSetupBusy(true);
    setSetupError('');
    setSetupNotice('');
    const form = new FormData(event.currentTarget);
    const createdCredentialRefs: string[] = [];
    let providerId = '';
    let providerAttempted = false;
    try {
      if (selectedEngine?.state !== 'ready') throw new AiInputError(x('common.operationFailed'));
      const piJson = String(form.get('piModelsJson') ?? '').trim();
      if (engineId !== 'pi') {
        if (!String(form.get('model') ?? '').trim()) throw new AiInputError(x('ai.piImportFailed'));
        providerAttempted = true;
        const provider = await client.createAiProvider({
          name: String(form.get('name')),
          engineId,
          enabled: true,
          role: String(form.get('role')),
        });
        providerId = provider.id;
        await client.createAiModel({
          providerId: provider.id,
          name: String(form.get('model')),
          model: String(form.get('model')),
          capabilities: selectedEngine.capabilities.tools ? ['chat', 'tools'] : ['chat'],
        });
        await configurationSaved();
        return;
      }
      if (accountLogin && !selectedPiProvider) throw new AiInputError(x('ai.loginRequired'));
      if (piJson) {
        try {
          await importPiModels(
            client,
            piJson,
            String(form.get('apiKey') ?? ''),
            catalog.data ?? [],
          );
        } catch {
          throw new AiInputError(x('ai.piImportFailed'));
        }
        await configurationSaved();
        return;
      }
      if (
        !String(form.get('model') ?? '') ||
        (!selectedPiProvider && !String(form.get('apiKey') ?? ''))
      )
        throw new AiInputError(x('ai.piImportFailed'));
      if (
        selectedPiProvider &&
        (piLogin?.provider !== selectedPiProvider.id ||
          piLogin.status !== 'succeeded' ||
          !piLogin.credentialRef)
      )
        throw new AiInputError(x('ai.loginRequired'));
      const configuredCatalog =
        selectedPiProvider && piLogin?.status === 'succeeded'
          ? { ...selectedPiProvider, models: piLogin.models }
          : selectedPiProvider;
      const pi = piConfigurationForModel(
        configuredCatalog,
        String(form.get('model')),
        form.get('api') ?? configuredCatalog?.models[0]?.api,
      );
      if (selectedPiProvider) {
        pi.credentialMode = 'pi';
        // Dynamic/account-specific models become portable metadata, never auth grants.
        const accountModel = piLogin!.models.find(({ id }) => id === String(form.get('model')));
        if (accountModel)
          pi.models = selectedPiProvider.models.some(({ id }) => id === accountModel.id)
            ? []
            : [accountModel];
      }
      const baseUrl =
        String(form.get('baseUrl') ?? '').trim() ||
        (pi.models.some((model) => !model.baseUrl) ? selectedPiProvider?.baseUrl : undefined);
      const credential = selectedPiProvider
        ? { ref: piLogin!.credentialRef! }
        : await client.createCredential({
            kind: 'aiApiKey',
            label: `${String(form.get('name'))} API Key`,
            secret: String(form.get('apiKey')),
          });
      if (!selectedPiProvider) createdCredentialRefs.push(credential.ref);
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
      providerAttempted = true;
      const provider = await client.createAiProvider({
        name: String(form.get('name')),
        ...(baseUrl ? { baseUrl } : {}),
        pi,
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
      });
      providerId = provider.id;
      await client.createAiModel({
        providerId: provider.id,
        name: String(form.get('model')),
        model: String(form.get('model')),
        capabilities: ['chat', 'tools'],
      });
      setProviderStatus((current) => ({
        ...current,
        [provider.id]: x('ai.providerSaved'),
      }));
      await configurationSaved();
    } catch (cause) {
      setSetupError(safeAiMessage(cause, x));
      // A failed response can follow a committed provider. Retain its references.
      let releaseCredentials = !providerAttempted;
      if (providerId) {
        try {
          const createdProvider = (await providers.refetch()).data?.find(
            ({ id }) => id === providerId,
          );
          if (createdProvider) {
            await client.deleteAiProvider(createdProvider);
            releaseCredentials = true;
          } else releaseCredentials = false;
        } catch {
          releaseCredentials = false;
        }
      }
      if (releaseCredentials)
        await Promise.allSettled(createdCredentialRefs.map((ref) => client.deleteCredential(ref)));
    } finally {
      setupLock.current = false;
      setSetupBusy(false);
    }
  }
  function selectPiAuthMethod(method: typeof piAuthMethod) {
    if (method === piAuthMethod) return;
    setPiAuthMethod(method);
    setSelectedProviderId('');
    setPiLogin(undefined);
    setSetupError('');
  }
  async function configurationSaved() {
    setSetup(false);
    setSetupNotice(x('ai.providerSaved'));
    // The writes succeeded. A view refresh must not roll back committed configuration.
    await Promise.allSettled([
      Promise.resolve().then(() => providers.refetch()),
      Promise.resolve().then(() => models.refetch()),
    ]);
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
    followResponse.current = true;
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
      setMessageWindow(undefined);
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
    setMessageWindow(undefined);
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
  async function insertGeneratedCode(runId: string, value: string) {
    const code = aiTerminalInsertion(value);
    if (!code || !activeTerminalId) {
      setChatActionStatus((current) => ({
        ...current,
        [runId]: code ? x('ai.noActiveTerminal') : x('ai.codeTooLarge'),
      }));
      return;
    }
    try {
      await insertTerminal(activeTerminalId, code);
      setChatActionStatus((current) => ({ ...current, [runId]: x('ai.codeInserted') }));
    } catch {
      setChatActionStatus((current) => ({ ...current, [runId]: x('common.operationFailed') }));
    }
  }
  const providerForm = (
    <form
      className={cx('setup-form surface ai-provider-form')}
      aria-busy={setupBusy}
      onSubmit={(event) => void configure(event)}
    >
      <header className={cx('ai-provider-modal-header')}>
        {settingsOnly ? (
          <strong>{x('ai.configTitle')}</strong>
        ) : (
          <DialogTitle asChild>
            <strong>{x('ai.configTitle')}</strong>
          </DialogTitle>
        )}
        {!settingsOnly && (
          <button type="button" aria-label={x('panels.cancel')} onClick={() => setSetup(false)}>
            <X size={15} />
          </button>
        )}
      </header>
      <label className={cx('full-field')}>
        {x('ai.engine')}
        <select
          aria-label={x('ai.engine')}
          value={engineId}
          onChange={(event) => {
            setEngineId(event.currentTarget.value);
            setPiLogin(undefined);
            setSetupError('');
          }}
        >
          {!engines.data?.some((engine) => engine.id === engineId) && (
            <option value={engineId} disabled>
              {engineId}
            </option>
          )}
          {engines.data?.map((engine) => (
            <option key={engine.id} value={engine.id} disabled={engine.state !== 'ready'}>
              {engine.label}
            </option>
          ))}
        </select>
      </label>
      {engineId === 'pi' && (
        <>
          <div
            className={cx('full-field ai-provider-auth-methods')}
            role="group"
            aria-label={x('ai.authMethod')}
          >
            <Button aria-pressed={!accountLogin} onClick={() => selectPiAuthMethod('api_key')}>
              {x('panels.apiKey')}
            </Button>
            <Button aria-pressed={accountLogin} onClick={() => selectPiAuthMethod('oauth')}>
              {x('ai.accountLogin')}
            </Button>
          </div>
          <label className={cx('full-field')}>
            {x('ai.piProvider')}
            <select
              aria-label={x('ai.piProvider')}
              value={piProviderId}
              disabled={accountLogin && !selectedPiProvider}
              onChange={(event) => {
                setSelectedProviderId(event.currentTarget.value);
                setPiLogin(undefined);
                setSetupError('');
              }}
            >
              {!accountLogin && <option value="">{x('ai.piCustom')}</option>}
              {accountLogin && !selectedPiProvider && (
                <option value="">{x('ai.noAccountProviders')}</option>
              )}
              {piProviders?.map(({ id, name, oauth }) => (
                <option key={id} value={id}>
                  {accountLogin && id === 'openai-codex'
                    ? x('ai.codexSubscription')
                    : accountLogin
                      ? (oauth?.name ?? name)
                      : name}
                </option>
              ))}
            </select>
          </label>
          {accountLogin && catalog.isError && (
            <div className={cx('full-field')} role="alert">
              {x('common.operationFailed')}{' '}
              <button type="button" onClick={() => void catalog.refetch()}>
                {x('common.retry')}
              </button>
            </div>
          )}
          {accountLogin && selectedPiProvider && (
            <ProviderLogin
              key={`oauth-${piProviderId}`}
              provider={selectedPiProvider}
              client={client}
              authMethod="oauth"
              onChange={setPiLogin}
            />
          )}
        </>
      )}
      <label>
        {x('panels.name')}
        <input
          name="name"
          key={`name-${engineId}-${piProviderId}`}
          defaultValue={
            engineId === 'pi'
              ? (selectedPiProvider?.name ?? 'OpenAI Compatible')
              : (engines.data?.find((engine) => engine.id === engineId)?.label ?? engineId)
          }
          required
        />
      </label>
      {engineId === 'pi' && !accountLogin && !selectedPiProvider && (
        <label>
          {x('ai.providerProtocol')}
          <select name="api" defaultValue="openai-completions">
            {piApiSchema.options.map((api) => (
              <option key={api} value={api}>
                {api}
              </option>
            ))}
          </select>
        </label>
      )}
      {engineId === 'pi' && !accountLogin && (
        <label>
          {x('panels.baseUrl')}
          <input
            name="baseUrl"
            key={`url-${piProviderId}`}
            defaultValue={selectedPiProvider ? '' : 'https://api.openai.com/v1/'}
            placeholder={selectedPiProvider ? x('ai.providerModelEndpoint') : undefined}
            required={!selectedPiProvider}
          />
        </label>
      )}
      {engineId === 'pi' && selectedPiProvider ? (
        <PiModelPicker
          key={`model-${piProviderId}`}
          models={
            piLogin?.status === 'succeeded' && piLogin.provider === selectedPiProvider.id
              ? piLogin.models
              : selectedPiProvider.models
          }
        />
      ) : !accountLogin || engineId !== 'pi' ? (
        <label>
          {x('panels.model')}
          <input name="model" key={`model-${engineId}`} placeholder="gpt-4.1-mini" />
        </label>
      ) : null}
      {engineId === 'pi' && !accountLogin && selectedPiProvider && (
        <ProviderLogin
          key={selectedPiProvider.id}
          provider={selectedPiProvider}
          client={client}
          authMethod="api_key"
          onChange={setPiLogin}
        />
      )}
      {engineId === 'pi' && !accountLogin && !selectedPiProvider && (
        <label>
          {x('panels.apiKey')}
          <input name="apiKey" type="password" autoComplete="off" />
        </label>
      )}
      {engineId === 'pi' && (
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
      )}
      <label className={cx('full-field')}>
        {x('ai.systemRole')}
        <textarea name="role" defaultValue={DEFAULT_AI_ROLE} rows={3} required />
      </label>
      {engineId === 'pi' && !accountLogin && (
        <label className={cx('full-field')}>
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
      )}
      {engineId === 'pi' && !accountLogin && (
        <p className={cx('full-field')}>{x('ai.piConfigHelp')}</p>
      )}
      {engineId === 'pi' && (
        <label className={cx('full-field')}>
          {x('ai.proxyUrl')}
          <input name="proxyUrl" placeholder="socks5://127.0.0.1:1080" />
        </label>
      )}
      {engineId === 'pi' && (
        <label>
          {x('ai.proxyUsername')}
          <input name="proxyUsername" autoComplete="off" />
        </label>
      )}
      {engineId === 'pi' && (
        <label>
          {x('ai.proxyPassword')}
          <input name="proxyPassword" type="password" autoComplete="off" />
        </label>
      )}
      {setupError && (
        <div className={cx('full-field')} ref={setupFeedback} tabIndex={-1}>
          <ErrorBanner text={setupError} />
        </div>
      )}
      <button
        className={cx('primary')}
        disabled={
          setupBusy ||
          selectedEngine?.state !== 'ready' ||
          (engineId === 'pi' && accountLogin && piLogin?.status !== 'succeeded')
        }
      >
        {setupBusy ? <LoaderCircle size={13} /> : <Save size={13} />}{' '}
        {x(setupBusy ? 'ai.providerSaving' : 'panels.saveConfiguration')}
      </button>
      {!!providers.data?.length && (
        <section className={cx('full-field ai-provider-grid')} aria-label={x('ai.savedProviders')}>
          {providers.data.slice(providerPage * 20, providerPage * 20 + 20).map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              queries={client.queries}
              status={providerStatus[provider.id]}
              onTest={() => void testProvider(provider.id)}
              onToggle={() => void toggleProvider(provider.id)}
              onAction={setProviderAction}
            />
          ))}
          {providers.data.length > 20 && (
            <nav aria-label={x('ai.savedProviders')}>
              <button
                type="button"
                disabled={providerPage === 0}
                onClick={() => setProviderPage((page) => page - 1)}
              >
                {x('ai.previousPage')}
              </button>
              <button
                type="button"
                disabled={(providerPage + 1) * 20 >= providers.data.length}
                onClick={() => setProviderPage((page) => page + 1)}
              >
                {x('ai.nextPage')}
              </button>
            </nav>
          )}
        </section>
      )}
    </form>
  );
  const providerManagement = providerAction && (
    <ProviderManagement
      action={providerAction}
      client={client}
      catalog={catalog.data}
      onClose={() => setProviderAction(undefined)}
      onSuccess={() => {
        const { kind, provider } = providerAction;
        setProviderAction(undefined);
        setSetupNotice(x(kind === 'delete' ? 'ai.providerDeleted' : 'ai.providerSaved'));
        setProviderStatus((current) => {
          const next = { ...current };
          delete next[provider.id];
          return next;
        });
      }}
    />
  );
  if (settingsOnly)
    return (
      <section className={cx('ai-settings-page')} data-ai-provider-settings="">
        {providers.isError && <ErrorBanner text={x('ai.metadataUnavailable')} />}
        {error && <ErrorBanner text={error} />}
        {providerForm}
        {providerManagement}
        {(setupNotice || Object.values(providerStatus).at(-1)) && (
          <p role="status">{setupNotice || Object.values(providerStatus).at(-1)}</p>
        )}
      </section>
    );
  return (
    <AiPanelFrame
      embedded={embedded}
      eyebrow={x('panels.aiInspector')}
      title={x('panels.aiAssistant')}
      description={x('panels.aiDescription')}
      action={
        <button
          onClick={() => {
            offeredSetupRef.current = true;
            setSetupError('');
            setSetup(!setup);
          }}
        >
          <KeyRound size={13} /> {x('panels.provider')}
        </button>
      }
    >
      <div className={cx('ai-workspace-context')}>
        <strong>{workspaceTitle ?? x('app.currentContext')}</strong>
        {onTerminalChange && (
          <label className={cx('ai-terminal-choice')}>
            <span>{x('ai.terminalTab')}</span>
            <select
              name="aiTerminal"
              value={terminalChoice}
              onChange={(event) => onTerminalChange(event.currentTarget.value)}
            >
              <option value="">
                {x('ai.followActiveTab')}
                {activeTerminalId
                  ? ` · ${terminalTabs.find((tab) => tab.id === activeTerminalId)?.title ?? ''}`
                  : ''}
              </option>
              {terminalTabs.map((tab) => (
                <option key={tab.id} value={tab.id}>
                  {tab.tabNumber ? `${tab.tabNumber} · ` : ''}
                  {tab.title}
                </option>
              ))}
            </select>
          </label>
        )}
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
      {!setup && (setupNotice || Object.values(providerStatus).at(-1)) && (
        <p className={cx('ai-provider-notice')} role="status">
          {setupNotice || Object.values(providerStatus).at(-1)}
        </p>
      )}
      {providers.isError && (
        <div role="alert">
          <ErrorBanner text={x('ai.metadataUnavailable')} />
          <button
            type="button"
            onClick={() =>
              void client.model.retry().catch(() => setError(x('common.operationFailed')))
            }
          >
            {x('common.retry')}
          </button>
        </div>
      )}
      {selectedRun.unavailable && (
        <div role="alert">
          <ErrorBanner text={x('ai.historyLoadFailed')} />
          <button type="button" onClick={selectedRun.retry}>
            {x('common.retry')}
          </button>
        </div>
      )}
      {(error || attachmentDrafts.error || contextReview.error) && (
        <ErrorBanner text={error || attachmentDrafts.error || contextReview.error} />
      )}
      {active && contextReview.preview && (
        <AiContextReview
          preview={contextReview.preview}
          busy={contextReview.busy}
          onClose={contextReview.dismiss}
          onSend={() => void sendReviewed()}
        />
      )}
      {conversations.isError && (
        <div className={cx('ai-history-recovery')} role="alert">
          <span>{x('ai.historyLoadFailed')}</span>
          <button type="button" onClick={() => void conversations.refetch().catch(() => {})}>
            {x('common.retry')}
          </button>
        </div>
      )}
      {active && setup && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setProviderAction(undefined);
              setSetup(false);
            }
          }}
        >
          <DialogContent
            className={cx('ai-provider-modal')}
            overlayClassName={cx('ai-provider-overlay')}
            aria-describedby={undefined}
          >
            {providerForm}
            {providerManagement}
          </DialogContent>
        </Dialog>
      )}

      <section
        className={cx(`ai-chat-workspace${showConversationHistory ? '' : ' history-hidden'}`)}
        aria-label={x('ai.chatWorkspace')}
      >
        {showConversationHistory && (
          <aside className={cx('surface ai-chat-sessions')}>
            <div className={cx('ai-chat-sessions-toolbar')}>
              <strong>{x('ai.chatHistory')}</strong>
            </div>
            <div className={cx('ai-chat-session-list')}>
              {!conversations.isError && !conversations.data?.length && (
                <div className={cx('ai-chat-empty compact')}>
                  <Bot size={22} />
                  <span>{x('ai.noChatHistory')}</span>
                </div>
              )}
              {!conversations.isError &&
                conversations.data?.map((item) => (
                  <article
                    key={item.id}
                    className={cx(
                      `ai-chat-session${item.id === currentConversationId ? ' active' : ''}`,
                    )}
                  >
                    <button
                      type="button"
                      className={cx('ai-chat-session-select')}
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
                      className={cx('danger-icon')}
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
        <div className={cx('surface ai-chat-main')}>
          <header className={cx('ai-chat-header')}>
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
            <div className={cx('ai-chat-delete-confirm')} role="alertdialog" aria-modal="true">
              <span>{x('ai.deleteChatConfirm')}</span>
              <button type="button" onClick={() => setDeleteConversationId(null)}>
                {x('panels.cancel')}
              </button>
              <button
                type="button"
                className={cx('danger')}
                onClick={() => void removeConversation(deleteConversationId)}
              >
                {x('ai.deleteChat')}
              </button>
            </div>
          )}
          {conversation.data && (conversation.data.hasEarlier || conversation.data.hasLater) && (
            <nav aria-label={x('ai.chatHistory')}>
              <button
                type="button"
                disabled={!conversation.data.hasEarlier}
                onClick={() => {
                  if (currentConversationId && conversation.data)
                    setMessageWindow({
                      id: currentConversationId,
                      direction: 'earlier',
                      cursor: conversation.data.firstCursor,
                    });
                }}
              >
                {x('ai.earlierMessages')}
              </button>
              <button
                type="button"
                disabled={!conversation.data.hasLater}
                onClick={() => {
                  if (currentConversationId && conversation.data)
                    setMessageWindow({
                      id: currentConversationId,
                      direction: 'later',
                      cursor: conversation.data.lastCursor,
                    });
                }}
              >
                {x('ai.newerMessages')}
              </button>
              {conversation.data.hasLater && (
                <button type="button" onClick={() => setMessageWindow(undefined)}>
                  {x('ai.latestMessages')}
                </button>
              )}
            </nav>
          )}
          <div
            className={cx('ai-chat-messages')}
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
                <div className={cx('ai-chat-empty')}>
                  <span className={cx('ai-chat-empty-mark')}>
                    <WandSparkles size={22} />
                  </span>
                  <strong>{x('ai.emptyConversation')}</strong>
                  <p>{x('ai.emptyConversationHint')}</p>
                </div>
              )}
            {historicalTools.isError && (
              <div role="alert">
                <ErrorBanner text={x('ai.historyLoadFailed')} />
                <button type="button" onClick={() => void historicalTools.refetch()}>
                  {x('common.retry')}
                </button>
              </div>
            )}
            {conversation.data?.messages.map((message) => {
              const messageRun = runs.data?.find(({ id }) => id === message.runId);
              return (
                <Fragment key={message.id}>
                  {message.role === 'assistant' && message.runId && inlineTools(message.runId)}
                  <article className={cx(`ai-chat-message ${message.role}`)}>
                    <div className={cx('ai-chat-message-meta')}>
                      <strong>
                        {message.role === 'user' ? x('ai.you') : x('panels.aiAssistant')}
                      </strong>
                      <span>{new Date(message.createdAt).toLocaleString(language)}</span>
                    </div>
                    {!!message.attachments.length && (
                      <div
                        className={cx('ai-message-attachments')}
                        aria-label={x('ai.sentAttachments')}
                      >
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
                    {message.errorCode && <small>{aiFailureMessage(message.errorCode, x)}</small>}
                    {message.role === 'assistant' &&
                      messageRun?.useCase === 'generateCommand' &&
                      message.content && (
                        <div className={cx('ai-chat-code-actions')}>
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
                </Fragment>
              );
            })}
            {visibleRun &&
              !conversation.data?.messages.some(
                (message) => message.role === 'assistant' && message.runId === visibleRun.id,
              ) && (
                <Fragment>
                  {inlineTools(visibleRun.id)}
                  <article
                    className={cx('ai-chat-message assistant pending')}
                    data-run-id={visibleRun.id}
                    aria-busy={['queued', 'running'].includes(visibleRun.state)}
                  >
                    <div className={cx('ai-chat-message-meta')}>
                      <strong>{x('panels.aiAssistant')}</strong>
                      <span className={cx(`run-state ${visibleRun.state}`)}>
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
                          void client
                            .cancelAi(activeConversationRun.id)
                            .then(async () => {
                              await Promise.all([
                                runs.refetch(),
                                conversations.refetch(),
                                conversation.refetch(),
                              ]);
                            })
                            .catch(() => setError(x('common.operationFailed')))
                        }
                      >
                        <Square size={11} /> {x('panels.cancel')}
                      </button>
                    )}
                  </article>
                </Fragment>
              )}
          </div>
          <form
            className={cx(`ai-chat-composer${attachmentDragOver ? ' attachment-dragover' : ''}`)}
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
            <div className={cx('ai-chat-options')}>
              <label className={cx('ai-model-choice')}>
                <span>{x('panels.model')}</span>
                <span className={cx('ai-model-select')}>
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
                  <span className={cx('ai-model-select-value')} aria-hidden="true">
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
                className={cx('ai-attachment-button')}
                onClick={() => void chooseAttachment()}
                disabled={attachmentBusy || contextReview.busy || attachments.length >= 8}
              >
                {attachmentBusy ? (
                  <LoaderCircle className={cx('spin')} size={12} />
                ) : (
                  <Paperclip size={12} />
                )}
                {x('ai.attachTextFile')}
              </button>
              {attachmentBusy && (
                <button
                  type="button"
                  className={cx('ai-attachment-cancel')}
                  onClick={attachmentDrafts.cancel}
                >
                  <Square size={10} /> {x('panels.cancel')}
                </button>
              )}
              <label className={cx('ai-history-choice')}>
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
              <div className={cx('ai-attachment-drafts')} aria-label={x('ai.pendingAttachments')}>
                {attachments.map((attachment) => (
                  <span
                    key={attachment.id}
                    className={cx(previewAttachmentId === attachment.id ? 'active' : '')}
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
              <div className={cx('ai-attachment-preview')}>
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
      {(approvals.data?.length ?? 0) > 8 && (
        <nav aria-label={x('ai.waitingApproval')}>
          <button
            type="button"
            disabled={approvalPage === 0}
            onClick={() => setApprovalPage((page) => page - 1)}
          >
            {x('ai.previousPage')}
          </button>
          <button
            type="button"
            disabled={(approvalPage + 1) * 8 >= (approvals.data?.length ?? 0)}
            onClick={() => setApprovalPage((page) => page + 1)}
          >
            {x('ai.nextPage')}
          </button>
        </nav>
      )}
      <AgentToolCards
        visible={active}
        portalOnly
        toolCalls={(toolCalls.data ?? []).filter(
          (call) =>
            !conversation.data?.messages.some((message) => message.runId === call.runId) &&
            visibleRun?.id !== call.runId,
        )}
        approvals={activityApprovals}
        decide={decideTool}
        cancel={cancelTool}
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
    <div className={cx('ai-panel-embedded')}>
      <div className={cx('ai-embedded-toolbar')}>{props.action}</div>
      {children}
    </div>
  ) : (
    <PanelFrame {...props}>{children}</PanelFrame>
  );
}

export function AgentToolCards({
  visible,
  portalOnly = false,
  approvals,
  toolCalls,
  decide,
  cancel,
}: {
  visible: boolean;
  portalOnly?: boolean;
  approvals: readonly AiApproval[];
  toolCalls: AiToolCall[];
  decide(approval: AiApproval, decision: 'approve_once' | 'reject'): Promise<unknown>;
  cancel(runId: string): Promise<unknown>;
}) {
  const { x } = useI18n();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const actionLocks = useRef(new Set<string>());
  const [dismissedApproval, setDismissedApproval] = useState<string>();
  const [actionError, setActionError] = useState('');
  const pendingCall = toolCalls.find(
    (call) =>
      call.state === 'waiting_approval' &&
      approvals.some((item) => item.toolCallId === call.id && item.state === 'pending'),
  );
  const pendingApproval = approvals.find(
    (item) => item.toolCallId === pendingCall?.id && item.state === 'pending',
  );
  async function runAction(callId: string, action: () => Promise<unknown>) {
    if (actionLocks.current.has(callId)) return;
    actionLocks.current.add(callId);
    setActionError('');
    setExpanded((current) => ({ ...current, [callId]: true }));
    setBusy((current) => ({ ...current, [callId]: true }));
    try {
      await action();
    } catch {
      setActionError(x('common.operationFailed'));
    } finally {
      actionLocks.current.delete(callId);
      setBusy((current) => {
        const next = { ...current };
        delete next[callId];
        return next;
      });
    }
  }
  if (!toolCalls.length) return null;
  return (
    <>
      {visible &&
        pendingCall &&
        pendingApproval &&
        createPortal(
          dismissedApproval === pendingApproval.id ? (
            <button
              className={cx('ai-approval-reminder')}
              type="button"
              onClick={() => setDismissedApproval(undefined)}
            >
              <ShieldAlert size={18} /> {x('ai.waitingApproval')} <ChevronRight size={16} />
            </button>
          ) : (
            <AiCommandApproval
              key={pendingApproval.id}
              call={pendingCall}
              approval={pendingApproval}
              busy={!!busy[pendingCall.id]}
              error={actionError}
              onClose={() => {
                if (!actionLocks.current.has(pendingCall.id))
                  setDismissedApproval(pendingApproval.id);
              }}
              onDecide={(decision) =>
                void runAction(pendingCall.id, () => decide(pendingApproval, decision))
              }
            />
          ),
          document.body,
        )}
      {!portalOnly && (
        <section className={cx('ai-tool-timeline')} aria-label={x('ai.toolDetails')}>
          {toolCalls.map((call) => {
            const approval = approvals.find((item) => item.toolCallId === call.id);
            const isExpanded = call.state === 'waiting_approval' || (expanded[call.id] ?? false);
            const active = ['proposed', 'running'].includes(call.state);
            const output = call.resultMetadata ? formatToolResult(call.resultMetadata) : '';
            const preview = output.split('\n').slice(0, 10).join('\n').slice(0, 4096);
            return (
              <article
                data-tool-id={call.id}
                data-run-id={call.runId}
                aria-busy={busy[call.id] || undefined}
                className={cx(`agent-tool-card state-${call.state}`)}
                key={call.id}
              >
                <button
                  aria-expanded={isExpanded}
                  className={cx('agent-tool-card-header')}
                  type="button"
                  onClick={() => {
                    if (call.state === 'waiting_approval' && approval?.state === 'pending')
                      setDismissedApproval(undefined);
                    setExpanded((current) => ({ ...current, [call.id]: !isExpanded }));
                  }}
                >
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span>
                    <strong>
                      {call.toolName === 'plugins.manage'
                        ? x('ai.pluginManagementTool')
                        : call.toolName === 'workspace.exec'
                          ? `$ ${String(call.args.command ?? '')}`
                          : call.toolName}
                    </strong>
                  </span>
                  <i
                    className={cx(`run-state ${call.state}`)}
                    aria-label={toolStateLabel(call.state, x)}
                  >
                    {['proposed', 'running'].includes(call.state) && (
                      <LoaderCircle className={cx('spin')} size={11} />
                    )}
                    {call.state === 'succeeded' && <Check size={11} />}
                    {['failed', 'canceled'].includes(call.state) && <X size={11} />}
                    {call.state === 'proposed' && call.review
                      ? x('ai.reviewingCommand')
                      : call.state !== 'succeeded'
                        ? toolStateLabel(call.state, x)
                        : null}
                  </i>
                </button>
                {output && (
                  <pre className={cx('ai-tool-output')} tabIndex={0}>
                    {isExpanded ? output : preview}
                    {!isExpanded && output !== preview ? '\n…' : ''}
                  </pre>
                )}
                {isExpanded && (
                  <div className={cx('agent-tool-card-detail')}>
                    <details>
                      <summary>{x('ai.toolDetails')}</summary>
                      {call.review && (
                        <section className={cx('agent-tool-review')}>
                          <strong>
                            {x(
                              call.approvalSource === 'automatic'
                                ? 'ai.automaticallyApproved'
                                : 'ai.commandReview',
                            )}
                          </strong>
                          <p>{call.review.reason}</p>
                        </section>
                      )}
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
                    </details>
                    {call.state === 'failed' && !call.resultMetadata && (
                      <p className={cx('agent-tool-error')}>{x('ai.toolFailed')}</p>
                    )}
                    {approval?.state === 'pending' && (
                      <div className={cx('agent-tool-approval')}>
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
                          className={cx('danger')}
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
                      <div className={cx('agent-tool-approval')}>
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
      )}
    </>
  );
}

function AiCommandApproval({
  call,
  approval,
  busy,
  error,
  onClose,
  onDecide,
}: {
  call: AiToolCall;
  approval: AiApproval;
  busy: boolean;
  error: string;
  onClose(): void;
  onDecide(decision: 'approve_once' | 'reject'): void;
}) {
  const { x, language } = useI18n();
  const parsed = aiWorkspaceSchema.safeParse(call.args.workspace);
  const workspace = parsed.success ? parsed.data : undefined;
  const target = workspace?.sshTarget
    ? `${workspace.sshTarget.username}@${workspace.sshTarget.hostname}:${workspace.sshTarget.port}`
    : workspace?.execution === 'local'
      ? x('ai.executionLocal')
      : call.target;
  return (
    <Modal
      title={x(
        call.toolName === 'plugins.manage'
          ? 'ai.pluginManagementApproval'
          : 'panels.terminalOperationApproval',
      )}
      className={cx('ai-command-approval')}
      onClose={onClose}
    >
      <div className={cx('ai-command-approval-body')}>
        <p className={cx('ai-command-approval-risk')}>
          <ShieldAlert size={18} /> {toolRiskLabel(call.risk, x)}
        </p>
        {call.toolName === 'plugins.manage' && <p>{x('ai.pluginManagementWarning')}</p>}
        {call.review && <p>{call.review.reason}</p>}
        <dl className={cx('ai-review-target')}>
          <div>
            <dt>{x('ai.target')}</dt>
            <dd>{target}</dd>
          </div>
          {workspace && (
            <div>
              <dt>{x('ai.workspace')}</dt>
              <dd>{workspace.commandDirectory ?? workspace.workspaceDirectory}</dd>
            </div>
          )}
        </dl>
        <pre
          tabIndex={0}
          aria-label={x(
            call.toolName === 'plugins.manage' ? 'ai.arguments' : 'panels.commandForReview',
          )}
        >
          {typeof call.args.command === 'string'
            ? call.args.command
            : JSON.stringify(call.args, null, 2)}
        </pre>
        <details>
          <summary>{x('ai.arguments')}</summary>
          <pre tabIndex={0}>{JSON.stringify(call.args, null, 2)}</pre>
        </details>
        {error && <ErrorBanner text={error} />}
      </div>
      <footer>
        <small>
          {x('panels.expiresAt', {
            time: new Date(approval.expiresAt).toLocaleTimeString(language),
          })}
        </small>
        <button type="button" data-autofocus disabled={busy} onClick={() => onDecide('reject')}>
          {x('panels.reject')}
        </button>
        <button
          type="button"
          className={cx('primary')}
          disabled={busy}
          onClick={() => onDecide('approve_once')}
        >
          {busy ? <LoaderCircle className={cx('spin')} size={14} /> : <Check size={14} />}{' '}
          {x(call.toolName === 'plugins.manage' ? 'ai.pluginManagementApprove' : 'panels.runOnce')}
        </button>
      </footer>
    </Modal>
  );
}

function formatToolResult(value: Record<string, unknown>): string {
  const output =
    typeof value.output === 'string'
      ? value.output
      : typeof value.stdout === 'string' || typeof value.stderr === 'string'
        ? [value.stdout, value.stderr].filter((part) => typeof part === 'string' && part).join('\n')
        : undefined;
  const text = output ?? JSON.stringify(value, null, 2);
  return text.length > 65_536 ? text.slice(0, 65_536) + '\n…' : text;
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
