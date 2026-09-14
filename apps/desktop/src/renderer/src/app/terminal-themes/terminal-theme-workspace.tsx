import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import {
  DEFAULT_TERMINAL_BACKGROUND,
  type TerminalBackground,
  type TerminalTheme,
  type TerminalThemeInput,
  type TerminalVisualSettings,
} from '@workspace/contracts';
import {
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  ExternalLink,
  LoaderCircle,
  Link,
  Palette,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  Type,
  Upload,
} from 'lucide-react';
import { useWorkspace } from '../../stores/workspace';
import { useI18n } from '../../i18n/context';
import type { AxtermMessageKey } from '../../i18n/core';
import { parseAiThemeDraft } from './ai-theme-draft';
import './terminal-theme-workspace.css';

type Client = ReturnType<typeof createRuntimeClient>;
type TerminalColorKey = keyof TerminalThemeInput['terminal'];
type UiColorKey = keyof TerminalThemeInput['ui'];

const terminalColorLabels: Array<[TerminalColorKey, AxtermMessageKey]> = [
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

const uiColorLabels: Array<[UiColorKey, AxtermMessageKey]> = [
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

export function TerminalThemeWorkspace({ client }: { client: Client }) {
  const { x } = useI18n();
  const themes = useQuery({ queryKey: ['terminal-themes'], queryFn: client.terminalThemes });
  const settings = useQuery({ queryKey: ['settings'], queryFn: client.settings });
  const models = useQuery({ queryKey: ['ai-models'], queryFn: client.aiModels });
  const activeTerminalId = useWorkspace((state) => state.activeTerminalId);
  const activeTerminal = useWorkspace((state) =>
    state.tabs.find((tab) => tab.id === state.activeTerminalId),
  );
  const setTerminalVisual = useWorkspace((state) => state.setTerminalVisual);
  const setTerminalVisualPreview = useWorkspace((state) => state.setTerminalVisualPreview);
  const [selectedId, setSelectedId] = useState('');
  const [draftState, setDraft] = useState<TerminalThemeInput>();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [colorEditorMode, setColorEditorMode] = useState<'picker' | 'text'>('picker');
  const [scope, setScope] = useState<'global' | 'session'>('global');
  const [backgroundDraft, setBackground] = useState<TerminalBackground>();
  const pendingAssetId = useRef<string | undefined>(undefined);
  const aiRequestRef = useRef(0);
  const activeAiRunRef = useRef<string | undefined>(undefined);
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
      ? (activeTerminal?.visual ?? settings.data?.terminal.visual)
      : settings.data?.terminal.visual;
  const selected = creating
    ? undefined
    : (themes.data?.find(({ id }) => id === selectedId) ??
      themes.data?.find(({ id }) => id === preferredVisual?.themeId) ??
      themes.data?.[0]);
  const draft = draftState ?? (selected ? copyInput(selected) : undefined);
  const background = backgroundDraft ?? preferredVisual?.background ?? DEFAULT_TERMINAL_BACKGROUND;
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (themes.data ?? []).filter(
      ({ name }) => !needle || name.toLocaleLowerCase().includes(needle),
    );
  }, [themes.data, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleThemes = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => {
    if (!activeTerminalId || !selected) {
      setTerminalVisualPreview(undefined);
      return;
    }
    setTerminalVisualPreview({
      terminalId: activeTerminalId,
      visual: { themeId: selected.id, background },
    });
    return () => setTerminalVisualPreview(undefined);
  }, [activeTerminalId, background, selected, setTerminalVisualPreview]);

  useEffect(
    () => () => {
      aiRequestRef.current += 1;
      if (activeAiRunRef.current)
        void client.cancelAi(activeAiRunRef.current).catch(() => undefined);
      setTerminalVisualPreview(undefined);
      if (pendingAssetId.current)
        void client.deleteTerminalBackgroundAsset(pendingAssetId.current).catch(() => undefined);
    },
    [client, setTerminalVisualPreview],
  );

  const selectedAiModelId = aiModelId || models.data?.[0]?.id || '';

  function clearAiState() {
    aiRequestRef.current += 1;
    if (activeAiRunRef.current) void client.cancelAi(activeAiRunRef.current).catch(() => undefined);
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
    if (id) void client.deleteTerminalBackgroundAsset(id).catch(() => undefined);
  }

  function changeScope(next: 'global' | 'session') {
    clearAiState();
    const visual =
      next === 'session'
        ? (activeTerminal?.visual ?? settings.data?.terminal.visual)
        : settings.data?.terminal.visual;
    const theme = themes.data?.find(({ id }) => id === visual?.themeId) ?? themes.data?.[0];
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
    const source = themes.data?.[0];
    if (!source) return;
    clearAiState();
    setCreating(true);
    setSelectedId('');
    setDraft({ ...copyInput(source), name: x('terminalThemes.newTheme') });
    setDeleteArmed(false);
    setMessage('');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || busy) return;
    const wasCreating = creating;
    setBusy(true);
    setMessage('');
    try {
      const saved = creating
        ? await client.createTerminalTheme(draft)
        : selected
          ? await client.updateTerminalTheme(selected, draft)
          : undefined;
      if (!saved) return;
      const result = await themes.refetch();
      setCreating(false);
      setSelectedId(saved.id);
      setDraft(copyInput(saved));
      setAiDraftActive(false);
      previousThemeRef.current = undefined;
      setMessage(x('terminalThemes.saved'));
      if (wasCreating) {
        const index = result.data?.findIndex(({ id }) => id === saved.id) ?? -1;
        if (index >= 0) setPage(Math.floor(index / pageSize) + 1);
      }
    } catch (cause) {
      setMessage(messageOf(cause, x));
      await themes.refetch();
    } finally {
      setBusy(false);
    }
  }

  async function cloneSelected() {
    if (!selected || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const cloned = await client.cloneTerminalTheme(selected.id);
      const result = await themes.refetch();
      setCreating(false);
      setSelectedId(cloned.id);
      setDraft(copyInput(cloned));
      const index = result.data?.findIndex(({ id }) => id === cloned.id) ?? -1;
      if (index >= 0) setPage(Math.floor(index / pageSize) + 1);
      setMessage(x('terminalThemes.cloned'));
    } catch (cause) {
      setMessage(messageOf(cause, x));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    if (!selected || selected.builtIn || busy) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      setMessage(x('terminalThemes.confirmDelete'));
      return;
    }
    setBusy(true);
    try {
      await client.deleteTerminalTheme(selected);
      const result = await themes.refetch();
      const next = result.data?.[0];
      setSelectedId(next?.id ?? '');
      setDraft(next ? copyInput(next) : undefined);
      setDeleteArmed(false);
      setMessage(x('terminalThemes.deleted'));
    } catch (cause) {
      setMessage(messageOf(cause, x));
    } finally {
      setBusy(false);
    }
  }

  async function importTheme() {
    if (busy) return;
    setBusy(true);
    setMessage('');
    let grantId = '';
    try {
      const grant = await client.createFileGrant('open-file');
      if (!grant) return;
      grantId = grant.grantId;
      const imported = await client.importTerminalTheme(grantId);
      const result = await themes.refetch();
      setCreating(false);
      setSelectedId(imported.id);
      setDraft(copyInput(imported));
      const index = result.data?.findIndex(({ id }) => id === imported.id) ?? -1;
      if (index >= 0) setPage(Math.floor(index / pageSize) + 1);
      setMessage(x('terminalThemes.imported'));
    } catch (cause) {
      setMessage(messageOf(cause, x));
    } finally {
      if (grantId) await client.revokeFileGrant(grantId).catch(() => undefined);
      setBusy(false);
    }
  }

  async function exportTheme() {
    if (!selected || busy) return;
    setBusy(true);
    setMessage('');
    let grantId = '';
    try {
      const grant = await client.createFileGrant('save-file');
      if (!grant) return;
      grantId = grant.grantId;
      const result = await client.exportTerminalTheme(selected.id, grantId);
      setMessage(x('terminalThemes.exportedBytes', { bytes: result.bytes }));
    } catch (cause) {
      setMessage(messageOf(cause, x));
    } finally {
      if (grantId) await client.revokeFileGrant(grantId).catch(() => undefined);
      setBusy(false);
    }
  }

  async function applyVisual() {
    if (!selected || busy) return;
    const visual: TerminalVisualSettings = { themeId: selected.id, background };
    setBusy(true);
    setMessage('');
    try {
      if (scope === 'session') {
        if (!activeTerminalId) throw new Error(x('terminalThemes.noActiveSession'));
        setTerminalVisual(activeTerminalId, visual);
        setMessage(x('terminalThemes.appliedSession'));
      } else {
        if (!settings.data) throw new Error(x('terminalThemes.settingsNotLoaded'));
        await client.updateSettings(settings.data, { terminal: { visual } });
        await settings.refetch();
        setMessage(x('terminalThemes.appliedGlobal'));
      }
      pendingAssetId.current = undefined;
      setTerminalVisualPreview(undefined);
    } catch (cause) {
      setMessage(messageOf(cause, x));
      await settings.refetch();
    } finally {
      setBusy(false);
    }
  }

  async function chooseBackgroundImage() {
    if (busy) return;
    setBusy(true);
    setMessage('');
    let grantId = '';
    try {
      const grant = await client.createFileGrant('open-file');
      if (!grant) return;
      grantId = grant.grantId;
      const asset = await client.importTerminalBackgroundAsset(grantId);
      if (pendingAssetId.current)
        await client.deleteTerminalBackgroundAsset(pendingAssetId.current).catch(() => undefined);
      pendingAssetId.current = asset.id;
      setBackground({ ...background, kind: 'image', assetId: asset.id });
      setMessage(x('terminalThemes.backgroundReady', { bytes: asset.bytes }));
    } catch (cause) {
      setMessage(messageOf(cause, x));
    } finally {
      if (grantId) await client.revokeFileGrant(grantId).catch(() => undefined);
      setBusy(false);
    }
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
    if (activeAiRunRef.current) void client.cancelAi(activeAiRunRef.current).catch(() => undefined);
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
    if (!selectedAiModelId || !aiDescription.trim() || aiGenerating) return;
    const request = ++aiRequestRef.current;
    setAiGenerating(true);
    setMessage('');
    try {
      const started = await client.startAi({
        modelId: selectedAiModelId,
        useCase: 'createTheme',
        prompt: aiDescription.trim(),
        context: draft ? JSON.stringify(draft) : '',
      });
      activeAiRunRef.current = started.id;
      let run = started;
      const deadline = Date.now() + 30_000;
      while (
        aiRequestRef.current === request &&
        !['succeeded', 'failed', 'canceled'].includes(run.state) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        if (aiRequestRef.current !== request) return;
        run = await client.aiRun(started.id);
      }
      if (aiRequestRef.current !== request) return;
      if (!['succeeded', 'failed', 'canceled'].includes(run.state)) {
        await client.cancelAi(started.id);
        throw new Error(x('terminalThemes.aiTimeout'));
      }
      if (run.state !== 'succeeded' || !run.result)
        throw new Error(
          run.errorCode === 'AI_OUTPUT_INVALID'
            ? x('terminalThemes.aiInvalid')
            : x('terminalThemes.aiFailed'),
        );
      setDraft(parseAiThemeDraft(run.result));
      setPreviewOpen(true);
      setSelectedId('');
      setCreating(true);
      setAiDraftActive(true);
      setAiOpen(false);
      setMessage(x('terminalThemes.aiPreviewReady'));
    } catch (cause) {
      setMessage(messageOf(cause, x));
    } finally {
      if (aiRequestRef.current === request) {
        activeAiRunRef.current = undefined;
        setAiGenerating(false);
      }
    }
  }

  const terminal = draft?.terminal;
  return (
    <div className="terminal-theme-workspace">
      <aside className="terminal-theme-list" aria-label={x('terminalThemes.list')}>
        <div className="terminal-theme-list-actions">
          <button
            type="button"
            title={x('terminalThemes.createWithAi')}
            aria-label={x('terminalThemes.createWithAi')}
            onClick={openAiGenerator}
          >
            <Bot size={15} />
          </button>
          <button
            type="button"
            title={x('terminalThemes.new')}
            aria-label={x('terminalThemes.new')}
            onClick={createNew}
          >
            <Plus size={15} />
          </button>
          <button
            type="button"
            title={x('terminalThemes.import')}
            aria-label={x('terminalThemes.import')}
            onClick={importTheme}
          >
            <Upload size={15} />
          </button>
        </div>
        <label className="terminal-theme-search">
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
        <p className="terminal-theme-current">
          <Check size={14} aria-hidden="true" />
          {selected?.name ?? (creating ? x('terminalThemes.newTheme') : x('terminalThemes.select'))}
        </p>
        <div className="terminal-theme-list-scroll">
          <button
            className={`terminal-theme-list-item new ${creating ? 'active' : ''}`}
            type="button"
            onClick={createNew}
          >
            <Plus size={14} /> {x('terminalThemes.newTheme')}
          </button>
          {visibleThemes.map((theme) => (
            <button
              className={`terminal-theme-list-item ${selected?.id === theme.id ? 'active' : ''}`}
              key={theme.id}
              type="button"
              onClick={() => selectTheme(theme)}
            >
              <span className="terminal-theme-mode" style={{ background: theme.ui.main }} />
              <span>{theme.name}</span>
              {theme.builtIn && <small>{x('terminalThemes.builtIn')}</small>}
            </button>
          ))}
          {!filtered.length && (
            <p className="terminal-theme-empty">{x('terminalThemes.noMatches')}</p>
          )}
        </div>
        {!!filtered.length && (
          <nav className="terminal-theme-pagination" aria-label={x('terminalThemes.pagination')}>
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
              <span className="sr-only">{x('terminalThemes.pageSize')}</span>
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
      <main className="terminal-theme-editor">
        {aiOpen && (
          <section className="terminal-theme-ai" aria-label={x('terminalThemes.aiGenerator')}>
            <div className="terminal-theme-ai-heading">
              <span>
                <Bot size={18} />
              </span>
              <div>
                <strong>{x('terminalThemes.aiTitle')}</strong>
                <p>{x('terminalThemes.aiHint')}</p>
              </div>
            </div>
            <div className="terminal-theme-ai-fields">
              <label>
                {x('terminalThemes.aiModel')}
                <select
                  aria-label={x('terminalThemes.aiModel')}
                  value={selectedAiModelId}
                  onChange={(event) => setAiModelId(event.target.value)}
                >
                  <option value="">{x('terminalThemes.aiSelectModel')}</option>
                  {(models.data ?? []).map((model) => (
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
            <p className="terminal-theme-ai-safety">
              <ShieldCheck size={14} /> {x('terminalThemes.aiSafety')}
            </p>
            {!models.isLoading && !models.data?.length && (
              <p className="terminal-theme-message">{x('terminalThemes.aiNoModels')}</p>
            )}
            <div className="terminal-theme-ai-actions">
              <button type="button" onClick={discardAiDraft}>
                {x('common.cancel')}
              </button>
              <button
                className="primary"
                disabled={aiGenerating || !selectedAiModelId || !aiDescription.trim()}
                type="button"
                onClick={() => void generateAiTheme()}
              >
                {aiGenerating ? <LoaderCircle className="spin" size={14} /> : <Bot size={14} />}
                {aiGenerating ? x('terminalThemes.aiGenerating') : x('terminalThemes.aiGenerate')}
              </button>
            </div>
          </section>
        )}
        {draft && terminal ? (
          <form onSubmit={(event) => void save(event)}>
            {aiDraftActive && (
              <div className="terminal-theme-ai-preview-notice" role="status">
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
            <header className="terminal-theme-editor-header">
              <div>
                <p>{x('terminalThemes.eyebrow')}</p>
                <h2>{creating ? x('terminalThemes.newTheme') : selected?.name}</h2>
              </div>
              {creating ? (
                <button
                  className="terminal-theme-library"
                  type="button"
                  onClick={() => void client.openExternal('https://theme.electerm.org')}
                >
                  <ExternalLink size={13} /> https://theme.electerm.org <Link size={12} />
                </button>
              ) : (
                <div className="terminal-theme-editor-actions">
                  <label className="terminal-theme-scope">
                    <span className="sr-only">{x('terminalThemes.scope')}</span>
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
                    className="primary"
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
                      <button type="button" onClick={() => void exportTheme()} disabled={busy}>
                        <Download size={14} /> {x('terminalThemes.export')}
                      </button>
                    </>
                  )}
                  {selected && !selected.builtIn && (
                    <button
                      className={deleteArmed ? 'danger' : ''}
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
                className="terminal-theme-preview"
                aria-label={x('terminalThemes.preview')}
                style={{ background: terminal.background, color: terminal.foreground }}
              >
                <div className="terminal-theme-preview-bar" style={{ background: draft.ui.main }}>
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
                <div className="terminal-theme-ansi" aria-label={x('terminalThemes.ansiPalette')}>
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
            <label className="terminal-theme-name">
              {x('terminalThemes.name')}
              <input
                required
                maxLength={30}
                disabled={selected?.builtIn}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <div className="terminal-theme-config-header">
              <strong>{x('terminalThemes.config')}</strong>
              <div>
                <button type="button" onClick={() => void importTheme()} disabled={busy}>
                  <Upload size={13} /> {x('terminalThemes.importFile')}
                </button>
                {!selected?.builtIn && (
                  <button className="primary" type="submit" disabled={busy}>
                    {x('common.save')}
                  </button>
                )}
              </div>
            </div>
            <div
              className="terminal-theme-editor-mode"
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
              <button type="button" role="tab" aria-selected={false} onClick={openAiGenerator}>
                <Bot size={13} /> AI
              </button>
            </div>
            <div className="terminal-theme-color-sections">
              <ThemeColorSection
                title={x('terminalThemes.interfaceColors')}
                entries={uiColorLabels}
                values={draft.ui}
                mode={colorEditorMode}
                disabled={selected?.builtIn === true}
                onChange={(key, value) => setDraft({ ...draft, ui: { ...draft.ui, [key]: value } })}
              />
              <ThemeColorSection
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
            <fieldset className="terminal-background-editor">
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
                <div className="terminal-background-filters">
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
              <p className="terminal-theme-help">{x('terminalThemes.builtInReadOnly')}</p>
            )}
            {message && <p className="terminal-theme-message">{message}</p>}
          </form>
        ) : (
          <p className="terminal-theme-empty">{x('terminalThemes.loading')}</p>
        )}
      </main>
    </div>
  );
}

function ThemeColorSection<K extends string>({
  title,
  entries,
  values,
  mode,
  disabled,
  onChange,
}: {
  title: string;
  entries: Array<[K, AxtermMessageKey]>;
  values: Record<K, string>;
  mode: 'picker' | 'text';
  disabled: boolean;
  onChange(key: K, value: string): void;
}) {
  const { x } = useI18n();
  return (
    <fieldset className="terminal-theme-color-section">
      <legend>{title}</legend>
      <div className="terminal-theme-color-grid">
        {entries.map(([key, label]) => (
          <label key={key}>
            <span>{x(label)}</span>
            {mode === 'picker' ? (
              <input
                className="terminal-theme-color-picker"
                type="color"
                aria-label={`${title} ${x(label)}`}
                disabled={disabled || !/^#[\da-f]{6}$/iu.test(values[key])}
                value={/^#[\da-f]{6}$/iu.test(values[key]) ? values[key] : '#808080'}
                onChange={(event) => onChange(key, event.target.value)}
              />
            ) : (
              <span className="terminal-theme-color-control">
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

function messageOf(cause: unknown, x: ReturnType<typeof useI18n>['x']): string {
  return cause instanceof Error ? cause.message : x('common.operationFailed');
}
