import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { createRuntimeClient } from '@workspace/client';
import type {
  CommandHistoryItem,
  TerminalAppearance,
  TerminalBackground,
  TerminalBehavior,
  TerminalRecording,
  ShortcutActionId,
  TerminalTransferState,
  TerminalTheme,
} from '@workspace/contracts';
import type { FileGrant } from '@workspace/contracts/desktop';
import { useWorkspace } from '../stores/workspace';
import { resolveTerminalBehavior } from './terminal-behavior';
import {
  installTerminalCapabilities,
  type TerminalCapabilityFeedbackCode,
  type TerminalCapabilityState,
} from './terminal-capabilities';
import { TerminalContextMenu } from './terminal-context-menu';
import {
  clampTerminalContextMenu,
  DEFAULT_TERMINAL_SEARCH_OPTIONS,
  TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
  TERMINAL_SEARCH_QUERY_LIMIT,
  toggleTerminalSearchOption,
  type TerminalContextMenuPosition,
  type TerminalSearchOptions,
  type TerminalSearchResults,
  type TerminalSearchErrorCode,
  validateTerminalSearch,
} from './terminal-interaction';
import {
  decodeTerminalMessage,
  TerminalInputSender,
  type TerminalInputIssue,
} from './terminal-protocol';
import { resolveTerminalAppearance } from './terminal-appearance';
import { terminalBackspaceSequence, terminalShiftEnterSequence } from './terminal-key-input';
import {
  createTerminalOutputDecoder,
  decodeTerminalOutput,
  type TerminalOutputDecoder,
} from './terminal-output';
import { Osc52Addon, type Osc52FeedbackCode } from './terminal-osc52';
import {
  assessTerminalPaste,
  normalizeTerminalPaste,
  terminalPlatformFromUserAgent,
  type TerminalPasteReview,
} from './terminal-paste';
import { TerminalPasteDialog } from './terminal-paste-dialog';
import { TerminalSearchBar } from './terminal-search-bar';
import {
  TerminalCommandTrackerAddon,
  type TerminalCommandTrackingState,
} from './terminal-command-tracker';
import { formatUnixTimestampSelection, type TerminalPointerPosition } from './terminal-timestamp';
import { TerminalTimestampTooltip } from './terminal-timestamp-tooltip';
import {
  createRestoreCwdInput,
  createTerminalReloadState,
  getAlternateBufferSnapshot,
  type TerminalReloadState,
} from './terminal-reload-state';
import { resolveTerminalShortcutCursorMode } from './terminal-shortcut-bar-model';
import {
  parseAiCommandSuggestions,
  rankTerminalCommandSuggestions,
  setBoundedSuggestionCache,
  terminalSuggestionInsertion,
  TERMINAL_SUGGESTION_DEBOUNCE_MS,
  TerminalPromptInputModel,
  type TerminalCommandSuggestion,
  type TerminalPromptInputSnapshot,
} from './terminal-command-suggestions-model';
import {
  TerminalCommandSuggestions,
  type TerminalCommandSuggestionsState,
} from './terminal-command-suggestions';
import { TerminalFileDropDialog } from './terminal-file-drop-dialog';
import {
  TERMINAL_DROP_MAX_FILES,
  terminalDroppedFilesError,
  terminalDropRemotePath,
  type TerminalDropBehavior,
  type TerminalDroppedFilesErrorCode,
} from './terminal-file-drop-model';
import '@xterm/xterm/css/xterm.css';
import { useI18n } from '../i18n/context';

export interface TerminalViewHandle {
  fit(): void;
  focus(): void;
  openSearch(): void;
  getCwd(): string;
  captureReloadState(): TerminalReloadState | undefined;
  sendShortcut(data: string): boolean;
  sendBatchInput(data: string): boolean;
  runShortcutAction(action: TerminalShortcutActionId): boolean;
}

export type TerminalShortcutActionId = Extract<ShortcutActionId, `terminal_${string}`>;

interface TerminalViewProps {
  terminalId: string;
  client: ReturnType<typeof createRuntimeClient>;
  active: boolean;
  kind: 'local' | 'ssh' | 'telnet' | 'serial';
  connectionId?: string | undefined;
  appearance?: TerminalAppearance | undefined;
  behavior?: TerminalBehavior | undefined;
  theme?: TerminalTheme['terminal'] | undefined;
  background?: TerminalBackground | undefined;
  encodingOverride?: TerminalBehavior['encoding'] | undefined;
  commandHistoryEnabled?: boolean | undefined;
  screenReaderMode?: boolean | undefined;
  commandSuggestionsEnabled?: boolean | undefined;
  dragDropBehavior?: TerminalDropBehavior | undefined;
  aiSuggestionsAvailable?: boolean | undefined;
  onRequestAiSuggestions?(prefix: string, terminalId: string, signal: AbortSignal): Promise<string>;
  onExplainSelection?(selection: string, terminalId: string): Promise<void>;
  onCommandHistoryChanged?(): void;
  onTransfersChanged?(): void;
  consumeReloadState?(terminalId: string): TerminalReloadState | undefined;
}

interface TerminalContextMenuState extends TerminalContextMenuPosition {
  hasSelection: boolean;
}

interface TerminalActionFeedback {
  message: string;
  tone: 'success' | 'error';
}

interface TerminalTimestampTooltipState {
  pointer: TerminalPointerPosition;
  text: string;
}

const EMPTY_SEARCH_RESULTS: TerminalSearchResults = { resultIndex: -1, resultCount: 0 };
const SEARCH_DECORATIONS = {
  matchBackground: '#5c4b16',
  matchBorder: '#f3c409',
  matchOverviewRuler: '#f3c409',
  activeMatchBackground: '#7c2d12',
  activeMatchBorder: '#f97316',
  activeMatchColorOverviewRuler: '#f34309',
};
const DEFAULT_XTERM_THEME = {
  background: '#0b1114',
  foreground: '#d6dde2',
  cursor: '#78e39b',
  cursorAccent: '#0b1114',
  selectionBackground: 'rgba(88, 199, 217, 0.28)',
  black: '#1c252b',
  red: '#f07178',
  green: '#84d99c',
  yellow: '#e7c66b',
  blue: '#69a7e3',
  magenta: '#bd93d8',
  cyan: '#65c9d5',
  white: '#d8e0e5',
  brightBlack: '#66737b',
  brightRed: '#ff8b92',
  brightGreen: '#9beaaf',
  brightYellow: '#f4d980',
  brightBlue: '#82baf0',
  brightMagenta: '#d2a8ea',
  brightCyan: '#7edce5',
  brightWhite: '#f2f6f8',
} as const;

