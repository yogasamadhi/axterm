import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import {
  DEFAULT_TERMINAL_BACKGROUND,
  type TerminalBackground,
  type TerminalTheme,
  type TerminalThemeInput,
  type TerminalVisualSettings,
} from '@axterm/plugin-api/terminals';
import {
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  LoaderCircle,
  Palette,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  Type,
  Upload,
} from 'lucide-react';
import type { TranslateNS } from '@axterm/ui';
import type { AiThemeUi, TerminalVisualUi, WorkspaceUi } from '@axterm/ui/workspace';
import type { ConfigurationClientActions } from '@axterm/plugin-api/configuration';
import type { TerminalFactsModel } from '../facts.ts';
import type { TerminalThemeCommands } from './commands.ts';
import type { TerminalThemeAssetPicker } from './assets.ts';
import styles from './themes.module.css';
const cx = (...names: string[]) =>
  names
    .flatMap((name) =>
      name
        .split(/\s+/)
        .filter(Boolean)
        .map((name) => [name, styles[name] ?? ''].join(' ')),
    )
    .join(' ');
type ThemeMessageKey = Parameters<TranslateNS<'terminals'>>[0];
const emptyAi = { status: 'connecting' } as const;
const emptySubscribe = () => () => {};
const getEmptyAi = () => emptyAi;
type TerminalColorKey = keyof TerminalThemeInput['terminal'];
type UiColorKey = keyof TerminalThemeInput['ui'];

const terminalColorLabels: Array<[TerminalColorKey, ThemeMessageKey]> = [
  ['foreground', 'terminalThemes.colorForeground'],
  ['background', 'terminalThemes.colorBackground'],
  ['cursor', 'terminalThemes.colorCursor'],
  ['cursorAccent', 'terminalThemes.colorCursorAccent'],
  ['selectionBackground', 'terminalThemes.colorSelection'],
  ['black', 'terminalThemes.colorBlack'],
  ['red', 'terminalThemes.colorRed'],
  ['green', 'terminalThemes.colorGreen'],
  ['yellow', 'terminalThemes.colorYellow'],
  ['blue', 'terminalThemes.colorBlue'],
  ['magenta', 'terminalThemes.colorMagenta'],
  ['cyan', 'terminalThemes.colorCyan'],
  ['white', 'terminalThemes.colorWhite'],
  ['brightBlack', 'terminalThemes.colorBrightBlack'],
  ['brightRed', 'terminalThemes.colorBrightRed'],
  ['brightGreen', 'terminalThemes.colorBrightGreen'],
  ['brightYellow', 'terminalThemes.colorBrightYellow'],
  ['brightBlue', 'terminalThemes.colorBrightBlue'],
  ['brightMagenta', 'terminalThemes.colorBrightMagenta'],
  ['brightCyan', 'terminalThemes.colorBrightCyan'],
  ['brightWhite', 'terminalThemes.colorBrightWhite'],
];

const uiColorLabels: Array<[UiColorKey, ThemeMessageKey]> = [
  ['main', 'terminalThemes.uiMain'],
  ['main-dark', 'terminalThemes.uiMainDark'],
  ['main-light', 'terminalThemes.uiMainLight'],
  ['text', 'terminalThemes.uiText'],
  ['text-light', 'terminalThemes.uiTextLight'],
  ['text-dark', 'terminalThemes.uiTextDark'],
  ['text-disabled', 'terminalThemes.uiTextDisabled'],
  ['primary', 'terminalThemes.uiPrimary'],
  ['info', 'terminalThemes.uiInfo'],
  ['success', 'terminalThemes.uiSuccess'],
  ['error', 'terminalThemes.uiError'],
  ['warn', 'terminalThemes.uiWarning'],
];

const copyInput = (theme: TerminalTheme): TerminalThemeInput => ({
  name: theme.name,
  terminal: { ...theme.terminal },
  ui: { ...theme.ui },
});