function xtermTheme(
  theme: TerminalTheme['terminal'] | undefined,
  background: TerminalBackground | undefined,
) {
  return {
    ...DEFAULT_XTERM_THEME,
    ...theme,
    ...(background && background.kind !== 'none' ? { background: 'rgba(0, 0, 0, 0)' } : {}),
  };
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(function TerminalView(
  {
    terminalId,
    client,
    active,
    kind,
    connectionId,
    appearance,
    behavior,
    theme,
    background,
    encodingOverride,
    commandHistoryEnabled = false,
    screenReaderMode = false,
    commandSuggestionsEnabled = false,
    dragDropBehavior = 'ask',
    aiSuggestionsAvailable = false,
    onRequestAiSuggestions,
    onExplainSelection,
    onCommandHistoryChanged,
    onTransfersChanged,
    consumeReloadState,
  },
  ref,
) {
  const { t, x } = useI18n();
  const xRef = useRef(x);
  xRef.current = x;
  const container = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const inputSenderRef = useRef<TerminalInputSender | undefined>(undefined);
  const terminalClientId = useRef(crypto.randomUUID());
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const themeRef = useRef(theme);
  const backgroundRef = useRef(background);
  const serializeRef = useRef<SerializeAddon | undefined>(undefined);
  const cwdRef = useRef('');
  const reloadStateRef = useRef<TerminalReloadState | undefined>(undefined);
  const reloadStateLoadedRef = useRef(false);
  const commandHistoryEnabledRef = useRef(commandHistoryEnabled);
  const screenReaderModeRef = useRef(screenReaderMode);
  const commandSuggestionsEnabledRef = useRef(commandSuggestionsEnabled);
  const aiSuggestionsAvailableRef = useRef(aiSuggestionsAvailable);
  const onRequestAiSuggestionsRef = useRef(onRequestAiSuggestions);
  const commandHistoryChangedRef = useRef(onCommandHistoryChanged);
  const commandInputRef = useRef(new TerminalPromptInputModel());
  const commandSuggestionTimerRef = useRef<number | undefined>(undefined);
  const commandSuggestionRequestRef = useRef(0);
  const commandSuggestionHistoryRevisionRef = useRef<number | undefined>(undefined);
  const commandSuggestionHistoryCacheRef = useRef(
    new Map<string, { revision: number; items: CommandHistoryItem[] }>(),
  );
  const commandSuggestionHistoryItemsRef = useRef<CommandHistoryItem[]>([]);
  const commandSuggestionAiCacheRef = useRef(new Map<string, string[]>());
  const commandSuggestionAiControllerRef = useRef<AbortController | undefined>(undefined);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const pointerPositionRef = useRef<TerminalPointerPosition>({ x: 0, y: 0 });
  const pendingPasteTextRef = useRef<string | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | undefined>(undefined);
  const activeRef = useRef(active);
  const searchRef = useRef<SearchAddon | undefined>(undefined);
  const searchResultsSubscriptionRef = useRef<{ dispose(): void } | undefined>(undefined);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchOpenRef = useRef(searchOpen);
  const [searchQuery, setSearchQuery] = useState('');
  const searchQueryRef = useRef(searchQuery);
  const [searchOptions, setSearchOptions] = useState<TerminalSearchOptions>(
    DEFAULT_TERMINAL_SEARCH_OPTIONS,
  );
  const searchOptionsRef = useRef(searchOptions);
  const [searchResults, setSearchResults] = useState<TerminalSearchResults>(EMPTY_SEARCH_RESULTS);
  const [searchError, setSearchError] = useState<string>();
  const [contextMenu, setContextMenu] = useState<TerminalContextMenuState>();
  const [actionFeedback, setActionFeedback] = useState<TerminalActionFeedback>();
  const [recording, setRecording] = useState<TerminalRecording>();
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [terminalTransfer, setTerminalTransfer] = useState<TerminalTransferState | null>(null);
  const [backgroundImageUrl, setBackgroundImageUrl] = useState('');
  const transferSelectionBusyRef = useRef(false);
  const [pendingPaste, setPendingPaste] = useState<TerminalPasteReview>();
  const [capabilityState, setCapabilityState] = useState<TerminalCapabilityState>();
  const [connectionState, setConnectionState] = useState<
    'connecting' | 'connected' | 'disconnected' | 'error'
  >('connecting');
  const [inputFeedback, setInputFeedback] = useState('');
  const [commandTrackingState, setCommandTrackingState] =
    useState<TerminalCommandTrackingState>('pending');
  const [commandSuggestions, setCommandSuggestions] = useState<TerminalCommandSuggestionsState>();
  const commandSuggestionsRef = useRef(commandSuggestions);
  const importedDropGrantsRef = useRef(new Set<string>());
  const dropImportControllerRef = useRef<AbortController | undefined>(undefined);
  const dragDepthRef = useRef(0);
  const [dropActive, setDropActive] = useState(false);
  const [dropPreparing, setDropPreparing] = useState<string[]>();
  const [dropDialog, setDropDialog] = useState<{ grants: FileGrant[] }>();
  const [timestampTooltip, setTimestampTooltip] = useState<TerminalTimestampTooltipState>();
  const [normalBufferLines, setNormalBufferLines] = useState<string[]>();
  const [sessionFontSize, setSessionFontSize] = useState<number>();
  const insertion = useWorkspace((state) => state.insertion);
  const effectiveAppearance = useMemo(() => resolveTerminalAppearance(appearance), [appearance]);
  const effectiveBehavior = useMemo(() => resolveTerminalBehavior(behavior), [behavior]);
  const activeEncoding = encodingOverride ?? effectiveBehavior.encoding;
  const outputDecoderRef = useRef<TerminalOutputDecoder | undefined>(undefined);
  if (!outputDecoderRef.current)
    outputDecoderRef.current = createTerminalOutputDecoder(activeEncoding);
  activeRef.current = active;
  searchOpenRef.current = searchOpen;
  searchQueryRef.current = searchQuery;
  searchOptionsRef.current = searchOptions;
  commandHistoryEnabledRef.current = commandHistoryEnabled;
  screenReaderModeRef.current = screenReaderMode;
  commandSuggestionsEnabledRef.current = commandSuggestionsEnabled;
  themeRef.current = theme;
  backgroundRef.current = background;

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.screenReaderMode = screenReaderMode;
  }, [screenReaderMode]);

  useEffect(() => {
    let canceled = false;
    let objectUrl = '';
    if (background?.kind !== 'image' || !background.assetId) {
      setBackgroundImageUrl('');
      return;
    }
    void client
      .terminalBackgroundAssetBlob(background.assetId)
      .then((blob) => {
        if (canceled) return;
        objectUrl = URL.createObjectURL(blob);
        setBackgroundImageUrl(objectUrl);
      })
      .catch(() => {
        if (!canceled) setBackgroundImageUrl('');
      });
    return () => {
      canceled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [background?.assetId, background?.kind, client]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = xtermTheme(theme, background);
  }, [background, theme]);
  aiSuggestionsAvailableRef.current = aiSuggestionsAvailable;
  onRequestAiSuggestionsRef.current = onRequestAiSuggestions;
  commandHistoryChangedRef.current = onCommandHistoryChanged;
  commandSuggestionsRef.current = commandSuggestions;

  const reportInputIssue = useCallback((issue: TerminalInputIssue) => {
    const key =
      issue === 'TERMINAL_INPUT_TOO_LARGE'
        ? 'terminal.inputTooLarge'
        : issue === 'TERMINAL_INPUT_QUEUE_FULL'
          ? 'terminal.inputQueueFull'
          : issue === 'TERMINAL_INPUT_CANCELED'
            ? 'terminal.inputCanceled'
            : 'terminal.inputUnavailable';
    const message = xRef.current(key);
    setInputFeedback(message);
    terminalRef.current?.writeln(`\r\n\x1b[33m[${message}]\x1b[0m`);
  }, []);

  const sendTerminalInput = useCallback(
    (text: string) => {
      const sender = inputSenderRef.current;
      if (!sender) {
        reportInputIssue('TERMINAL_INPUT_UNAVAILABLE');
        return false;
      }
      const accepted = sender.enqueue(text);
      if (accepted) setInputFeedback('');
      return accepted;
    },
    [reportInputIssue],
  );

  const reportAction = useCallback((message: string, tone: 'success' | 'error') => {
    setActionFeedback({ message, tone });
  }, []);

  const terminalSearchError = useCallback((code: TerminalSearchErrorCode | undefined) => {
    if (!code) return undefined;
    if (code === 'QUERY_TOO_LONG')
      return xRef.current('terminal.searchQueryTooLong', { limit: TERMINAL_SEARCH_QUERY_LIMIT });
    if (code === 'REGEX_MATCHES_EMPTY') return xRef.current('terminal.searchRegexMatchesEmpty');
    return xRef.current('terminal.searchInvalidRegex');
  }, []);

  const terminalDropError = useCallback((code: TerminalDroppedFilesErrorCode) => {
    switch (code) {
      case 'DIRECTORY_UNSUPPORTED':
        return xRef.current('terminal.dropDirectoryUnsupported');
      case 'NO_FILES':
        return xRef.current('terminal.dropNoFiles');
      case 'TOO_MANY_FILES':
        return xRef.current('terminal.dropTooManyFiles', { limit: TERMINAL_DROP_MAX_FILES });
      case 'UNSAFE_FILE_NAME':
        return xRef.current('terminal.dropUnsafeFileName');
      case 'INVALID_FILE_SIZE':
        return xRef.current('terminal.dropInvalidFileSize');
      case 'FILE_TOO_LARGE':
        return xRef.current('terminal.dropFileTooLarge');
      case 'TOTAL_TOO_LARGE':
        return xRef.current('terminal.dropTotalTooLarge');
    }
  }, []);

  const terminalCapabilityFeedback = useCallback((code: TerminalCapabilityFeedbackCode) => {
    const key =
      code === 'WEBGL_CONTEXT_LOST'
        ? 'terminal.webglContextLost'
        : code === 'WEBGL_UNAVAILABLE'
          ? 'terminal.webglUnavailable'
          : code === 'UNICODE_11_UNAVAILABLE'
            ? 'terminal.unicode11Unavailable'
            : code === 'LIGATURES_UNAVAILABLE'
              ? 'terminal.ligaturesUnavailable'
              : 'terminal.imagesUnavailable';
    return xRef.current(key);
  }, []);

  const osc52Feedback = useCallback((code: Osc52FeedbackCode) => {
    const keys = {
      DISABLED: 'terminal.osc52Disabled',
      MALFORMED_REQUEST: 'terminal.osc52Malformed',
      UNSUPPORTED_TARGET: 'terminal.osc52UnsupportedTarget',
      READ_DENIED: 'terminal.osc52ReadDenied',
      WRITE_DENIED: 'terminal.osc52WriteDenied',
      INVALID_BASE64: 'terminal.osc52InvalidBase64',
      INVALID_UTF8: 'terminal.osc52InvalidUtf8',
      PAYLOAD_TOO_LARGE: 'terminal.osc52PayloadTooLarge',
      RESPONSE_TOO_LARGE: 'terminal.osc52ResponseTooLarge',
      CLIPBOARD_UNAVAILABLE: 'terminal.clipboardUnavailable',
      CLIPBOARD_TIMEOUT: 'terminal.osc52ClipboardTimeout',
      CLIPBOARD_FAILED: 'terminal.osc52ClipboardFailed',
      INPUT_UNAVAILABLE: 'terminal.osc52InputUnavailable',
      READ_SUCCEEDED: 'terminal.osc52ReadSucceeded',
      WRITE_SUCCEEDED: 'terminal.osc52WriteSucceeded',
    } as const;
    return xRef.current(keys[code]);
  }, []);

  const revokeDroppedGrants = useCallback(
    async (grants: readonly FileGrant[]) => {
      await Promise.allSettled(
        grants.map(async (grant) => {
          importedDropGrantsRef.current.delete(grant.grantId);
          await client.revokeFileGrant(grant.grantId);
        }),
      );
    },
    [client],
  );

  const performDropAction = useCallback(
    async (action: Exclude<TerminalDropBehavior, 'ask'>, grants: FileGrant[]) => {
      setDropDialog(undefined);
      if (action === 'path-insert') {
        try {
          await client.insertGrantedTerminalPaths(
            terminalId,
            grants.map((grant) => grant.grantId),
          );
          for (const grant of grants) importedDropGrantsRef.current.delete(grant.grantId);
          reportAction(
            xRef.current('terminal.insertedTemporaryPaths', { count: grants.length }),
            'success',
          );
        } catch (cause) {
          await revokeDroppedGrants(grants);
          reportAction(
            cause instanceof Error ? cause.message : xRef.current('terminal.insertPathsError'),
            'error',
          );
        } finally {
          terminalRef.current?.focus();
        }
        return;
      }

      if (kind !== 'ssh' || !connectionId) {
        await revokeDroppedGrants(grants);
        reportAction(xRef.current('terminal.noSftpConnection'), 'error');
        terminalRef.current?.focus();
        return;
      }
      let queued = 0;
      try {
        for (const grant of grants) {
          await client.createTransfer(connectionId, 'upload', {
            grantId: grant.grantId,
            remotePath: terminalDropRemotePath(cwdRef.current, grant.name),
            recursive: false,
            conflict: 'skip',
          });
          importedDropGrantsRef.current.delete(grant.grantId);
          queued += 1;
        }
        onTransfersChanged?.();
        reportAction(xRef.current('terminal.queuedUploads', { count: queued }), 'success');
      } catch (cause) {
        await revokeDroppedGrants(grants.slice(queued));
        if (queued) onTransfersChanged?.();
        reportAction(
          cause instanceof Error ? cause.message : xRef.current('terminal.createUploadError'),
          'error',
        );
      } finally {
        terminalRef.current?.focus();
      }
    },
    [client, connectionId, kind, onTransfersChanged, reportAction, revokeDroppedGrants, terminalId],
  );

  const cancelDropDialog = useCallback(() => {
    const grants = dropDialog?.grants ?? [];
    setDropDialog(undefined);
    void revokeDroppedGrants(grants);
    reportAction(xRef.current('terminal.dropCanceled'), 'success');
    terminalRef.current?.focus();
  }, [dropDialog?.grants, reportAction, revokeDroppedGrants]);

  const cancelDroppedFileImport = useCallback(() => {
    dropImportControllerRef.current?.abort();
  }, []);

  const handleTerminalFileDrop = useCallback(
    async (event: ReactDragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = 0;
      setDropActive(false);
      const files = [...event.dataTransfer.files];
      const includesDirectory = [...event.dataTransfer.items].some(
        (item) => item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory,
      );
      const validationError = terminalDroppedFilesError(files, includesDirectory);
      if (validationError) {
        reportAction(terminalDropError(validationError), 'error');
        return;
      }
      if (dragDropBehavior === 'upload' && (kind !== 'ssh' || !connectionId)) {
        reportAction(xRef.current('terminal.noSftpConnection'), 'error');
        return;
      }

      dropImportControllerRef.current?.abort();
      const controller = new AbortController();
      dropImportControllerRef.current = controller;
      setDropPreparing(files.map((file) => file.name));
      const grants: FileGrant[] = [];
      try {
        for (const file of files) {
          const grant = await client.importDroppedFile(file, controller.signal);
          grants.push(grant);
          importedDropGrantsRef.current.add(grant.grantId);
        }
        if (controller.signal.aborted) throw new DOMException('File import canceled', 'AbortError');
        if (dragDropBehavior === 'ask') setDropDialog({ grants });
        else await performDropAction(dragDropBehavior, grants);
      } catch (cause) {
        await revokeDroppedGrants(grants);
        reportAction(
          controller.signal.aborted
            ? xRef.current('terminal.dropCanceled')
            : cause instanceof Error
              ? cause.message
              : xRef.current('terminal.dropReadError'),
          controller.signal.aborted ? 'success' : 'error',
        );
      } finally {
        if (dropImportControllerRef.current === controller)
          dropImportControllerRef.current = undefined;
        setDropPreparing(undefined);
      }
    },
    [
      client,
      connectionId,
      dragDropBehavior,
      kind,
      performDropAction,
      reportAction,
      revokeDroppedGrants,
      terminalDropError,
    ],
  );

  const cancelCommandSuggestionWork = useCallback(() => {
    if (commandSuggestionTimerRef.current !== undefined) {
      window.clearTimeout(commandSuggestionTimerRef.current);
      commandSuggestionTimerRef.current = undefined;
    }
    commandSuggestionRequestRef.current += 1;
    commandSuggestionAiControllerRef.current?.abort();
    commandSuggestionAiControllerRef.current = undefined;
  }, []);

  const closeCommandSuggestions = useCallback(() => {
    cancelCommandSuggestionWork();
    commandSuggestionsRef.current = undefined;
    setCommandSuggestions(undefined);
  }, [cancelCommandSuggestionWork]);

  const showCommandSuggestions = useCallback(
    (
      input: TerminalPromptInputSnapshot,
      history: CommandHistoryItem[],
      ai: readonly string[] = [],
      aiLoading = false,
      aiError?: string,
    ) => {
      const terminal = terminalRef.current;
      const surface = surfaceRef.current;
      if (!terminal || !surface || !activeRef.current) return closeCommandSuggestions();
      const placement = terminalCommandSuggestionPosition(terminal, surface);
      if (!placement) return closeCommandSuggestions();
      const items = rankTerminalCommandSuggestions(input.value, { ai, history }, placement.reverse);
      const aiAvailable = aiSuggestionsAvailableRef.current && !!onRequestAiSuggestionsRef.current;
      if (!items.length && !aiAvailable && !aiLoading && !aiError) return closeCommandSuggestions();
      const next: TerminalCommandSuggestionsState = {
        items,
        position: placement.position,
        reverse: placement.reverse,
        selectedIndex: -1,
        aiAvailable,
        aiLoading,
        ...(aiError ? { aiError } : {}),
      };
      commandSuggestionsRef.current = next;
      setCommandSuggestions(next);
    },
    [closeCommandSuggestions],
  );

  const refreshCommandSuggestions = useCallback(async () => {
    const input = commandInputRef.current.snapshot();
    if (
      !commandSuggestionsEnabledRef.current ||
      !activeRef.current ||
      !input?.value ||
      input.value !== input.value.trimStart()
    )
      return closeCommandSuggestions();

    const cached = commandSuggestionHistoryCacheRef.current.get(input.value);
    if (cached && cached.revision === commandSuggestionHistoryRevisionRef.current) {
      commandSuggestionHistoryItemsRef.current = cached.items;
      showCommandSuggestions(
        input,
        cached.items,
        commandSuggestionAiCacheRef.current.get(input.value),
      );
      return;
    }

    const requestId = ++commandSuggestionRequestRef.current;
    try {
      const page = await client.commandHistory({
        sort: 'frequency',
        search: input.value,
        limit: 200,
      });
      const current = commandInputRef.current.snapshot();
      if (
        requestId !== commandSuggestionRequestRef.current ||
        !current ||
        current.value !== input.value ||
        !commandSuggestionsEnabledRef.current ||
        !activeRef.current
      )
        return;
      if (commandSuggestionHistoryRevisionRef.current !== page.revision) {
        commandSuggestionHistoryCacheRef.current.clear();
        commandSuggestionHistoryRevisionRef.current = page.revision;
      }
      setBoundedSuggestionCache(commandSuggestionHistoryCacheRef.current, input.value, {
        revision: page.revision,
        items: page.items,
      });
      commandSuggestionHistoryItemsRef.current = page.items;
      showCommandSuggestions(
        input,
        page.items,
        commandSuggestionAiCacheRef.current.get(input.value),
      );
    } catch {
      if (requestId === commandSuggestionRequestRef.current) closeCommandSuggestions();
    }
  }, [client, closeCommandSuggestions, showCommandSuggestions]);

  const scheduleCommandSuggestions = useCallback(() => {
    if (commandSuggestionTimerRef.current !== undefined)
      window.clearTimeout(commandSuggestionTimerRef.current);
    commandSuggestionTimerRef.current = window.setTimeout(() => {
      commandSuggestionTimerRef.current = undefined;
      void refreshCommandSuggestions();
    }, TERMINAL_SUGGESTION_DEBOUNCE_MS);
  }, [refreshCommandSuggestions]);

  const selectCommandSuggestion = useCallback(
    (item: TerminalCommandSuggestion) => {
      const input = commandInputRef.current.snapshot();
      if (!input) return closeCommandSuggestions();
      const insertion = terminalSuggestionInsertion(input, item.command);
      if (insertion === undefined) return closeCommandSuggestions();
      const accepted = !insertion || sendTerminalInput(insertion);
      if (accepted) commandInputRef.current.replace(item.command);
      closeCommandSuggestions();
      terminalRef.current?.focus();
    },
    [closeCommandSuggestions, sendTerminalInput],
  );

  const deleteCommandSuggestion = useCallback(
    async (item: TerminalCommandSuggestion) => {
      if (!item.historyItem) return;
      try {
        await client.deleteCommandHistory(item.historyItem);
        commandSuggestionHistoryCacheRef.current.clear();
        commandSuggestionHistoryRevisionRef.current = undefined;
        commandSuggestionHistoryItemsRef.current = commandSuggestionHistoryItemsRef.current.filter(
          (history) => history.id !== item.historyItem?.id,
        );
        commandHistoryChangedRef.current?.();
        const input = commandInputRef.current.snapshot();
        if (input)
          showCommandSuggestions(
            input,
            commandSuggestionHistoryItemsRef.current,
            commandSuggestionAiCacheRef.current.get(input.value),
          );
      } catch {
        reportAction(xRef.current('terminal.deleteSuggestionError'), 'error');
      }
      terminalRef.current?.focus();
    },
    [client, reportAction, showCommandSuggestions],
  );

  const requestAiCommandSuggestions = useCallback(async () => {
    const request = onRequestAiSuggestionsRef.current;
    const input = commandInputRef.current.snapshot();
    if (!request || !input?.value) return;
    const cached = commandSuggestionAiCacheRef.current.get(input.value);
    if (cached) {
      showCommandSuggestions(input, commandSuggestionHistoryItemsRef.current, cached);
      return;
    }
    commandSuggestionAiControllerRef.current?.abort();
    const controller = new AbortController();
    commandSuggestionAiControllerRef.current = controller;
    showCommandSuggestions(input, commandSuggestionHistoryItemsRef.current, [], true);
    try {
      const response = await request(input.value, terminalId, controller.signal);
      const current = commandInputRef.current.snapshot();
      if (controller.signal.aborted || !current || current.value !== input.value) return;
      const suggestions = parseAiCommandSuggestions(response, input.value);
      setBoundedSuggestionCache(commandSuggestionAiCacheRef.current, input.value, suggestions);
      showCommandSuggestions(current, commandSuggestionHistoryItemsRef.current, suggestions);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const current = commandInputRef.current.snapshot();
      if (current?.value === input.value)
        showCommandSuggestions(
          current,
          commandSuggestionHistoryItemsRef.current,
          [],
          false,
          cause instanceof Error ? cause.message : xRef.current('terminal.aiSuggestionError'),
        );
    } finally {
      if (commandSuggestionAiControllerRef.current === controller)
        commandSuggestionAiControllerRef.current = undefined;
    }
  }, [showCommandSuggestions, terminalId]);

  const handleTerminalTransferState = useCallback(
    async (state: TerminalTransferState) => {
      setTerminalTransfer(state);
      if (state.state !== 'waiting-selection' || transferSelectionBusyRef.current) return;
      transferSelectionBusyRef.current = true;
      let grantId: string | undefined;
      try {
        const grant = await client.createFileGrant(
          state.direction === 'download' ? 'open-directory' : 'open-file',
        );
        if (!grant) {
          setTerminalTransfer(
            await client.performTerminalTransferAction(terminalId, { action: 'cancel' }),
          );
          return;
        }
        grantId = grant.grantId;
        setTerminalTransfer(
          await client.performTerminalTransferAction(terminalId, {
            action: 'provide-selection',
            protocol: state.protocol === 'trzsz' ? 'trzsz' : 'zmodem',
            grantId,
          }),
        );
      } catch {
        reportAction(xRef.current('terminal.startTransferError'), 'error');
        await client
          .performTerminalTransferAction(terminalId, { action: 'cancel' })
          .then(setTerminalTransfer)
          .catch(() => undefined);
      } finally {
        if (grantId) await client.revokeFileGrant(grantId).catch(() => undefined);
        transferSelectionBusyRef.current = false;
        terminalRef.current?.focus();
      }
    },
    [client, reportAction, terminalId],
  );

  const startXmodemTransfer = useCallback(
    async (direction: 'upload' | 'download') => {
      setContextMenu(undefined);
      transferSelectionBusyRef.current = true;
      let grantId: string | undefined;
      try {
        const grant = await client.createFileGrant(
          direction === 'upload' ? 'open-file' : 'open-directory',
        );
        if (!grant) return;
        grantId = grant.grantId;
        setTerminalTransfer(
          await client.performTerminalTransferAction(terminalId, {
            action: 'start',
            protocol: 'xmodem',
            direction,
            grantId,
            ...(direction === 'download' ? { fileName: 'xmodem-download.bin' } : {}),
          }),
        );
      } catch {
        reportAction(xRef.current('terminal.startXmodemError'), 'error');
      } finally {
        if (grantId) await client.revokeFileGrant(grantId).catch(() => undefined);
        transferSelectionBusyRef.current = false;
        terminalRef.current?.focus();
      }
    },
    [client, reportAction, terminalId],
  );

  const cancelTerminalTransfer = useCallback(async () => {
    try {
      setTerminalTransfer(
        await client.performTerminalTransferAction(terminalId, { action: 'cancel' }),
      );
    } catch {
      reportAction(xRef.current('terminal.cancelTransferError'), 'error');
    }
  }, [client, reportAction, terminalId]);

  useEffect(() => {
    let disposed = false;
    void Promise.allSettled([
      client.terminal(terminalId),
      client.terminalTransfer(terminalId),
    ]).then(([sessionResult, transferResult]) => {
      if (disposed) return;
      if (sessionResult.status === 'fulfilled') setRecording(sessionResult.value.recording);
      if (transferResult.status === 'fulfilled' && transferResult.value)
        void handleTerminalTransferState(transferResult.value);
    });
    return () => {
      disposed = true;
    };
  }, [client, handleTerminalTransferState, terminalId]);

  const startRecording = useCallback(
    async (includeRecent: boolean) => {
      setContextMenu(undefined);
      setRecordingBusy(true);
      let grantId: string | undefined;
      try {
        const grant = await client.createFileGrant('save-file');
        if (!grant) {
          terminalRef.current?.focus();
          return;
        }
        grantId = grant.grantId;
        if (recording?.state === 'active')
          setRecording(await client.stopTerminalRecording(terminalId));
        const started = await client.startTerminalRecording(terminalId, {
          grantId,
          timestamps: effectiveBehavior.logTimestamps,
          includeRecent,
        });
        setRecording(started);
        reportAction(
          includeRecent
            ? xRef.current('terminal.logSavedContinue', { fileName: started.fileName })
            : xRef.current('terminal.recordingStarted', { fileName: started.fileName }),
          'success',
        );
      } catch {
        reportAction(
          xRef.current(includeRecent ? 'terminal.saveLogError' : 'terminal.startRecordingError'),
          'error',
        );
      } finally {
        if (grantId) await client.revokeFileGrant(grantId).catch(() => undefined);
        setRecordingBusy(false);
        terminalRef.current?.focus();
      }
    },
    [client, effectiveBehavior.logTimestamps, recording?.state, reportAction, terminalId],
  );

  const stopRecording = useCallback(async () => {
    setContextMenu(undefined);
    setRecordingBusy(true);
    try {
      const stopped = await client.stopTerminalRecording(terminalId);
      setRecording(stopped);
      reportAction(
        stopped.state === 'error'
          ? xRef.current('terminal.logWriteFailed', { fileName: stopped.fileName })
          : xRef.current('terminal.logSaved', { fileName: stopped.fileName }),
        stopped.state === 'error' ? 'error' : 'success',
      );
    } catch {
      reportAction(xRef.current('terminal.stopRecordingError'), 'error');
    } finally {
      setRecordingBusy(false);
      terminalRef.current?.focus();
    }
  }, [client, reportAction, terminalId]);

  useEffect(() => {
    const outputDecoder = createTerminalOutputDecoder(activeEncoding);
    outputDecoderRef.current = outputDecoder;
    if (outputDecoder.fellBack)
      reportAction(
        xRef.current('terminal.encodingFallback', { encoding: activeEncoding }),
        'error',
      );
  }, [activeEncoding, reportAction]);

  const performSearch = useCallback(
    (
      direction: 'previous' | 'next',
      query = searchQueryRef.current,
      options = searchOptionsRef.current,
    ) => {
      const search = searchRef.current;
      const validationCode = validateTerminalSearch(query, options);
      const validationError = terminalSearchError(validationCode);
      setSearchError(validationError);
      if (!query || validationCode || !search) {
        search?.clearDecorations();
        setSearchResults(EMPTY_SEARCH_RESULTS);
        return;
      }
      try {
        const addonOptions = {
          ...options,
          incremental: direction === 'previous',
          decorations: SEARCH_DECORATIONS,
        };
        const found =
          direction === 'previous'
            ? search.findPrevious(query, addonOptions)
            : search.findNext(query, addonOptions);
        if (!found) setSearchResults(EMPTY_SEARCH_RESULTS);
      } catch {
        search.clearDecorations();
        setSearchError(xRef.current('terminal.searchUnavailable'));
        setSearchResults(EMPTY_SEARCH_RESULTS);
      }
    },
    [terminalSearchError],
  );

  const installSearchAddon = useCallback((terminal: Terminal) => {
    searchResultsSubscriptionRef.current?.dispose();
    searchRef.current?.dispose();
    const search = new SearchAddon({ highlightLimit: TERMINAL_SEARCH_HIGHLIGHT_LIMIT });
    terminal.loadAddon(search);
    searchResultsSubscriptionRef.current = search.onDidChangeResults((results) => {
      const query = searchQueryRef.current;
      if (!query || validateTerminalSearch(query, searchOptionsRef.current)) return;
      setSearchResults(results);
    });
    searchRef.current = search;
    return search;
  }, []);

  const openSearch = useCallback(() => {
    setContextMenu(undefined);
    setSearchOpen(true);
    if (searchOpenRef.current) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, []);

  const closeSearch = useCallback(() => {
    searchRef.current?.clearDecorations();
    setSearchResults(EMPTY_SEARCH_RESULTS);
    setSearchError(undefined);
    setSearchOpen(false);
    terminalRef.current?.focus();
  }, []);

  const copyTerminalSelection = useCallback(async () => {
    setContextMenu(undefined);
    const terminal = terminalRef.current;
    const selection = terminal?.getSelection() ?? '';
    if (!selection) {
      setActionFeedback({ message: xRef.current('terminal.noCopySelection'), tone: 'error' });
      terminal?.focus();
      return;
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard write is unavailable');
      await navigator.clipboard.writeText(selection);
      setActionFeedback({
        message: xRef.current('terminal.copiedCharacters', { count: selection.length }),
        tone: 'success',
      });
    } catch {
      setActionFeedback({ message: xRef.current('terminal.clipboardCopyError'), tone: 'error' });
    }
    terminal?.focus();
  }, []);

  const commitTerminalPaste = useCallback(
    (text: string) => {
      const terminal = terminalRef.current;
      if (!terminal || !inputSenderRef.current) {
        reportInputIssue('TERMINAL_INPUT_UNAVAILABLE');
        reportAction(xRef.current('terminal.pasteDisconnected'), 'error');
        terminal?.focus();
        return;
      }
      terminal.paste(text);
      reportAction(xRef.current('terminal.clipboardSent'), 'success');
      terminal.focus();
    },
    [reportAction, reportInputIssue],
  );

  const pasteIntoTerminal = useCallback(async () => {
    setContextMenu(undefined);
    const terminal = terminalRef.current;
    try {
      if (!navigator.clipboard?.readText) throw new Error('Clipboard read is unavailable');
      const text = normalizeTerminalPaste(
        await navigator.clipboard.readText(),
        kind,
        terminalPlatformFromUserAgent(navigator.userAgent),
      );
      if (!text) {
        reportAction(xRef.current('terminal.clipboardEmpty'), 'error');
        terminal?.focus();
        return;
      }
      const assessment = assessTerminalPaste(text, effectiveBehavior.pasteProtection);
      if (assessment.action === 'reject') {
        reportAction(xRef.current('terminal.pasteTooLarge'), 'error');
        terminal?.focus();
        return;
      }
      if (assessment.action === 'confirm') {
        pendingPasteTextRef.current = text;
        setPendingPaste(assessment.review);
        return;
      }
      commitTerminalPaste(text);
    } catch {
      reportAction(xRef.current('terminal.clipboardPasteError'), 'error');
      terminal?.focus();
    }
  }, [commitTerminalPaste, effectiveBehavior.pasteProtection, kind, reportAction]);

  const pasteSelectedIntoTerminal = useCallback(() => {
    setContextMenu(undefined);
    const terminal = terminalRef.current;
    const selection = terminal?.getSelection() ?? '';
    if (!selection) {
      reportAction(xRef.current('terminal.noPasteSelection'), 'error');
      terminal?.focus();
      return;
    }
    commitTerminalPaste(selection);
  }, [commitTerminalPaste, reportAction]);

  const explainSelectionWithAi = useCallback(async () => {
    setContextMenu(undefined);
    const terminal = terminalRef.current;
    const selection = terminal?.getSelection() ?? '';
    if (!selection || !onExplainSelection) {
      reportAction(
        xRef.current(selection ? 'terminal.configureAiFirst' : 'terminal.noExplainSelection'),
        'error',
      );
      terminal?.focus();
      return;
    }
    try {
      await onExplainSelection(selection, terminalId);
      reportAction(xRef.current('terminal.selectionSentToAi'), 'success');
    } catch (cause) {
      reportAction(
        cause instanceof Error ? cause.message : xRef.current('terminal.explainSelectionError'),
        'error',
      );
    } finally {
      terminal?.focus();
    }
  }, [onExplainSelection, reportAction, terminalId]);

  const selectTerminalBuffer = useCallback(() => {
    setContextMenu(undefined);
    const terminal = terminalRef.current;
    terminal?.selectAll();
    setActionFeedback({
      message: xRef.current(
        terminal?.hasSelection() ? 'terminal.bufferSelected' : 'terminal.bufferEmpty',
      ),
      tone: terminal?.hasSelection() ? 'success' : 'error',
    });
    terminal?.focus();
  }, []);

  const clearTerminalBuffer = useCallback(() => {
    setContextMenu(undefined);
    const terminal = terminalRef.current;
    searchRef.current?.clearDecorations();
    terminal?.clear();
    if (terminal) installSearchAddon(terminal);
    setSearchResults(EMPTY_SEARCH_RESULTS);
    if (searchOpenRef.current && searchQueryRef.current)
      performSearch('next', searchQueryRef.current, searchOptionsRef.current);
    setActionFeedback({ message: xRef.current('terminal.scrollbackCleared'), tone: 'success' });
    terminalRef.current?.focus();
  }, [installSearchAddon, performSearch]);

  const fitAndResize = useCallback(() => {
    const element = container.current;
    const terminal = terminalRef.current;
    const fitAddon = fitRef.current;
    if (!element || !terminal || !fitAddon || element.clientWidth < 2 || element.clientHeight < 2)
      return;
    try {
      fitAddon.fit();
    } catch {
      return;
    }
    const socket = socketRef.current;
    const lastSentSize = lastSentSizeRef.current;
    if (
      socket?.readyState === WebSocket.OPEN &&
      (!lastSentSize || lastSentSize.cols !== terminal.cols || lastSentSize.rows !== terminal.rows)
    ) {
      socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      lastSentSizeRef.current = { cols: terminal.cols, rows: terminal.rows };
    }
  }, []);

  const showNormalBuffer = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return false;
    const buffer = terminal.buffer.normal;
    const lines: string[] = [];
    let remainingCharacters = 256 * 1024;
    for (let index = buffer.length - 1; index >= 0 && lines.length < 2_000; index -= 1) {
      const line = buffer.getLine(index)?.translateToString(true) ?? '';
      if (!line && !lines.length) continue;
      const bounded = line.slice(-remainingCharacters);
      lines.unshift(bounded);
      remainingCharacters -= bounded.length;
      if (remainingCharacters <= 0) break;
    }
    if (!lines.length) {
      reportAction(xRef.current('terminal.normalBufferEmpty'), 'error');
      terminal.focus();
      return false;
    }
    setNormalBufferLines(lines);
    setContextMenu(undefined);
    return true;
  }, [reportAction]);

  const changeTerminalFontSize = useCallback(
    (offset: -1 | 1) => {
      const terminal = terminalRef.current;
      if (!terminal) return false;
      const current = terminal.options.fontSize ?? effectiveAppearance.fontSize;
      const next = Math.max(8, Math.min(72, current + offset));
      if (next === current) return false;
      terminal.options.fontSize = next;
      setSessionFontSize(next);
      window.requestAnimationFrame(fitAndResize);
      reportAction(xRef.current('terminal.currentFontSize', { size: next }), 'success');
      terminal.focus();
      return true;
    },
    [effectiveAppearance.fontSize, fitAndResize, reportAction],
  );

  const runShortcutAction = useCallback(
    (action: TerminalShortcutActionId): boolean => {
      const terminal = terminalRef.current;
      if (!terminal) return false;
      switch (action) {
        case 'terminal_clear':
          clearTerminalBuffer();
          return true;
        case 'terminal_copy':
          if (!terminal.hasSelection()) return false;
          void copyTerminalSelection();
          return true;
        case 'terminal_paste':
          void pasteIntoTerminal();
          return true;
        case 'terminal_search':
          openSearch();
          return true;
        case 'terminal_pasteSelected':
          if (!terminal.hasSelection()) return false;
          pasteSelectedIntoTerminal();
          return true;
        case 'terminal_showNormalBuffer':
          return showNormalBuffer();
        case 'terminal_zoominTerminal':
          return changeTerminalFontSize(1);
        case 'terminal_zoomoutTerminal':
          return changeTerminalFontSize(-1);
        case 'terminal_syncSftpPath':
          return false;
      }
    },
    [
      changeTerminalFontSize,
      clearTerminalBuffer,
      copyTerminalSelection,
      openSearch,
      pasteIntoTerminal,
      pasteSelectedIntoTerminal,
      showNormalBuffer,
    ],
  );

  const captureReloadState = useCallback(() => {
    const terminal = terminalRef.current;
    const serialize = serializeRef.current;
    if (!terminal || !serialize) return undefined;
    let screen = '';
    try {
      screen = serialize.serialize({
        scrollback: effectiveBehavior.scrollback,
        excludeAltBuffer: true,
        excludeModes: true,
      });
    } catch {
      // A disposed or partially initialized xterm is not a recoverable screen.
    }
    return createTerminalReloadState({
      cwd: cwdRef.current,
      screen,
      alternateScreen: getAlternateBufferSnapshot(terminal.buffer.active),
    });
  }, [effectiveBehavior.scrollback]);

  useImperativeHandle(
    ref,
    () => ({
      fit: fitAndResize,
      focus: () => terminalRef.current?.focus(),
      openSearch,
      getCwd: () => cwdRef.current,
      captureReloadState,
      sendShortcut: (data) => {
        const terminal = terminalRef.current;
        if (!terminal) return false;
        const accepted = sendTerminalInput(
          resolveTerminalShortcutCursorMode(data, terminal.modes.applicationCursorKeysMode),
        );
        if (accepted) terminal.focus();
        return accepted;
      },
      sendBatchInput: (data) => sendTerminalInput(data),
      runShortcutAction,
    }),
    [captureReloadState, fitAndResize, openSearch, runShortcutAction, sendTerminalInput],
  );

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const commandInput = commandInputRef.current;
    if (!reloadStateLoadedRef.current) {
      reloadStateRef.current = consumeReloadState?.(terminalId);
      reloadStateLoadedRef.current = true;
    }
    const reloadState = reloadStateRef.current;
    if (reloadState?.cwd) cwdRef.current = reloadState.cwd;
    setConnectionState('connecting');
    setSessionFontSize(undefined);
    setNormalBufferLines(undefined);
    const terminal = new Terminal({
      allowTransparency: true,
      cursorBlink: effectiveAppearance.cursorBlink,
      cursorStyle: effectiveAppearance.cursorStyle,
      // SearchAddon result counts and overview decorations use xterm's guarded decoration API.
      allowProposedApi: true,
      convertEol: false,
      fontFamily: effectiveAppearance.fontFamily,
      fontSize: effectiveAppearance.fontSize,
      lineHeight: effectiveAppearance.lineHeight,
      scrollback: effectiveBehavior.scrollback,
      screenReaderMode: screenReaderModeRef.current,
      wordSeparator: effectiveBehavior.wordSeparator,
      theme: xtermTheme(themeRef.current, backgroundRef.current),
    });
    const fitAddon = new FitAddon();
    installSearchAddon(terminal);
    const commandTracker = new TerminalCommandTrackerAddon(
      (command) => {
        if (!commandHistoryEnabledRef.current) return;
        void client
          .recordCommandHistory(terminalId, command)
          .then((result) => {
            if (result.recorded) {
              commandSuggestionHistoryCacheRef.current.clear();
              commandSuggestionHistoryRevisionRef.current = result.revision;
              commandHistoryChangedRef.current?.();
            }
          })
          .catch(() => {
            // History is ancillary. A generation change or write failure must
            // never interrupt the terminal or echo the command into feedback.
          });
      },
      (state) => {
        setCommandTrackingState(state);
        if (state !== 'active') {
          commandInputRef.current.closePrompt();
          closeCommandSuggestions();
        }
      },
      (cwd) => {
        cwdRef.current = cwd;
      },
      {
        onPrompt: () => {
          commandInputRef.current.openPrompt();
          closeCommandSuggestions();
        },
        onCommandStart: () => {
          commandInputRef.current.closePrompt();
          closeCommandSuggestions();
        },
      },
    );
    const serialize = new SerializeAddon();
    terminalRef.current = terminal;
    fitRef.current = fitAddon;
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(commandTracker);
    terminal.loadAddon(serialize);
    serializeRef.current = serialize;
    terminal.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void client
          .openExternal(uri)
          .catch(() =>
            terminal.writeln(`\r\n\x1b[31m[${xRef.current('terminal.unsafeLink')}]\x1b[0m`),
          );
      }),
    );
    const osc52 = new Osc52Addon({
      policy: effectiveBehavior,
      sendData: sendTerminalInput,
      feedback: (code, tone) => reportAction(osc52Feedback(code), tone),
      getClipboard: () => navigator.clipboard,
    });
    terminal.loadAddon(osc52);
    if (reloadState?.screen) {
      commandTracker.beginReplay();
      terminal.write(reloadState.screen, () => commandTracker.endReplay());
    }
    terminal.open(element);
    setCapabilityState(undefined);
    const capabilities = installTerminalCapabilities(terminal, effectiveBehavior, {
      feedback: (code) => reportAction(terminalCapabilityFeedback(code), 'error'),
      onState: setCapabilityState,
    });
    const rememberPointerPosition = (event: MouseEvent) => {
      pointerPositionRef.current = { x: event.clientX, y: event.clientY };
    };
    const dismissTimestampTooltip = () => setTimestampTooltip(undefined);
    const selectionChange = terminal.onSelectionChange(() => {
      const bounds = element.getBoundingClientRect();
      const visible =
        activeRef.current &&
        element.isConnected &&
        !element.closest('[hidden]') &&
        bounds.width > 0 &&
        bounds.height > 0;
      const text = visible
        ? formatUnixTimestampSelection(terminal.hasSelection() ? terminal.getSelection() : '')
        : undefined;
      setTimestampTooltip(text ? { pointer: { ...pointerPositionRef.current }, text } : undefined);
    });
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      setActionFeedback(undefined);
      setContextMenu({
        ...clampTerminalContextMenu(
          { x: event.clientX, y: event.clientY },
          { width: window.innerWidth, height: window.innerHeight },
        ),
        hasSelection: terminal.hasSelection(),
      });
    };
    element.addEventListener('mousedown', rememberPointerPosition);
    element.addEventListener('mousemove', rememberPointerPosition);
    element.addEventListener('focusout', dismissTimestampTooltip);
    element.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('blur', dismissTimestampTooltip);
    window.addEventListener('resize', dismissTimestampTooltip);
    fitAndResize();
    if (searchOpenRef.current && searchQueryRef.current)
      performSearch('previous', searchQueryRef.current, searchOptionsRef.current);
    let disposed = false;
    void document.fonts.ready.then(() => {
      if (disposed) return;
      fitAndResize();
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
    });
    let socket: WebSocket | undefined;
    let replayBytesRemaining = 0;
    const restoreCwdInput = kind === 'ssh' ? createRestoreCwdInput(reloadState?.cwd) : '';
    let restoreCwdSent = false;
    void client
      .openTerminalSocket(terminalId, terminalClientId.current)
      .then((opened) => {
        if (disposed) return opened.close();
        socket = opened;
        lastSentSizeRef.current = undefined;
        socketRef.current = opened;
        inputSenderRef.current = new TerminalInputSender(opened, reportInputIssue);
        opened.binaryType = 'arraybuffer';
        opened.addEventListener('message', (event) => {
          const message = decodeTerminalMessage(event.data);
          if (message.kind === 'binary') {
            const output = decodeTerminalOutput(
              outputDecoderRef.current!,
              message.data,
              effectiveBehavior.displayRaw,
            );
            if (replayBytesRemaining > 0) {
              commandTracker.beginReplay();
              replayBytesRemaining = Math.max(0, replayBytesRemaining - message.data.byteLength);
              return terminal.write(
                output,
                replayBytesRemaining === 0 ? () => commandTracker.endReplay() : undefined,
              );
            }
            return terminal.write(output);
          }
          if (message.kind === 'invalid') {
            terminal.writeln(`\r\n\x1b[31m[${xRef.current('terminal.invalidControl')}]\x1b[0m`);
            return;
          }
          const control = message.control;
          if (control.type === 'exit')
            terminal.writeln(
              `\r\n\x1b[38;5;244m[${xRef.current('terminal.processExited', {
                code: control.exitCode ?? '',
              })}]\x1b[0m`,
            );
          else if (control.type === 'error')
            terminal.writeln(`\r\n\x1b[31m[${control.code}]\x1b[0m`);
          else if (control.type === 'replay') {
            replayBytesRemaining = control.byteLength;
            if (control.byteLength > 0) commandTracker.beginReplay();
            else commandTracker.endReplay();
            if (control.truncated)
              terminal.writeln(
                `\r\n\x1b[33m[${xRef.current('terminal.olderOutputTruncated')}]\x1b[0m`,
              );
          } else if (control.type === 'shellIntegration') commandTracker.setState(control.state);
          else if (control.type === 'recording') {
            setRecording(control.recording);
            if (control.recording.state === 'error')
              reportAction(
                xRef.current('terminal.logWriteFailed', {
                  fileName: control.recording.fileName,
                }),
                'error',
              );
          } else if (control.type === 'transfer') {
            void handleTerminalTransferState(control.transfer);
          } else if (control.type === 'status') {
            if (control.state === 'ready') setConnectionState('connected');
            else if (control.state === 'failed') setConnectionState('error');
            else if (['closed', 'stale'].includes(control.state))
              setConnectionState('disconnected');
          }
        });
        opened.addEventListener('close', () => {
          if (disposed) return;
          inputSenderRef.current?.cancel(true);
          inputSenderRef.current = undefined;
          setConnectionState('disconnected');
          terminal.writeln(`\r\n\x1b[38;5;244m[${xRef.current('terminal.disconnected')}]\x1b[0m`);
        });
        opened.addEventListener('open', () => {
          setConnectionState('connected');
          fitAndResize();
          if (restoreCwdInput && !restoreCwdSent)
            restoreCwdSent = sendTerminalInput(restoreCwdInput);
          if (activeRef.current) terminal.focus();
        });
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setConnectionState('error');
          terminal.writeln(
            `\r\n\x1b[31m[${xRef.current('terminal.connectionError', {
              message:
                error instanceof Error ? error.message : xRef.current('terminal.unknownError'),
            })}]\x1b[0m`,
          );
        }
      });
    const input = terminal.onData((data) => {
      sendTerminalInput(data);
      const snapshot = commandInputRef.current.handleInput(data);
      if (
        commandSuggestionsEnabledRef.current &&
        activeRef.current &&
        snapshot?.value &&
        snapshot.value === snapshot.value.trimStart()
      )
        scheduleCommandSuggestions();
      else closeCommandSuggestions();
    });
    const resize = new ResizeObserver(() => {
      dismissTimestampTooltip();
      fitAndResize();
    });
    resize.observe(element);
    terminal.attachCustomKeyEventHandler((event) => {
      const suggestions = commandSuggestionsRef.current;
      if (suggestions) {
        if (event.key === 'Escape') {
          if (event.type === 'keydown') closeCommandSuggestions();
          return false;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (event.type === 'keydown' && suggestions.items.length) {
            setCommandSuggestions((current) => {
              if (!current?.items.length) return current;
              const direction = event.key === 'ArrowDown' ? 1 : -1;
              const selectedIndex =
                current.selectedIndex < 0
                  ? direction > 0
                    ? 0
                    : current.items.length - 1
                  : (current.selectedIndex + direction + current.items.length) %
                    current.items.length;
              const next = { ...current, selectedIndex };
              commandSuggestionsRef.current = next;
              return next;
            });
          }
          return false;
        }
        if (event.key === 'Enter' && suggestions.selectedIndex >= 0) {
          if (event.type === 'keydown') {
            const selected = suggestions.items[suggestions.selectedIndex];
            if (selected) selectCommandSuggestion(selected);
          }
          return false;
        }
        if (event.key === 'Enter' && event.type === 'keydown') closeCommandSuggestions();
      }
      if (event.key === 'Backspace' && !event.altKey && !event.ctrlKey && !event.metaKey) {
        if (event.type === 'keydown') {
          sendTerminalInput(
            terminalBackspaceSequence(effectiveBehavior.backspaceMode, event.shiftKey),
          );
          terminal.scrollToBottom();
        }
        return false;
      }
      if (
        event.key === 'Enter' &&
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        if (event.type === 'keydown') {
          sendTerminalInput(terminalShiftEnterSequence(effectiveBehavior.shiftEnterMode));
          terminal.scrollToBottom();
        }
        return false;
      }
      return true;
    });
    return () => {
      disposed = true;
      dismissTimestampTooltip();
      resize.disconnect();
      input.dispose();
      selectionChange.dispose();
      searchResultsSubscriptionRef.current?.dispose();
      searchResultsSubscriptionRef.current = undefined;
      element.removeEventListener('mousedown', rememberPointerPosition);
      element.removeEventListener('mousemove', rememberPointerPosition);
      element.removeEventListener('focusout', dismissTimestampTooltip);
      element.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('blur', dismissTimestampTooltip);
      window.removeEventListener('resize', dismissTimestampTooltip);
      inputSenderRef.current?.cancel();
      inputSenderRef.current = undefined;
      socket?.close();
      socketRef.current = undefined;
      lastSentSizeRef.current = undefined;
      pendingPasteTextRef.current = undefined;
      capabilities.dispose();
      osc52.dispose();
      commandTracker.dispose();
      cancelCommandSuggestionWork();
      commandInput.closePrompt();
      serialize.dispose();
      terminal.dispose();
      terminalRef.current = undefined;
      fitRef.current = undefined;
      searchRef.current = undefined;
      serializeRef.current = undefined;
    };
  }, [
    client,
    consumeReloadState,
    effectiveAppearance,
    effectiveBehavior,
    cancelCommandSuggestionWork,
    closeCommandSuggestions,
    fitAndResize,
    handleTerminalTransferState,
    installSearchAddon,
    kind,
    openSearch,
    osc52Feedback,
    performSearch,
    reportInputIssue,
    reportAction,
    scheduleCommandSuggestions,
    selectCommandSuggestion,
    sendTerminalInput,
    terminalId,
    terminalCapabilityFeedback,
  ]);

  useEffect(() => {
    if (!active) {
      setTimestampTooltip(undefined);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      fitAndResize();
      terminalRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, fitAndResize]);

  useEffect(() => {
    if (insertion?.terminalId === terminalId) sendTerminalInput(insertion.text);
  }, [insertion, sendTerminalInput, terminalId]);

  useEffect(() => {
    if (!active || !commandSuggestionsEnabled) closeCommandSuggestions();
  }, [active, closeCommandSuggestions, commandSuggestionsEnabled]);

  useEffect(() => {
    if (!commandSuggestions) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest('.terminal-suggestions-wrap'))
        closeCommandSuggestions();
    };
    const blur = () => closeCommandSuggestions();
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('blur', blur);
    window.addEventListener('resize', blur);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', blur);
    };
  }, [closeCommandSuggestions, commandSuggestions]);

  useEffect(() => {
    if (!searchOpen) return;
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
      performSearch('previous', searchQueryRef.current, searchOptionsRef.current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [performSearch, searchOpen]);

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(undefined);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dismiss();
        terminalRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (active) return;
    dragDepthRef.current = 0;
    setDropActive(false);
    dropImportControllerRef.current?.abort();
    if (dropDialog) cancelDropDialog();
  }, [active, cancelDropDialog, dropDialog]);

  useEffect(
    () => () => {
      dropImportControllerRef.current?.abort();
      const grantIds = [...importedDropGrantsRef.current];
      importedDropGrantsRef.current.clear();
      void Promise.allSettled(grantIds.map((grantId) => client.revokeFileGrant(grantId)));
    },
    [client],
  );

  return (
    <div
      ref={surfaceRef}
      className={active ? 'terminal-surface active' : 'terminal-surface'}
      data-active={active}
      data-command-tracking={commandTrackingState}
      data-command-suggestions={commandSuggestions ? 'open' : 'closed'}
      data-file-drop={
        dropPreparing ? 'preparing' : dropDialog ? 'asking' : dropActive ? 'active' : 'idle'
      }
      data-recording={recording?.state === 'active'}
      data-terminal-transfer={terminalTransfer?.state ?? 'idle'}
      onDragEnter={(event) => {
        if (!active || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        dragDepthRef.current += 1;
        setDropActive(true);
      }}
      onDragOver={(event) => {
        if (!active || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        if (!active || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (!dragDepthRef.current) setDropActive(false);
      }}
      onDrop={(event) => void handleTerminalFileDrop(event)}
    >
      {background && background.kind !== 'none' && (
        <div
          className={`terminal-background terminal-background-${background.kind}`}
          aria-hidden="true"
          style={{
            opacity: background.opacity,
            filter: `blur(${background.blur}px) brightness(${background.brightness}) grayscale(${background.grayscale}) contrast(${background.contrast})`,
            ...(background.kind === 'image' && backgroundImageUrl
              ? { backgroundImage: `url(${JSON.stringify(backgroundImageUrl)})` }
              : {}),
          }}
        >
          {background.kind === 'text' && (
            <span
              style={{
                color: background.textColor,
                fontFamily: background.textFontFamily,
                fontSize: `${background.textSize}px`,
              }}
            >
              {background.text}
            </span>
          )}
        </div>
      )}
      {searchOpen && (
        <TerminalSearchBar
          inputRef={searchInputRef}
          query={searchQuery}
          options={searchOptions}
          results={searchResults}
          error={searchError}
          onQueryChange={(query) => {
            searchQueryRef.current = query;
            setSearchQuery(query);
            performSearch('previous', query, searchOptionsRef.current);
          }}
          onOptionChange={(option) => {
            const next = toggleTerminalSearchOption(searchOptionsRef.current, option);
            searchOptionsRef.current = next;
            setSearchOptions(next);
            searchRef.current?.clearDecorations();
            performSearch('next', searchQueryRef.current, next);
          }}
          onPrevious={() => performSearch('previous')}
          onNext={() => performSearch('next')}
          onClose={closeSearch}
        />
      )}
      {normalBufferLines && (
        <section className="terminal-normal-buffer" aria-label={x('terminal.normalBuffer')}>
          <pre>{normalBufferLines.join('\n')}</pre>
          <footer>
            <span>{x('terminal.normalBuffer')}</span>
            <button
              type="button"
              aria-label={x('terminal.closeNormalBuffer')}
              onClick={() => {
                setNormalBufferLines(undefined);
                terminalRef.current?.focus();
              }}
            >
              ×
            </button>
          </footer>
        </section>
      )}
      {active && commandSuggestions && (
        <TerminalCommandSuggestions
          state={commandSuggestions}
          onSelect={selectCommandSuggestion}
          onDelete={(item) => void deleteCommandSuggestion(item)}
          onRequestAi={() => void requestAiCommandSuggestions()}
        />
      )}
      {active && dropActive && (
        <div className="terminal-file-drop-target" aria-hidden="true">
          <strong>{x('terminal.releaseFiles')}</strong>
          <span>{x('terminal.sendToCurrent')}</span>
        </div>
      )}
      {dropPreparing && (
        <div className="terminal-file-drop-preparing" role="status" aria-live="polite">
          <span>{x('terminal.preparingFiles', { count: dropPreparing.length })}</span>
          <button type="button" onClick={cancelDroppedFileImport}>
            {t('cancel', 'Cancel')}
          </button>
        </div>
      )}
      {dropDialog && (
        <TerminalFileDropDialog
          names={dropDialog.grants.map((grant) => grant.name)}
          canUpload={kind === 'ssh' && !!connectionId}
          onSelect={(action) => void performDropAction(action, dropDialog.grants)}
          onCancel={cancelDropDialog}
        />
      )}
      {terminalTransfer && (
        <div className={`terminal-transfer-indicator ${terminalTransfer.state}`} role="status">
          <div>
            <strong>{terminalTransfer.protocol.toUpperCase()}</strong>
            <span>
              {terminalTransfer.state === 'waiting-selection'
                ? x('terminal.waitingFileSelection')
                : terminalTransfer.state === 'waiting-peer'
                  ? x('terminal.waitingPeer')
                  : terminalTransfer.state === 'transferring'
                    ? terminalTransfer.fileName || x('terminal.transferring')
                    : terminalTransfer.state === 'completed'
                      ? x('terminal.transferCompleted')
                      : terminalTransfer.state === 'failed'
                        ? x('terminal.transferFailed', {
                            detail: terminalTransfer.errorCode
                              ? ` · ${terminalTransfer.errorCode}`
                              : '',
                          })
                        : x('terminal.transferCanceled')}
            </span>
          </div>
          {terminalTransfer.state === 'transferring' && (
            <progress
              max={Math.max(1, terminalTransfer.totalBytes ?? 1)}
              value={Math.min(
                terminalTransfer.transferredBytes ?? 0,
                Math.max(1, terminalTransfer.totalBytes ?? 1),
              )}
            />
          )}
          {['waiting-selection', 'waiting-peer', 'transferring'].includes(
            terminalTransfer.state,
          ) && (
            <button type="button" onClick={() => void cancelTerminalTransfer()}>
              {t('cancel', 'Cancel')}
            </button>
          )}
        </div>
      )}
      <div
        className="terminal-host"
        ref={container}
        data-testid={`terminal-${terminalId}`}
        data-theme-background={theme?.background ?? DEFAULT_XTERM_THEME.background}
        data-theme-foreground={theme?.foreground ?? DEFAULT_XTERM_THEME.foreground}
        data-background-kind={background?.kind ?? 'none'}
        data-background-image-ready={background?.kind === 'image' && !!backgroundImageUrl}
        data-connection-state={connectionState}
        data-font-family={effectiveAppearance.fontFamily}
        data-font-size={sessionFontSize ?? effectiveAppearance.fontSize}
        data-line-height={effectiveAppearance.lineHeight}
        data-cursor-style={effectiveAppearance.cursorStyle}
        data-cursor-blink={effectiveAppearance.cursorBlink}
        data-scrollback={effectiveBehavior.scrollback}
        data-word-separator={effectiveBehavior.wordSeparator}
        data-backspace-mode={effectiveBehavior.backspaceMode}
        data-shift-enter-mode={effectiveBehavior.shiftEnterMode}
        data-encoding={activeEncoding}
        data-display-raw={effectiveBehavior.displayRaw}
        data-log-timestamps={effectiveBehavior.logTimestamps}
        data-renderer-preference={effectiveBehavior.rendererPreference}
        data-capabilities-ready={capabilityState?.ready ?? false}
        data-renderer={capabilityState?.renderer ?? 'dom'}
        data-renderer-fallback={capabilityState?.rendererFallback ?? false}
        data-unicode-version={capabilityState?.unicodeVersion ?? '6'}
        data-unicode-fallback={capabilityState?.unicodeFallback ?? false}
        data-ligatures={
          capabilityState?.ligatures ??
          (effectiveBehavior.ligaturesEnabled ? 'loading' : 'disabled')
        }
        data-image-sequences={
          capabilityState?.images ??
          (effectiveBehavior.imageSequencesEnabled ? 'loading' : 'disabled')
        }
        data-paste-protection={effectiveBehavior.pasteProtection}
        data-osc52-enabled={effectiveBehavior.osc52Enabled}
        data-osc52-read-policy={effectiveBehavior.osc52ReadPolicy}
        data-osc52-write-policy={effectiveBehavior.osc52WritePolicy}
      />
      {connectionState !== 'connected' && (
        <span className={`terminal-channel-state ${connectionState}`} role="status">
          {connectionState === 'connecting'
            ? x('terminal.connecting')
            : connectionState === 'disconnected'
              ? x('terminal.disconnected')
              : x('terminal.connectionFailed')}
        </span>
      )}
      {contextMenu && (
        <TerminalContextMenu
          {...contextMenu}
          recording={recording?.state === 'active'}
          recordingBusy={recordingBusy}
          transferBusy={
            transferSelectionBusyRef.current ||
            (!!terminalTransfer &&
              ['waiting-selection', 'waiting-peer', 'transferring'].includes(
                terminalTransfer.state,
              ))
          }
          onCopy={() => void copyTerminalSelection()}
          onPaste={() => void pasteIntoTerminal()}
          onPasteSelected={pasteSelectedIntoTerminal}
          onExplainWithAi={() => void explainSelectionWithAi()}
          onSelectAll={selectTerminalBuffer}
          onClear={clearTerminalBuffer}
          onSearch={openSearch}
          onSaveLog={() => void startRecording(true)}
          onToggleRecording={() =>
            void (recording?.state === 'active' ? stopRecording() : startRecording(false))
          }
          onXmodemUpload={() => void startXmodemTransfer('upload')}
          onXmodemDownload={() => void startXmodemTransfer('download')}
        />
      )}
      {recording?.state === 'active' && (
        <button
          type="button"
          className="terminal-recording-indicator"
          aria-label={x('terminal.stopRecordingLog', { fileName: recording.fileName })}
          disabled={recordingBusy}
          onClick={() => void stopRecording()}
        >
          <span aria-hidden="true" />
          {x('terminal.recordingLog', { fileName: recording.fileName })}
        </button>
      )}
      {pendingPaste && (
        <TerminalPasteDialog
          review={pendingPaste}
          onCancel={() => {
            pendingPasteTextRef.current = undefined;
            setPendingPaste(undefined);
            reportAction(xRef.current('terminal.pasteCanceled'), 'success');
            terminalRef.current?.focus();
          }}
          onConfirm={() => {
            const text = pendingPasteTextRef.current;
            pendingPasteTextRef.current = undefined;
            setPendingPaste(undefined);
            if (text !== undefined) commitTerminalPaste(text);
          }}
        />
      )}
      {actionFeedback && (
        <span
          className={`terminal-action-feedback ${actionFeedback.tone}`}
          role="status"
          aria-live="polite"
        >
          {actionFeedback.message}
        </span>
      )}
      {inputFeedback && (
        <span className="sr-only" role="status">
          {inputFeedback}
        </span>
      )}
      {commandHistoryEnabled && commandTrackingState === 'unavailable' && (
        <span className="terminal-command-tracking-warning" role="status">
          {x('terminal.commandHistoryUnavailable')}
        </span>
      )}
      {active && timestampTooltip && (
        <TerminalTimestampTooltip pointer={timestampTooltip.pointer} text={timestampTooltip.text} />
      )}
    </div>
  );
});

function terminalCommandSuggestionPosition(
  terminal: Terminal,
  surface: HTMLElement,
): { position: TerminalCommandSuggestionsState['position']; reverse: boolean } | undefined {
  const terminalElement = terminal.element;
  if (!terminalElement || terminal.cols < 1 || terminal.rows < 1) return undefined;
  const terminalBounds = terminalElement.getBoundingClientRect();
  const surfaceBounds = surface.getBoundingClientRect();
  if (terminalBounds.width < 2 || terminalBounds.height < 2 || surfaceBounds.width < 2)
    return undefined;
  const cellWidth = terminalBounds.width / terminal.cols;
  const cellHeight = terminalBounds.height / terminal.rows;
  const cursorLeft = terminalBounds.left + terminal.buffer.active.cursorX * cellWidth;
  const cursorBottom = terminalBounds.top + (terminal.buffer.active.cursorY + 1) * cellHeight;
  const reverse = cursorBottom > surfaceBounds.top + surfaceBounds.height / 2;
  const position: TerminalCommandSuggestionsState['position'] = {};
  if (cursorLeft > surfaceBounds.left + surfaceBounds.width / 2)
    position.right = Math.max(8, surfaceBounds.right - cursorLeft);
  else position.left = Math.max(8, cursorLeft - surfaceBounds.left);
  if (reverse)
    position.bottom = Math.max(8, surfaceBounds.bottom - cursorBottom + cellHeight * 1.5);
  else position.top = Math.max(8, cursorBottom - surfaceBounds.top + cellHeight);
  return { position, reverse };
}