export function TerminalThemeWorkspace({
  model,
  configuration,
  workspace,
  visuals,
  commands,
  assets,
  ai,
  x,
  retire,
  signal,
  track,
}: {
  model: TerminalFactsModel;
  configuration: ConfigurationClientActions;
  workspace: WorkspaceUi;
  visuals: TerminalVisualUi;
  commands: TerminalThemeCommands;
  assets: TerminalThemeAssetPicker;
  ai?: AiThemeUi;
  x: TranslateNS<'terminals'>;
  retire(): void;
  signal: AbortSignal;
  track<T>(task: Promise<T>): Promise<T>;
}) {
  const facts = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const configurationState = useSyncExternalStore(
    configuration.subscribe,
    configuration.getSnapshot,
  );
  const workspaceState = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const command = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  const aiState = useSyncExternalStore(
    ai?.subscribe ?? emptySubscribe,
    ai?.getSnapshot ?? getEmptyAi,
  );
  const themeItems = facts.status === 'ready' ? facts.baseline.themes : undefined;
  const acceptedSettings =
    configurationState.status === 'ready' ? configurationState.baseline.settings : undefined;
  const availableModels = aiState.status === 'ready' ? aiState.baseline.models : undefined;
  const activeTerminal = workspaceState.tabs.find(
    (tab) => tab.id === workspaceState.activeTabId && tab.kind === 'terminal',
  );
  const activeTerminalId = activeTerminal?.id;
  const viewLife = useRef(new AbortController());
  const activeAiRunRef = useRef<AbortController>();
  const previewRelease = useRef<() => void>();
  const lastCompleted = useRef(0);
  const [selectedId, setSelectedId] = useState('');
  const [draftState, setDraft] = useState<TerminalThemeInput>();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [message, setMessage] = useState('');
  const [working, setBusy] = useState(false);
  const busy = working || command.busy || command.uncertain;
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [colorEditorMode, setColorEditorMode] = useState<'picker' | 'text'>('picker');
  const [scope, setScope] = useState<'global' | 'session'>('global');
  const [backgroundDraft, setBackground] = useState<TerminalBackground>();
  const pendingAssetId = useRef<string | undefined>(undefined);
  const aiRequestRef = useRef(0);
  const previousThemeRef = useRef<
    { selectedId: string; creating: boolean; draft: TerminalThemeInput | undefined } | undefined
  >(undefined);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiDescription, setAiDescription] = useState('');
  const [aiModelId, setAiModelId] = useState('');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiDraftActive, setAiDraftActive] = useState(false);
  const preferredVisual =
    scope === 'session'
      ? (activeTerminal?.terminalVisual ?? acceptedSettings?.terminal.visual)
      : acceptedSettings?.terminal.visual;
  const selected =
    facts.status === 'error' || creating
      ? undefined
      : (themeItems?.find(({ id }) => id === selectedId) ??
        themeItems?.find(({ id }) => id === preferredVisual?.themeId) ??
        themeItems?.[0]);
  const draft = draftState ?? (selected ? copyInput(selected) : undefined);
  const background = backgroundDraft ?? preferredVisual?.background ?? DEFAULT_TERMINAL_BACKGROUND;
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (facts.status === 'error' ? [] : (themeItems ?? [])).filter(
      ({ name }) => !needle || name.toLocaleLowerCase().includes(needle),
    );
  }, [themeItems, facts.status, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleThemes = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => {
    if (!activeTerminalId || !selected) return;
    const release = visuals.preview(activeTerminalId, { themeId: selected.id, background });
    previewRelease.current = release;
    return () => {
      release();
      if (previewRelease.current === release) previewRelease.current = undefined;
    };
  }, [activeTerminalId, background, selected, visuals]);
  useEffect(() => {
    viewLife.current = new AbortController();
    return () => {
      viewLife.current.abort();
      aiRequestRef.current++;
      activeAiRunRef.current?.abort();
      previewRelease.current?.();
      retire();
    };
  }, [retire]);
  useEffect(
    () => () => {
      activeAiRunRef.current?.abort();
    },
    [ai],
  );
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (signal.aborted || command.completed === lastCompleted.current) return;
      lastCompleted.current = command.completed;
      const result = command.result;
      if (!result) return;
      if (result.kind === 'save' || result.kind === 'clone') {
        const saved = themeItems?.find((theme) => theme.id === result.id);
        if (saved) {
          setCreating(false);
          setSelectedId(saved.id);
          setDraft(copyInput(saved));
          setPage(Math.floor((themeItems?.indexOf(saved) ?? 0) / pageSize) + 1);
        }
        setAiDraftActive(false);
        previousThemeRef.current = undefined;
        setMessage(x(result.kind === 'save' ? 'terminalThemes.saved' : 'terminalThemes.cloned'));
      } else if (result.kind === 'delete') {
        const next = themeItems?.[0];
        setSelectedId(next?.id ?? '');
        setDraft(next ? copyInput(next) : undefined);
        setDeleteArmed(false);
        setMessage(x('terminalThemes.deleted'));
      } else {
        pendingAssetId.current = undefined;
        previewRelease.current?.();
        setMessage(x('terminalThemes.appliedGlobal'));
      }
    });
    return () => {
      active = false;
    };
  }, [command.completed, command.result, themeItems, pageSize, x, signal]);
  const selectedAiModelId = aiModelId || availableModels?.[0]?.id || '';

  function clearAiState() {
    aiRequestRef.current += 1;
    if (activeAiRunRef.current) activeAiRunRef.current.abort();
    activeAiRunRef.current = undefined;
    previousThemeRef.current = undefined;
    setAiGenerating(false);
    setAiOpen(false);
    setAiDraftActive(false);
  }

  function selectTheme(theme: TerminalTheme) {
    clearAiState();
    setCreating(false);
    setSelectedId(theme.id);
    setDraft(copyInput(theme));
    setDeleteArmed(false);
    setMessage('');
  }

  function discardPendingAsset() {
    const id = pendingAssetId.current;
    pendingAssetId.current = undefined;
    if (id)
      void assets.discard(id).catch(() => {
        if (!(viewLife.current.signal.aborted || signal.aborted))
          setMessage(x('common.operationFailed'));
      });
  }

  function changeScope(next: 'global' | 'session') {
    clearAiState();
    const visual =
      next === 'session'
        ? (activeTerminal?.terminalVisual ?? acceptedSettings?.terminal.visual)
        : acceptedSettings?.terminal.visual;
    const theme = themeItems?.find(({ id }) => id === visual?.themeId) ?? themeItems?.[0];
    discardPendingAsset();
    setScope(next);
    setCreating(false);
    setSelectedId(theme?.id ?? '');
    setDraft(theme ? copyInput(theme) : undefined);
    setBackground({ ...(visual?.background ?? DEFAULT_TERMINAL_BACKGROUND) });
    setDeleteArmed(false);
    setMessage('');
  }

  function createNew() {
    const source = themeItems?.[0];
    if (!source) return;
    clearAiState();
    setCreating(true);
    setSelectedId('');
    setDraft({ ...copyInput(source), name: x('terminalThemes.newTheme') });
    setDeleteArmed(false);
    setMessage('');
  }

  async function run(invoke: () => Promise<void>) {
    setMessage('');
    try {
      await invoke();
      if (!signal.aborted && !viewLife.current.signal.aborted && commands.getSnapshot().failed)
        setMessage(x('common.operationFailed'));
    } catch {
      if (!(viewLife.current.signal.aborted || signal.aborted))
        setMessage(x('common.operationFailed'));
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || busy) return;
    await run(() => commands.save(draft, creating ? undefined : selected));
  }
  async function cloneSelected() {
    if (!selected || busy) return;
    await run(() => commands.clone(selected));
  }
  async function deleteSelected() {
    if (!selected || selected.builtIn || busy) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      setMessage(x('terminalThemes.confirmDelete'));
      return;
    }
    await run(() => commands.remove(selected));
  }
  async function applyVisual() {
    if (!selected || busy) return;
    const visual: TerminalVisualSettings = { themeId: selected.id, background };
    if (scope === 'session') {
      try {
        if (!activeTerminalId) throw new ThemeLocalError(x('terminalThemes.noActiveSession'));
        visuals.apply(activeTerminalId, visual);
        assets.commit(visual.background.assetId);
        pendingAssetId.current = undefined;
        previewRelease.current?.();
        setMessage(x('terminalThemes.appliedSession'));
      } catch (cause) {
        setMessage(messageOf(cause, x));
      }
    } else await run(() => commands.apply(visual));
  }
  async function acceptBackground(retry = false) {
    if (working || command.busy || command.uncertain) return;
    setBusy(true);
    setMessage('');
    try {
      const asset = await (retry
        ? assets.retry(viewLife.current.signal)
        : assets.choose(viewLife.current.signal));
      if (!asset || viewLife.current.signal.aborted || signal.aborted) return;
      const previous = pendingAssetId.current;
      pendingAssetId.current = asset.id;
      setBackground({ ...background, kind: 'image', assetId: asset.id });
      if (previous && previous !== asset.id) await assets.discard(previous);
      setMessage(x('terminalThemes.backgroundReady', { bytes: asset.bytes }));
    } catch (cause) {
      if (!(viewLife.current.signal.aborted || signal.aborted)) setMessage(messageOf(cause, x));
    } finally {
      if (!(viewLife.current.signal.aborted || signal.aborted)) setBusy(false);
    }
  }
  async function chooseBackgroundImage() {
    await acceptBackground();
  }

  function openAiGenerator() {
    if (!aiOpen && !aiDraftActive)
      previousThemeRef.current = {
        selectedId,
        creating,
        draft: draft ? structuredClone(draft) : undefined,
      };
    setAiOpen(true);
    setMessage('');
  }

  function discardAiDraft() {
    aiRequestRef.current += 1;
    if (activeAiRunRef.current) activeAiRunRef.current.abort();
    const previous = previousThemeRef.current;
    activeAiRunRef.current = undefined;
    setAiGenerating(false);
    setAiOpen(false);
    setAiDraftActive(false);
    previousThemeRef.current = undefined;
    if (previous) {
      setSelectedId(previous.selectedId);
      setCreating(previous.creating);
      setDraft(previous.draft ? structuredClone(previous.draft) : undefined);
    }
    setMessage(x('terminalThemes.aiDiscarded'));
  }

  async function generateAiTheme() {
    if (!ai || !selectedAiModelId || !aiDescription.trim() || aiGenerating) return;
    const request = ++aiRequestRef.current,
      abort = new AbortController();
    activeAiRunRef.current = abort;
    setAiGenerating(true);
    setMessage('');
    try {
      const generated = await track(
        ai.generateTheme(
          { modelId: selectedAiModelId, prompt: aiDescription.trim(), ...(draft ? { draft } : {}) },
          AbortSignal.any([abort.signal, viewLife.current.signal, signal]),
        ),
      );
      if (
        aiRequestRef.current !== request ||
        abort.signal.aborted ||
        viewLife.current.signal.aborted ||
        signal.aborted
      )
        return;
      setDraft(generated);
      setPreviewOpen(true);
      setSelectedId('');
      setCreating(true);
      setAiDraftActive(true);
      setAiOpen(false);
      setMessage(x('terminalThemes.aiPreviewReady'));
    } catch (cause) {
      if (aiRequestRef.current === request && !(viewLife.current.signal.aborted || signal.aborted))
        setMessage(
          x(
            cause instanceof Error && cause.message === 'AI_THEME_TIMEOUT'
              ? 'terminalThemes.aiTimeout'
              : cause instanceof Error &&
                  (cause.message === 'AI_THEME_OUTPUT_INVALID' ||
                    cause.message === 'AI_THEME_OUTPUT_TOO_LARGE')
                ? 'terminalThemes.aiInvalid'
                : cause instanceof Error && cause.message === 'AI_THEME_OUTCOME_UNCERTAIN'
                  ? 'terminalThemes.unknownOutcome'
                  : 'terminalThemes.aiFailed',
          ),
        );
    } finally {
      if (
        aiRequestRef.current === request &&
        !(viewLife.current.signal.aborted || signal.aborted)
      ) {
        activeAiRunRef.current = undefined;
        setAiGenerating(false);
      }
    }
  }

  const terminal = draft?.terminal;
  return (
    <div className={cx('terminal-theme-workspace')} data-terminal-themes>
      {(command.uncertain || (!working && assets.hasPendingIntent())) && (
        <div role="alert" className={cx('terminal-theme-recovery')}>
          <p>{x('terminalThemes.unknownOutcome')}</p>
          <button
            type="button"
            disabled={working || command.busy}
            onClick={() => {
              if (command.uncertain) void run(() => commands.retry());
              else void acceptBackground(true);
            }}
          >
            {x('common.retry')}
          </button>
        </div>
      )}
      <aside className={cx('terminal-theme-list')} aria-label={x('terminalThemes.list')}>
        <h1 className={cx('terminal-theme-list-heading')}>{x('terminalThemes.eyebrow')}</h1>
        <div className={cx('terminal-theme-list-actions')}>
          {ai && (
            <button
              type="button"
              title={x('terminalThemes.createWithAi')}
              aria-label={x('terminalThemes.createWithAi')}
              onClick={openAiGenerator}
            >
              <Bot size={15} />
            </button>
          )}
          <button
            type="button"
            title={x('terminalThemes.new')}
            aria-label={x('terminalThemes.new')}
            onClick={createNew}
          >
            <Plus size={15} />
          </button>
        </div>
        <label className={cx('terminal-theme-search')}>
          <Search size={14} aria-hidden="true" />
          <input
            aria-label={x('terminalThemes.search')}
            placeholder={x('terminalThemes.searchShort')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <p className={cx('terminal-theme-current')}>
          <Check size={14} aria-hidden="true" />
          {selected?.name ?? (creating ? x('terminalThemes.newTheme') : x('terminalThemes.select'))}
        </p>
        <div className={cx('terminal-theme-list-scroll')}>
          {facts.status === 'error' && (
            <div className={cx('terminal-theme-recovery')} role="alert">
              <p>{x('terminalThemes.loadFailed')}</p>
              <button type="button" onClick={() => void model.retry()}>
                {x('common.retry')}
              </button>
            </div>
          )}
          {!(facts.status === 'error') && (
            <>
              <button
                className={cx(`terminal-theme-list-item new ${creating ? 'active' : ''}`)}
                type="button"
                onClick={createNew}
              >
                <Plus size={14} /> {x('terminalThemes.newTheme')}
              </button>
              {visibleThemes.map((theme) => (
                <button
                  className={cx(
                    `terminal-theme-list-item ${selected?.id === theme.id ? 'active' : ''}`,
                  )}
                  key={theme.id}
                  type="button"
                  onClick={() => selectTheme(theme)}
                >
                  <span
                    className={cx('terminal-theme-mode')}
                    style={{ background: theme.ui.main }}
                  />
                  <span>{theme.name}</span>
                  {theme.builtIn && <small>{x('terminalThemes.builtIn')}</small>}
                </button>
              ))}
              {!(facts.status === 'connecting') && !filtered.length && (
                <p className={cx('terminal-theme-empty')}>{x('terminalThemes.noMatches')}</p>
              )}
            </>
          )}
        </div>
        {!!filtered.length && (
          <nav
            className={cx('terminal-theme-pagination')}
            aria-label={x('terminalThemes.pagination')}
          >
            <button
              type="button"
              aria-label={x('terminalThemes.previousPage')}
              disabled={currentPage === 1}
              onClick={() => setPage(Math.max(1, currentPage - 1))}
            >
              <ChevronLeft size={14} />
            </button>
            <output aria-label={x('terminalThemes.currentPage')}>{currentPage}</output>
            <span>/</span>
            <span>{pageCount}</span>
            <button
              type="button"
              aria-label={x('terminalThemes.nextPage')}
              disabled={currentPage === pageCount}
              onClick={() => setPage(Math.min(pageCount, currentPage + 1))}
            >
              <ChevronRight size={14} />
            </button>
            <label>
              <span className={cx('sr-only')}>{x('terminalThemes.pageSize')}</span>
              <select
                aria-label={x('terminalThemes.pageSize')}
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
              >
                {[10, 20, 50].map((size) => (
                  <option key={size} value={size}>
                    {x('terminalThemes.perPage', { count: size })}
                  </option>
                ))}
              </select>
            </label>
          </nav>
        )}
      </aside>
      <div className={cx('terminal-theme-editor')}>
        {ai && aiOpen && (
          <section className={cx('terminal-theme-ai')} aria-label={x('terminalThemes.aiGenerator')}>
            <div className={cx('terminal-theme-ai-heading')}>
              <span>
                <Bot size={18} />
              </span>
              <div>
                <strong>{x('terminalThemes.aiTitle')}</strong>
                <p>{x('terminalThemes.aiHint')}</p>
              </div>
            </div>
            <div className={cx('terminal-theme-ai-fields')}>
              <label>
                {x('terminalThemes.aiModel')}
                <select
                  aria-label={x('terminalThemes.aiModel')}
                  value={selectedAiModelId}
                  onChange={(event) => setAiModelId(event.target.value)}
                >
                  <option value="">{x('terminalThemes.aiSelectModel')}</option>
                  {(availableModels ?? []).map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {x('terminalThemes.aiDescription')}
                <textarea
                  autoFocus
                  maxLength={16_384}
                  onChange={(event) => setAiDescription(event.target.value)}
                  placeholder={x('terminalThemes.aiPlaceholder')}
                  rows={4}
                  value={aiDescription}
                />
              </label>
            </div>
            <p className={cx('terminal-theme-ai-safety')}>
              <ShieldCheck size={14} /> {x('terminalThemes.aiSafety')}
            </p>
            {!(aiState.status === 'connecting') && !availableModels?.length && (
              <p className={cx('terminal-theme-message')}>{x('terminalThemes.aiNoModels')}</p>
            )}
            <div className={cx('terminal-theme-ai-actions')}>
              <button type="button" onClick={discardAiDraft}>
                {x('common.cancel')}
              </button>
              <button
                className={cx('primary')}
                disabled={aiGenerating || !selectedAiModelId || !aiDescription.trim()}
                type="button"
                onClick={() => void generateAiTheme()}
              >
                {aiGenerating ? (
                  <LoaderCircle className={cx('spin')} size={14} />
                ) : (
                  <Bot size={14} />
                )}
                {aiGenerating ? x('terminalThemes.aiGenerating') : x('terminalThemes.aiGenerate')}
              </button>
            </div>
          </section>
        )}
        {facts.status === 'error' ? null : draft && terminal ? (
          <form onSubmit={(event) => void save(event)}>
            {aiDraftActive && (
              <div className={cx('terminal-theme-ai-preview-notice')} role="status">
                <div>
                  <Bot size={15} />
                  <span>
                    <strong>{x('terminalThemes.aiPreview')}</strong>
                    <small>{x('terminalThemes.aiPreviewHint')}</small>
                  </span>
                </div>
                <button type="button" onClick={discardAiDraft}>
                  <RotateCcw size={13} /> {x('terminalThemes.aiDiscard')}
                </button>
              </div>
            )}
            <header className={cx('terminal-theme-editor-header')}>
              <div>
                <p>{x('terminalThemes.eyebrow')}</p>
                <h2>{creating ? x('terminalThemes.newTheme') : selected?.name}</h2>
              </div>
              {!creating && (
                <div className={cx('terminal-theme-editor-actions')}>
                  <label className={cx('terminal-theme-scope')}>
                    <span className={cx('sr-only')}>{x('terminalThemes.scope')}</span>
                    <select
                      aria-label={x('terminalThemes.scope')}
                      value={scope}
                      onChange={(event) => changeScope(event.target.value as 'global' | 'session')}
                    >
                      <option value="global">{x('terminalThemes.global')}</option>
                      <option value="session" disabled={!activeTerminalId}>
                        {x('terminalThemes.currentSession')}
                      </option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className={cx('primary')}
                    disabled={!selected || busy}
                    onClick={() => void applyVisual()}
                  >
                    <Check size={14} /> {x('terminalThemes.apply')}
                  </button>
                  <button
                    type="button"
                    aria-expanded={previewOpen}
                    onClick={() => setPreviewOpen((open) => !open)}
                  >
                    <Eye size={14} /> {x('terminalThemes.preview')}
                  </button>
                  {selected && (
                    <>
                      <button type="button" onClick={() => void cloneSelected()} disabled={busy}>
                        <Copy size={14} /> {x('terminalThemes.clone')}
                      </button>
                    </>
                  )}
                  {selected && !selected.builtIn && (
                    <button
                      className={cx(deleteArmed ? 'danger' : '')}
                      type="button"
                      onClick={() => void deleteSelected()}
                      disabled={busy}
                    >
                      <Trash2 size={14} />{' '}
                      {x(deleteArmed ? 'terminalThemes.confirmDeleteButton' : 'common.delete')}
                    </button>
                  )}
                </div>
              )}
            </header>
            {previewOpen && (
              <section
                className={cx('terminal-theme-preview')}
                aria-label={x('terminalThemes.preview')}
                style={{ background: terminal.background, color: terminal.foreground }}
              >
                <div
                  className={cx('terminal-theme-preview-bar')}
                  style={{ background: draft.ui.main }}
                >
                  <span style={{ color: draft.ui.text }}>Axterm · ~/workspace</span>
                  <span style={{ color: draft.ui.success }}>● {x('terminalThemes.connected')}</span>
                </div>
                <code>
                  <span style={{ color: terminal.green }}>user@host</span>
                  <span style={{ color: terminal.foreground }}>:</span>
                  <span style={{ color: terminal.blue }}>~/workspace</span>
                  <span style={{ color: terminal.foreground }}>$ </span>
                  <span style={{ color: terminal.yellow }}>ls -la</span>
                  <br />
                  <span style={{ color: terminal.cyan }}>drwxr-xr-x</span> src&nbsp;&nbsp;
                  <span style={{ color: terminal.magenta }}>README.md</span>
                </code>
                <div
                  className={cx('terminal-theme-ansi')}
                  aria-label={x('terminalThemes.ansiPalette')}
                >
                  {[
                    terminal.black,
                    terminal.red,
                    terminal.green,
                    terminal.yellow,
                    terminal.blue,
                    terminal.magenta,
                    terminal.cyan,
                    terminal.white,
                    terminal.brightBlack,
                    terminal.brightRed,
                    terminal.brightGreen,
                    terminal.brightYellow,
                    terminal.brightBlue,
                    terminal.brightMagenta,
                    terminal.brightCyan,
                    terminal.brightWhite,
                  ].map((color, index) => (
                    <span key={`${color}-${index}`} style={{ background: color }} />
                  ))}
                </div>
              </section>
            )}
            <label className={cx('terminal-theme-name')}>
              {x('terminalThemes.name')}
              <input
                required
                maxLength={30}
                disabled={selected?.builtIn}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <div className={cx('terminal-theme-config-header')}>
              <strong>{x('terminalThemes.config')}</strong>
              {!selected?.builtIn && (
                <button className={cx('primary')} type="submit" disabled={busy}>
                  {x('common.save')}
                </button>
              )}
            </div>
            <div
              className={cx('terminal-theme-editor-mode')}
              role="tablist"
              aria-label={x('terminalThemes.terminalColors')}
            >
              <button
                type="button"
                role="tab"
                aria-selected={colorEditorMode === 'picker'}
                onClick={() => setColorEditorMode('picker')}
              >
                <Palette size={13} /> {x('terminalThemes.colorPicker')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={colorEditorMode === 'text'}
                onClick={() => setColorEditorMode('text')}
              >
                <Type size={13} /> {x('terminalThemes.textEditor')}
              </button>
              {ai && (
                <button type="button" role="tab" aria-selected={false} onClick={openAiGenerator}>
                  <Bot size={13} /> AI
                </button>
              )}
            </div>
            <div className={cx('terminal-theme-color-sections')}>
              <ThemeColorSection
                x={x}
                title={x('terminalThemes.interfaceColors')}
                entries={uiColorLabels}
                values={draft.ui}
                mode={colorEditorMode}
                disabled={selected?.builtIn === true}
                onChange={(key, value) => setDraft({ ...draft, ui: { ...draft.ui, [key]: value } })}
              />
              <ThemeColorSection
                x={x}
                title={x('terminalThemes.terminalColors')}
                entries={terminalColorLabels}
                values={draft.terminal}
                mode={colorEditorMode}
                disabled={selected?.builtIn === true}
                onChange={(key, value) =>
                  setDraft({ ...draft, terminal: { ...draft.terminal, [key]: value } })
                }
              />
            </div>
            <fieldset className={cx('terminal-background-editor')}>
              <legend>{x('terminalThemes.terminalBackground')}</legend>
              <label>
                {x('terminalThemes.type')}
                <select
                  aria-label={x('terminalThemes.backgroundType')}
                  value={background.kind}
                  onChange={(event) => {
                    const kind = event.target.value as TerminalBackground['kind'];
                    if (kind !== 'image') discardPendingAsset();
                    setBackground({
                      ...background,
                      kind,
                      assetId: kind === 'image' ? background.assetId : null,
                      text: kind === 'text' ? background.text || 'Axterm' : background.text,
                    });
                  }}
                >
                  <option value="none">{x('terminalThemes.none')}</option>
                  <option value="text">{x('terminalThemes.text')}</option>
                  <option value="image" disabled={!background.assetId}>
                    {x('terminalThemes.image')}
                  </option>
                </select>
              </label>
              <button type="button" onClick={() => void chooseBackgroundImage()} disabled={busy}>
                <Upload size={14} /> {x('terminalThemes.chooseImage')}
              </button>
              {background.kind === 'text' && (
                <>
                  <label>
                    {x('terminalThemes.backgroundText')}
                    <input
                      aria-label={x('terminalThemes.backgroundText')}
                      maxLength={240}
                      value={background.text}
                      onChange={(event) =>
                        setBackground({ ...background, text: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    {x('terminalThemes.fontSize')}
                    <input
                      aria-label={x('terminalThemes.backgroundFontSize')}
                      type="number"
                      min={12}
                      max={240}
                      value={background.textSize}
                      onChange={(event) =>
                        setBackground({ ...background, textSize: Number(event.target.value) })
                      }
                    />
                  </label>
                  <label>
                    {x('terminalThemes.color')}
                    <input
                      aria-label={x('terminalThemes.backgroundTextColor')}
                      value={background.textColor}
                      onChange={(event) =>
                        setBackground({ ...background, textColor: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    {x('terminalThemes.font')}
                    <input
                      aria-label={x('terminalThemes.backgroundFont')}
                      value={background.textFontFamily}
                      onChange={(event) =>
                        setBackground({ ...background, textFontFamily: event.target.value })
                      }
                    />
                  </label>
                </>
              )}
              {background.kind !== 'none' && (
                <div className={cx('terminal-background-filters')}>
                  {(
                    [
                      ['opacity', 'terminalThemes.opacity', 0, 1, 0.05],
                      ['blur', 'terminalThemes.blur', 0, 50, 0.5],
                      ['brightness', 'terminalThemes.brightness', 0, 10, 0.1],
                      ['grayscale', 'terminalThemes.grayscale', 0, 1, 0.05],
                      ['contrast', 'terminalThemes.contrast', 0, 10, 0.1],
                    ] as const
                  ).map(([key, label, min, max, step]) => (
                    <label key={key}>
                      {x(label)}
                      <input
                        aria-label={x('terminalThemes.backgroundFilter', { label: x(label) })}
                        type="number"
                        min={min}
                        max={max}
                        step={step}
                        value={background[key]}
                        onChange={(event) =>
                          setBackground({ ...background, [key]: Number(event.target.value) })
                        }
                      />
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            {selected?.builtIn && (
              <p className={cx('terminal-theme-help')}>{x('terminalThemes.builtInReadOnly')}</p>
            )}
            {message && <p className={cx('terminal-theme-message')}>{message}</p>}
          </form>
        ) : (
          <p className={cx('terminal-theme-empty')}>{x('terminalThemes.loading')}</p>
        )}
      </div>
    </div>
  );
}

function ThemeColorSection<K extends string>({
  x,
  title,
  entries,
  values,
  mode,
  disabled,
  onChange,
}: {
  x: TranslateNS<'terminals'>;
  title: string;
  entries: Array<[K, ThemeMessageKey]>;
  values: Record<K, string>;
  mode: 'picker' | 'text';
  disabled: boolean;
  onChange(key: K, value: string): void;
}) {
  return (
    <fieldset className={cx('terminal-theme-color-section')}>
      <legend>{title}</legend>
      <div className={cx('terminal-theme-color-grid')}>
        {entries.map(([key, label]) => (
          <label key={key}>
            <span>{x(label)}</span>
            {mode === 'picker' ? (
              <input
                className={cx('terminal-theme-color-picker')}
                type="color"
                aria-label={`${title} ${x(label)}`}
                disabled={disabled || !/^#[\da-f]{6}$/iu.test(values[key])}
                value={/^#[\da-f]{6}$/iu.test(values[key]) ? values[key] : '#808080'}
                onChange={(event) => onChange(key, event.target.value)}
              />
            ) : (
              <span className={cx('terminal-theme-color-control')}>
                <i style={{ background: values[key] }} />
                <input
                  aria-label={`${title} ${x(label)}`}
                  disabled={disabled}
                  value={values[key]}
                  onChange={(event) => onChange(key, event.target.value)}
                />
              </span>
            )}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function messageOf(cause: unknown, x: TranslateNS<'terminals'>): string {
  return cause instanceof ThemeLocalError ? cause.message : x('common.operationFailed');
}

class ThemeLocalError extends Error {}
