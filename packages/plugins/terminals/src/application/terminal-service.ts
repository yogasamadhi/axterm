import { randomUUID } from 'node:crypto';
import iconv from 'iconv-lite';
import type {
  TerminalAppearance,
  TerminalBehavior,
  TerminalRecording,
  TerminalServerControl,
  TerminalSession,
  TerminalTransferState,
} from '@axterm/plugin-api/terminals';
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_BEHAVIOR,
  DEFAULT_TERMINAL_TYPE,
  TERMINAL_INPUT_FRAME_MAX_BYTES,
  TERMINAL_REPLAY_MAX_BYTES,
  TERMINAL_OUTPUT_FRAME_MAX_BYTES,
  terminalControlSchema,
  terminalServerControlSchema,
} from '@axterm/plugin-api/terminals';
import type { PtyPort, TerminalChannel } from '../ports/terminal-channel.ts';
import type { ShellIntegrationKind } from '../ports/terminal-channel.ts';
import { ApplicationError } from './errors.ts';
import { createShellIntegrationCommand, SHELL_INTEGRATION_MARKER } from './shell-integration.ts';
import type { TerminalRecorder, TerminalRecorderFactory } from '../ports/terminal-recording.ts';
import { TerminalOutputWindow } from './terminal-output-flow.ts';
import { TerminalDirectoryTracker } from './terminal-directory.ts';

export interface TerminalSocket {
  readonly bufferedAmount: number;
  readonly readyState: number;
  send(data: Uint8Array | string, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: 'close' | 'error', listener: () => void): void;
  off(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void;
  off(event: 'close' | 'error', listener: () => void): void;
}

/** A narrow Runtime-internal seam for terminal-native transfer protocols. */
export interface TerminalDataInterceptor {
  receive(terminalId: string, data: Uint8Array): boolean;
  observeInput(terminalId: string, data: Uint8Array): void;
  closed(terminalId: string): void;
}

export interface TerminalOutputObserver {
  receive(terminalId: string, data: Uint8Array, encoding: string): void;
  closed(terminalId: string): void;
}

export type { TerminalStartupStep } from '@axterm/plugin-api/host';
import type { TerminalStartupStep } from '@axterm/plugin-api/host';

export type TerminalMetadataChange =
  | { readonly type: 'upsert'; readonly session: TerminalSession }
  | { readonly type: 'remove'; readonly id: string };

interface ManagedTerminal {
  directory: TerminalDirectoryTracker;
  metadata: TerminalSession;
  channel: TerminalChannel;
  recent: RecentChunk[];
  recentBytes: number;
  historyTruncated: boolean;
  nextSequence: number;
  sockets: Map<TerminalSocket, SocketAttachment>;
  clientCursors: Map<string, ClientCursor>;
  disposeData: () => void;
  disposeExit: () => void;
  closed: boolean;
  shutdown?: Promise<void>;
  backpressureTimer: ReturnType<typeof setInterval> | undefined;
  outputPaused: boolean;
  shellIntegrationState: 'pending' | 'active' | 'unavailable';
  shellIntegrationStartTimer: ReturnType<typeof setTimeout> | undefined;
  shellIntegrationTimeout: ReturnType<typeof setTimeout> | undefined;
  shellIntegrationActivationTimer: ReturnType<typeof setTimeout> | undefined;
  shellIntegrationActivationDeadline: number | undefined;
  shellIntegrationRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  shellIntegrationRecoveryDeadline: number | undefined;
  shellIntegrationInitialBuffer: Buffer[];
  shellIntegrationInitialBytes: number;
  shellIntegrationBuffer: Buffer[];
  shellIntegrationBytes: number;
  bracketedPasteEnabled: boolean;
  terminalModeTail: string;
  pendingInput: Buffer[];
  pendingInputBytes: number;
  inputReadyWaiters: Set<(ready: boolean) => void>;
  outputActivityListeners: Set<() => void>;
  startupSequenceAbort: AbortController | undefined;
  recording: ManagedRecording | undefined;
}

interface ManagedRecording {
  writer: TerminalRecorder;
  metadata: TerminalRecording;
  backpressured: boolean;
}

interface RecentChunk {
  sequence: number;
  data: Buffer;
}

interface SocketAttachment {
  clientId: string;
  flow?: TerminalOutputWindow;
  exitTimer?: ReturnType<typeof setTimeout>;
  dispose(): void;
}

interface ClientCursor {
  sequence: number;
  lastSeenAt: number;
}

const SOCKET_HIGH_WATER = 1024 * 1024;
const SOCKET_LOW_WATER = 256 * 1024;
const MAX_CLIENT_CURSORS = 64;
// Give interactive shell frameworks time to finish installing their line editor.
// Injecting the hook while readline/ble.sh is still starting can leave the hook
// being replayed character-by-character and strand subsequently queued input.
const SHELL_INTEGRATION_START_DELAY_MS = 1_000;
const SHELL_INTEGRATION_TIMEOUT_MS = 3_000;
const SHELL_INTEGRATION_PROMPT_IDLE_MS = 50;
const SHELL_INTEGRATION_PROMPT_MAX_MS = 250;
// Remote prompts can arrive in several SSH packets. Keep collecting after the
// OSC marker so a slow second prompt line cannot leave part of the native
// prompt visible above the integrated replacement.
const SSH_SHELL_INTEGRATION_PROMPT_IDLE_MS = 250;
const SSH_SHELL_INTEGRATION_PROMPT_MAX_MS = 1_500;
const SHELL_INTEGRATION_RECOVERY_MS = 5_000;
const SHELL_INTEGRATION_RECOVERY_MAX_MS = 5_000;
const SHELL_INTEGRATION_OUTPUT_MAX_BYTES = 64 * 1024;
const SHELL_INTEGRATION_INPUT_MAX_BYTES = 256 * 1024;
const SHELL_INTEGRATION_MARKER_BYTES = Buffer.from(SHELL_INTEGRATION_MARKER, 'utf8');
const TERMINAL_CURSOR_HIDE_BYTES = Buffer.from('\u001b[?25l', 'latin1');
const BRACKETED_PASTE_ON_BYTES = Buffer.from('\u001b[?2004h', 'latin1');

export class TerminalService {
  private readonly sessions = new Map<string, ManagedTerminal>();
  private dataInterceptor: TerminalDataInterceptor | undefined;
  private readonly outputObservers = new Set<TerminalOutputObserver>();

  private accepting = true;
  private readonly lifetime = new AbortController();
  private readonly recordingTasks = new Set<Promise<unknown>>();
  private readonly recordingClosures = new Map<string, Promise<TerminalRecording>>();
  private readonly recordingReservations = new Set<string>();
  private disposing: Promise<void> | undefined;
  private readonly commandObservers = new Set<(id: string, command: string) => void>();
  subscribeShellCommands(listener: (id: string, command: string) => void): () => void {
    this.assertAccepting();
    if (this.commandObservers.size >= 8)
      throw new ApplicationError(
        'CAPACITY_EXCEEDED',
        'Terminal command observer capacity exceeded',
        503,
      );
    this.commandObservers.add(listener);
    return () => {
      this.commandObservers.delete(listener);
    };
  }
  private shellCommand(id: string, command: string): void {
    const managed = this.sessions.get(id);
    if (!this.accepting || !managed || managed.closed || managed.shellIntegrationState !== 'active')
      return;
    for (const listener of this.commandObservers) {
      try {
        listener(id, command);
      } catch {
        /* Ancillary history failure never interrupts the terminal or exposes command text. */
      }
    }
  }
  private readonly metadataObservers = new Set<(change: TerminalMetadataChange) => void>();
  private readonly openingChannels = new Set<Promise<TerminalSession>>();
  private readonly shutdowns = new Map<string, Promise<void>>();
  private readonly closingChannels = new Map<string, Promise<void>>();
  constructor(
    private readonly pty: PtyPort,
    private readonly recorders: TerminalRecorderFactory,
    private readonly maxSessions = 64,
  ) {}
  stopAdmission(): void {
    this.accepting = false;
    this.lifetime.abort();
  }
  private assertAccepting(): void {
    if (!this.accepting)
      throw new ApplicationError('INVALID_STATE', 'Terminal service is closing', 409);
  }
  subscribeMetadata(listener: (change: TerminalMetadataChange) => void): () => void {
    this.assertAccepting();
    if (this.metadataObservers.size >= 64)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'Terminal observer capacity exceeded', 503);
    this.metadataObservers.add(listener);
    return () => {
      this.metadataObservers.delete(listener);
    };
  }
  private notifyMetadata(id: string): void {
    const managed = this.sessions.get(id);
    if (managed) this.notifyChange({ type: 'upsert', session: structuredClone(managed.metadata) });
  }
  private notifyChange(change: TerminalMetadataChange): void {
    for (const listener of [...this.metadataObservers]) {
      try {
        listener(structuredClone(change));
      } catch {
        console.warn('TERMINAL_METADATA_OBSERVER_FAILED');
      }
    }
  }
  dispose(): Promise<void> {
    return (this.disposing ??= (async () => {
      this.stopAdmission();
      await Promise.allSettled([...this.openingChannels]);
      await Promise.allSettled([...this.recordingTasks]);
      try {
        await this.closeAll();
      } finally {
        await Promise.allSettled([...this.recordingTasks]);
        this.metadataObservers.clear();
        this.commandObservers.clear();
        this.outputObservers.clear();
        this.dataInterceptor = undefined;
      }
    })());
  }

  setDataInterceptor(interceptor: TerminalDataInterceptor): () => void {
    this.assertAccepting();
    if (this.dataInterceptor && this.dataInterceptor !== interceptor)
      throw new ApplicationError('INVALID_STATE', 'Terminal data interceptor is already set', 409);
    this.dataInterceptor = interceptor;
    return () => {
      if (this.dataInterceptor === interceptor) this.dataInterceptor = undefined;
    };
  }

  addOutputObserver(observer: TerminalOutputObserver): () => void {
    this.assertAccepting();
    this.outputObservers.add(observer);
    return () => this.outputObservers.delete(observer);
  }

  createLocal(input: Parameters<TerminalService['createLocalOwned']>[0]): Promise<TerminalSession> {
    const task = this.createLocalOwned(input);
    this.openingChannels.add(task);
    const release = () => {
      this.openingChannels.delete(task);
    };
    void task.then(release, release);
    return task;
  }

  private async createLocalOwned(input: {
    profileId?: string;
    shell?: string;
    shellArgs?: string[];
    cwd?: string;
    env?: Record<string, string>;
    term?: string;
    loginShell?: boolean;
    appearance?: TerminalAppearance;
    behavior?: TerminalBehavior;
    cols: number;
    rows: number;
    signal?: AbortSignal;
  }): Promise<TerminalSession> {
    this.assertAccepting();
    if (
      this.sessions.size + this.closingChannels.size + this.openingChannels.size >=
      this.maxSessions
    )
      throw new ApplicationError('CAPACITY_EXCEEDED', 'Terminal capacity exceeded', 503);
    const id = randomUUID();
    const signal = AbortSignal.any([this.lifetime.signal, ...(input.signal ? [input.signal] : [])]);
    signal.throwIfAborted();
    const channel = await this.pty.open({
      ...(input.shell ? { shell: input.shell } : {}),
      args: input.shellArgs ?? [],
      ...(input.cwd ? { cwd: input.cwd } : {}),
      env: input.env ?? {},
      term: input.term ?? DEFAULT_TERMINAL_TYPE,
      loginShell: input.loginShell ?? false,
      cols: input.cols,
      rows: input.rows,
      signal,
    });
    if (signal.aborted || !this.accepting) {
      const closing = channel.close();
      this.closingChannels.set(id, closing);
      await closing;
      this.closingChannels.delete(id);
      throw new ApplicationError('REQUEST_CANCELED', 'Terminal allocation was canceled', 409);
    }
    const metadata: TerminalSession = {
      id,
      kind: 'local',
      title: '本地终端',
      state: 'ready',
      ...(input.profileId ? { profileId: input.profileId } : {}),
      appearance: { ...(input.appearance ?? DEFAULT_TERMINAL_APPEARANCE) },
      behavior: { ...(input.behavior ?? DEFAULT_TERMINAL_BEHAVIOR) },
      createdAt: new Date().toISOString(),
    };
    const managed: ManagedTerminal = {
      directory: new TerminalDirectoryTracker(channel.cwd ?? input.cwd ?? null, (command) =>
        this.shellCommand(metadata.id, command),
      ),
      metadata,
      channel,
      recent: [],
      recentBytes: 0,
      historyTruncated: false,
      nextSequence: 1,
      sockets: new Map(),
      clientCursors: new Map(),
      closed: false,
      backpressureTimer: undefined,
      outputPaused: false,
      shellIntegrationState: 'pending',
      shellIntegrationStartTimer: undefined,
      shellIntegrationTimeout: undefined,
      shellIntegrationActivationTimer: undefined,
      shellIntegrationActivationDeadline: undefined,
      shellIntegrationRecoveryTimer: undefined,
      shellIntegrationRecoveryDeadline: undefined,
      shellIntegrationInitialBuffer: [],
      shellIntegrationInitialBytes: 0,
      shellIntegrationBuffer: [],
      shellIntegrationBytes: 0,
      bracketedPasteEnabled: false,
      terminalModeTail: '',
      pendingInput: [],
      pendingInputBytes: 0,
      inputReadyWaiters: new Set(),
      outputActivityListeners: new Set(),
      startupSequenceAbort: undefined,
      recording: undefined,
      disposeData: () => {},
      disposeExit: () => {},
    };
    managed.disposeData = channel.onData((data) => this.receiveChannelData(managed, data));
    managed.disposeExit = channel.onExit((exitCode) => {
      managed.closed = true;
      this.cancelStartupSequence(managed);
      this.dataInterceptor?.closed(metadata.id);
      for (const observer of this.outputObservers) observer.closed(metadata.id);
      void this.stopManagedRecording(managed).catch(() => {});
      if (managed.backpressureTimer) clearInterval(managed.backpressureTimer);
      managed.backpressureTimer = undefined;
      this.disposeShellIntegration(managed);
      managed.metadata = { ...managed.metadata, state: 'closed', exitCode };
      this.notifyMetadata(managed.metadata.id);
      for (const [socket, attachment] of managed.sockets)
        this.finishExitedSocket(managed, socket, attachment);
      managed.disposeData();
      managed.disposeExit();
    });
    this.sessions.set(id, managed);
    this.notifyMetadata(id);
    this.startShellIntegration(managed, channel.shellIntegrationKind ?? 'unsupported');
    return structuredClone(metadata);
  }

  registerExternal(
    metadata: TerminalSession,
    channel: TerminalChannel,
    shellIntegrationKind: ShellIntegrationKind = channel.shellIntegrationKind ?? 'unsupported',
  ): TerminalSession {
    this.assertAccepting();
    if (
      this.sessions.size + this.closingChannels.size + this.openingChannels.size >=
      this.maxSessions
    )
      throw new ApplicationError('CAPACITY_EXCEEDED', 'Terminal capacity exceeded', 503);
    const managed: ManagedTerminal = {
      directory: new TerminalDirectoryTracker(channel.cwd ?? null, (command) =>
        this.shellCommand(metadata.id, command),
      ),
      metadata,
      channel,
      recent: [],
      recentBytes: 0,
      historyTruncated: false,
      nextSequence: 1,
      sockets: new Map(),
      clientCursors: new Map(),
      closed: false,
      backpressureTimer: undefined,
      outputPaused: false,
      shellIntegrationState: 'pending',
      shellIntegrationStartTimer: undefined,
      shellIntegrationTimeout: undefined,
      shellIntegrationActivationTimer: undefined,
      shellIntegrationActivationDeadline: undefined,
      shellIntegrationRecoveryTimer: undefined,
      shellIntegrationRecoveryDeadline: undefined,
      shellIntegrationInitialBuffer: [],
      shellIntegrationInitialBytes: 0,
      shellIntegrationBuffer: [],
      shellIntegrationBytes: 0,
      bracketedPasteEnabled: false,
      terminalModeTail: '',
      pendingInput: [],
      pendingInputBytes: 0,
      inputReadyWaiters: new Set(),
      outputActivityListeners: new Set(),
      startupSequenceAbort: undefined,
      recording: undefined,
      disposeData: () => {},
      disposeExit: () => {},
    };
    managed.disposeData = channel.onData((data) => this.receiveChannelData(managed, data));
    managed.disposeExit = channel.onExit((exitCode) => {
      managed.closed = true;
      this.cancelStartupSequence(managed);
      this.dataInterceptor?.closed(metadata.id);
      for (const observer of this.outputObservers) observer.closed(metadata.id);
      void this.stopManagedRecording(managed).catch(() => {});
      if (managed.backpressureTimer) clearInterval(managed.backpressureTimer);
      managed.backpressureTimer = undefined;
      this.disposeShellIntegration(managed);
      managed.metadata = { ...managed.metadata, state: 'closed', exitCode };
      this.notifyMetadata(managed.metadata.id);
      for (const [socket, attachment] of managed.sockets)
        this.finishExitedSocket(managed, socket, attachment);
      managed.disposeData();
      managed.disposeExit();
    });
    this.sessions.set(metadata.id, managed);
    this.notifyMetadata(metadata.id);
    this.startShellIntegration(managed, shellIntegrationKind);
    return structuredClone(metadata);
  }

  list(): TerminalSession[] {
    return [...this.sessions.values()].map(({ metadata }) => structuredClone(metadata));
  }

  get(id: string): TerminalSession {
    const managed = this.sessions.get(id);
    if (!managed) throw new ApplicationError('NOT_FOUND', 'Terminal not found', 404);
    return structuredClone(managed.metadata);
  }

  workingDirectory(id: string): string | null {
    const managed = this.sessions.get(id);
    if (!managed || managed.closed)
      throw new ApplicationError('NOT_FOUND', 'Terminal not found', 404);
    return managed.directory.directory;
  }

  recentOutput(id: string): string {
    const managed = this.sessions.get(id);
    if (!managed) throw new ApplicationError('NOT_FOUND', 'Terminal not found', 404);
    const output = Buffer.concat(
      managed.recent.map((chunk) => chunk.data),
      managed.recentBytes,
    );
    const encoding = managed.metadata.behavior.encoding;
    try {
      return iconv.encodingExists(encoding)
        ? iconv.decode(output, encoding)
        : output.toString('utf8');
    } catch {
      return output.toString('utf8');
    }
  }

  async executeCommand(id: string, command: string, signal?: AbortSignal): Promise<void> {
    this.assertAccepting();
    const managed = this.sessions.get(id);
    if (!managed || managed.closed)
      throw new ApplicationError('NOT_FOUND', 'Terminal not found', 404);
    // Interactive PTYs submit the current line on carriage return. A lone LF
    // only moves the cursor in canonical shells and can make a reviewed tool
    // appear successful without actually executing its command.
    const controller = signal ? undefined : new AbortController();
    const effectiveSignal = signal ?? controller!.signal;
    while (managed.shellIntegrationState === 'pending' || managed.startupSequenceAbort) {
      if (managed.closed || effectiveSignal.aborted)
        throw new ApplicationError('REQUEST_CANCELED', 'Terminal input was canceled', 409);
      await abortableDelay(25, effectiveSignal);
    }
    this.dataInterceptor?.observeInput(managed.metadata.id, Buffer.from(`${command}\r`, 'utf8'));
    for (const character of command) {
      if (managed.closed || effectiveSignal.aborted)
        throw new ApplicationError('REQUEST_CANCELED', 'Terminal input was canceled', 409);
      this.writeChannelInput(managed, Buffer.from(character, 'utf8'));
      await abortableDelay(1, effectiveSignal);
    }
    if (managed.closed || effectiveSignal.aborted)
      throw new ApplicationError('REQUEST_CANCELED', 'Terminal input was canceled', 409);
    this.writeChannelInput(managed, Buffer.from('\r', 'utf8'));
  }

  insertText(id: string, text: string): void {
    this.assertAccepting();
    const managed = this.sessions.get(id);
    if (!managed || managed.closed)
      throw new ApplicationError('NOT_FOUND', 'Terminal not found', 404);
    const data = Buffer.from(text, 'utf8');
    if (!data.length || data.length > TERMINAL_INPUT_FRAME_MAX_BYTES)
      throw new ApplicationError('VALIDATION_ERROR', 'Terminal insertion is invalid', 400);
    if (!this.writeOrQueueInput(managed, data))
      throw new ApplicationError('INVALID_STATE', 'Terminal input queue is full', 409);
  }

  enqueueStartup(id: string, data: Uint8Array): void {
    this.assertAccepting();
    const managed = this.sessions.get(id);
    if (!managed || managed.closed)
      throw new ApplicationError('NOT_FOUND', 'Terminal not found', 404);
    if (!data.byteLength) return;
    if (!this.writeOrQueueInput(managed, data))
      throw new ApplicationError(
        'PAYLOAD_TOO_LARGE',
        'SSH startup input exceeds the bounded terminal queue',
        413,
      );
  }

  enqueueStartupSequence(id: string, steps: TerminalStartupStep[]): void {
    this.assertAccepting();
    const managed = this.sessions.get(id);
    if (!managed || managed.closed)
      throw new ApplicationError('NOT_FOUND', 'Terminal not found', 404);
    if (steps.length > 64)
      throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Terminal startup sequence is too long', 413);
    const bytes = steps.reduce(
      (total, step) => total + Buffer.byteLength(step.text, 'utf8') + Number(step.sendEnter),
      0,
    );
    if (bytes > SHELL_INTEGRATION_INPUT_MAX_BYTES)
      throw new ApplicationError(
        'PAYLOAD_TOO_LARGE',
        'Terminal startup sequence exceeds the bounded input queue',
        413,
      );
    this.cancelStartupSequence(managed);
    if (!steps.length) return;
    const controller = new AbortController();
    managed.startupSequenceAbort = controller;
    void this.runStartupSequence(managed, steps, controller).catch(() => {
      // Terminal closure and generation replacement cancel startup without replay.
    });
  }

  startupSequenceCount(): number {
    return [...this.sessions.values()].filter(({ startupSequenceAbort }) => !!startupSequenceAbort)
      .length;
  }

  startRecording(
    id: string,
    input: { path: string; fileName: string; timestamps: boolean; includeRecent: boolean },
    factory: TerminalRecorderFactory = this.recorders,
  ): Promise<TerminalRecording> {
    this.assertAccepting();
    if (this.recordingReservations.has(id))
      return Promise.reject(
        new ApplicationError('INVALID_STATE', 'Terminal recording is already opening', 409),
      );
    this.recordingReservations.add(id);
    const task = this.openRecording(id, input, factory);
    this.recordingTasks.add(task);
    const release = () => {
      this.recordingTasks.delete(task);
      this.recordingReservations.delete(id);
    };
    void task.then(release, release);
    return task;
  }
  private async openRecording(
    id: string,
    input: { path: string; fileName: string; timestamps: boolean; includeRecent: boolean },
    factory: TerminalRecorderFactory = this.recorders,
  ): Promise<TerminalRecording> {
    this.assertAccepting();
    const managed = this.sessions.get(id);
    if (!managed || managed.closed)
      throw new ApplicationError('NOT_FOUND', 'Terminal not found', 404);
    if (managed.recording)
      throw new ApplicationError('INVALID_STATE', 'Terminal recording is already active', 409);
    const metadata: TerminalRecording = {
      terminalId: id,
      state: 'active',
      fileName: input.fileName,
      timestamps: input.timestamps,
      bytesWritten: 0,
      startedAt: new Date().toISOString(),
    };
    let writer: TerminalRecorder;
    let openingFailed = false;
    try {
      writer = await factory.open({
        signal: this.lifetime.signal,
        path: input.path,
        encoding: managed.metadata.behavior.encoding,
        timestamps: input.timestamps,
        onDrain: () => this.releaseRecordingBackpressure(managed),
        onError: () => {
          openingFailed = true;
          this.failRecording(managed);
        },
      });
    } catch {
      throw new ApplicationError(
        this.lifetime.signal.aborted || managed.closed ? 'REQUEST_CANCELED' : 'INVALID_STATE',
        'Unable to open the granted log file',
        409,
      );
    }
    if (!this.accepting || managed.closed || this.sessions.get(id) !== managed) {
      await writer.close();
      throw new ApplicationError('REQUEST_CANCELED', 'Terminal recording was canceled', 409);
    }
    if (openingFailed) {
      await writer.close().catch(() => {});
      throw new ApplicationError('INVALID_STATE', 'Terminal recording failed to open', 409);
    }
    managed.recording = { writer, metadata, backpressured: false };
    managed.metadata = { ...managed.metadata, recording: { ...metadata } };
    this.notifyMetadata(managed.metadata.id);
    if (input.includeRecent)
      for (const chunk of managed.recent) this.recordOutput(managed, chunk.data);
    const active = managed.recording;
    if (!active)
      throw new ApplicationError('INVALID_STATE', 'Unable to start terminal recording', 409);
    this.publishRecordingState(managed, active.metadata);
    return { ...active.metadata };
  }

  async stopRecording(id: string): Promise<TerminalRecording> {
    const managed = this.sessions.get(id);
    if (!managed) throw new ApplicationError('NOT_FOUND', 'Terminal not found', 404);
    if (!managed.recording)
      throw new ApplicationError('INVALID_STATE', 'Terminal recording is not active', 409);
    return this.stopManagedRecording(managed);
  }

  attach(
    id: string,
    socket: TerminalSocket,
    clientId: string = randomUUID(),
    options: { outputFlow?: boolean } = {},
  ): void {
    this.assertAccepting();
    const managed = this.sessions.get(id);
    if (!managed) throw new ApplicationError('NOT_FOUND', 'Terminal not found', 404);

    for (const [attachedSocket, attachment] of managed.sockets) {
      if (attachment.clientId !== clientId) continue;
      attachment.dispose();
      managed.sockets.delete(attachedSocket);
      attachedSocket.close(1000, 'terminal client replaced');
    }
    if (managed.sockets.size >= MAX_CLIENT_CURSORS)
      throw new ApplicationError('INVALID_STATE', 'Terminal viewer limit reached', 409);
    const attachment: SocketAttachment = {
      clientId,
      ...(options.outputFlow
        ? {
            flow: new TerminalOutputWindow(
              randomUUID(),
              managed.clientCursors.get(clientId)?.sequence ?? 0,
            ),
          }
        : {}),
      dispose: () => {},
    };
    managed.sockets.set(socket, attachment);
    this.touchClientCursor(managed, clientId, managed.clientCursors.get(clientId)?.sequence ?? 0);
    socket.send(
      JSON.stringify({
        type: 'ready',
        ...(attachment.flow ? { outputFlow: attachment.flow.metadata() } : {}),
      }),
      { binary: false },
    );
    socket.send(
      JSON.stringify({ type: 'shellIntegration', state: managed.shellIntegrationState }),
      { binary: false },
    );
    if (managed.metadata.recording)
      socket.send(JSON.stringify({ type: 'recording', recording: managed.metadata.recording }), {
        binary: false,
      });
    this.replayToSocket(managed, socket, clientId);
    const message = (data: Buffer, isBinary: boolean) => {
      if (managed.sockets.get(socket) !== attachment) return;
      if (isBinary) {
        if (managed.closed) return;
        if (data.length <= TERMINAL_INPUT_FRAME_MAX_BYTES) {
          if (!this.writeOrQueueInput(managed, data))
            socket.send(JSON.stringify({ type: 'error', code: 'TERMINAL_INPUT_QUEUE_FULL' }), {
              binary: false,
            });
        } else
          socket.send(JSON.stringify({ type: 'error', code: 'TERMINAL_INPUT_TOO_LARGE' }), {
            binary: false,
          });
        return;
      }
      let document: unknown;
      try {
        document = JSON.parse(data.toString('utf8'));
      } catch {
        socket.send(JSON.stringify({ type: 'error', code: 'INVALID_CONTROL_MESSAGE' }));
        return;
      }
      const parsed = terminalControlSchema.safeParse(document);
      if (!parsed.success) {
        socket.send(JSON.stringify({ type: 'error', code: 'INVALID_CONTROL_MESSAGE' }));
        return;
      }
      const control = parsed.data;
      if (control.type === 'outputConsumed') {
        if (!attachment.flow?.acknowledge(control.streamId, control.consumedBytes)) {
          socket.send(JSON.stringify({ type: 'error', code: 'INVALID_OUTPUT_ACK' }), {
            binary: false,
          });
          socket.close(1008, 'invalid output acknowledgement');
          return;
        }
        this.touchClientCursor(managed, clientId, attachment.flow.lastConsumedSequence);
        this.refreshOutputFlow(managed);
        this.finishExitedSocket(managed, socket, attachment);
      } else if (control.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', nonce: control.nonce }));
      } else if (managed.closed) {
        socket.send(JSON.stringify({ type: 'error', code: 'TERMINAL_CLOSED' }), { binary: false });
      } else if (control.type === 'resize') managed.channel.resize(control.cols, control.rows);
      else if (control.type === 'signal') managed.channel.signal(control.signal);
      else void this.close(id);
    };
    const detach = () => {
      attachment.dispose();
      if (managed.sockets.get(socket) !== attachment) return;
      managed.sockets.delete(socket);
      this.refreshOutputFlow(managed);
    };
    attachment.dispose = () => {
      if (attachment.exitTimer) clearTimeout(attachment.exitTimer);
      delete attachment.exitTimer;
      socket.off('message', message);
      socket.off('close', detach);
      socket.off('error', detach);
      attachment.flow?.dispose();
    };
    socket.on('message', message);
    socket.on('close', detach);
    socket.on('error', detach);
    this.refreshOutputFlow(managed);
    this.finishExitedSocket(managed, socket, attachment);
  }

  /** Read-only exited viewers retain bounded replay until parser consumption or an owned deadline. */
  private finishExitedSocket(
    managed: ManagedTerminal,
    socket: TerminalSocket,
    attachment: SocketAttachment,
  ): void {
    if (!managed.closed || managed.sockets.get(socket) !== attachment) return;
    if (attachment.flow && attachment.flow.pendingBytes() > 0) {
      if (!attachment.exitTimer) {
        attachment.exitTimer = setTimeout(() => {
          if (managed.sockets.get(socket) !== attachment) return;
          attachment.dispose();
          managed.sockets.delete(socket);
          socket.close(1008, 'terminal replay consumption timeout');
        }, 15000);
        attachment.exitTimer.unref();
      }
      return;
    }
    attachment.dispose();
    managed.sockets.delete(socket);
    if (socket.readyState === 1)
      socket.send(JSON.stringify({ type: 'exit', exitCode: managed.metadata.exitCode ?? null }), {
        binary: false,
      });
    socket.close(1000, 'terminal exited');
  }

  private startShellIntegration(managed: ManagedTerminal, kind: ShellIntegrationKind): void {
    const command = createShellIntegrationCommand(kind);
    if (!command) {
      managed.shellIntegrationState = 'unavailable';
      this.resolveInputReady(managed, true);
      return;
    }
    managed.shellIntegrationStartTimer = setTimeout(() => {
      managed.shellIntegrationStartTimer = undefined;
      if (managed.closed) return;
      managed.shellIntegrationTimeout = setTimeout(() => {
        managed.shellIntegrationTimeout = undefined;
        if (managed.closed || managed.shellIntegrationState !== 'pending') return;
        this.failShellIntegration(managed);
      }, SHELL_INTEGRATION_TIMEOUT_MS);
      managed.shellIntegrationTimeout.unref();
      const input = managed.bracketedPasteEnabled
        ? `\u001b[200~${command.replace(/\r$/u, '')}\u001b[201~\r`
        : command;
      this.writeChannelInput(managed, Buffer.from(input, 'utf8'));
    }, SHELL_INTEGRATION_START_DELAY_MS);
    managed.shellIntegrationStartTimer.unref();
  }

  private receiveChannelData(managed: ManagedTerminal, data: Uint8Array): void {
    const terminalModes = `${managed.terminalModeTail}${Buffer.from(data).toString('latin1')}`;
    const bracketedPasteOn = terminalModes.lastIndexOf('\u001b[?2004h');
    const bracketedPasteOff = terminalModes.lastIndexOf('\u001b[?2004l');
    if (bracketedPasteOn >= 0 || bracketedPasteOff >= 0)
      managed.bracketedPasteEnabled = bracketedPasteOn > bracketedPasteOff;
    managed.terminalModeTail = terminalModes.slice(-16);
    if (this.dataInterceptor?.receive(managed.metadata.id, data)) return;
    managed.directory.receive(data);
    if (managed.shellIntegrationState !== 'pending' || !managed.shellIntegrationStartTimer) {
      if (managed.shellIntegrationState !== 'pending') {
        this.broadcast(managed, data);
        return;
      }
      // The injection was sent and its echo/output is held until a bounded OSC
      // marker confirms success. This keeps bootstrap text out of replay and UI.
      const chunk = Buffer.from(data);
      managed.shellIntegrationBuffer.push(chunk);
      managed.shellIntegrationBytes += chunk.length;
      if (managed.shellIntegrationBytes > SHELL_INTEGRATION_OUTPUT_MAX_BYTES) {
        if (managed.shellIntegrationRecoveryTimer) {
          const tail = Buffer.concat(
            managed.shellIntegrationBuffer,
            managed.shellIntegrationBytes,
          ).subarray(-SHELL_INTEGRATION_OUTPUT_MAX_BYTES);
          managed.shellIntegrationBuffer = [tail];
          managed.shellIntegrationBytes = tail.length;
          this.scheduleShellIntegrationRecovery(managed);
          return;
        }
        this.failShellIntegration(managed);
        return;
      }
      const buffered = Buffer.concat(managed.shellIntegrationBuffer, managed.shellIntegrationBytes);
      const marker = buffered.indexOf(SHELL_INTEGRATION_MARKER_BYTES);
      if (marker < 0) {
        if (managed.shellIntegrationRecoveryTimer) this.scheduleShellIntegrationRecovery(managed);
        return;
      }
      this.scheduleShellIntegrationActivation(managed);
      return;
    }
    // Hold the first native prompt until the delayed hook either succeeds or
    // falls back. Showing it now would leave two prompts on screen when the
    // hook emits its own prompt a moment later.
    const chunk = Buffer.from(data);
    managed.shellIntegrationInitialBuffer.push(chunk);
    managed.shellIntegrationInitialBytes += chunk.length;
    if (managed.shellIntegrationInitialBytes > SHELL_INTEGRATION_OUTPUT_MAX_BYTES)
      this.disableShellIntegrationBeforeInjection(managed);
  }

  private disableShellIntegrationBeforeInjection(managed: ManagedTerminal): void {
    if (managed.shellIntegrationStartTimer) clearTimeout(managed.shellIntegrationStartTimer);
    managed.shellIntegrationStartTimer = undefined;
    managed.shellIntegrationState = 'unavailable';
    this.resolveInputReady(managed, true);
    this.publishShellIntegrationState(managed);
    const initialOutput = this.takeShellIntegrationInitialOutput(managed);
    if (initialOutput.length) this.broadcast(managed, initialOutput);
    this.flushPendingInput(managed);
  }

  private scheduleShellIntegrationActivation(managed: ManagedTerminal): void {
    if (managed.shellIntegrationTimeout) clearTimeout(managed.shellIntegrationTimeout);
    if (managed.shellIntegrationActivationTimer)
      clearTimeout(managed.shellIntegrationActivationTimer);
    if (managed.shellIntegrationRecoveryTimer) clearTimeout(managed.shellIntegrationRecoveryTimer);
    managed.shellIntegrationTimeout = undefined;
    managed.shellIntegrationRecoveryTimer = undefined;
    managed.shellIntegrationRecoveryDeadline = undefined;
    const promptIdleMs =
      managed.metadata.kind === 'ssh'
        ? SSH_SHELL_INTEGRATION_PROMPT_IDLE_MS
        : SHELL_INTEGRATION_PROMPT_IDLE_MS;
    const promptMaxMs =
      managed.metadata.kind === 'ssh'
        ? SSH_SHELL_INTEGRATION_PROMPT_MAX_MS
        : SHELL_INTEGRATION_PROMPT_MAX_MS;
    managed.shellIntegrationActivationDeadline ??= Date.now() + promptMaxMs;
    const remaining = Math.max(0, managed.shellIntegrationActivationDeadline - Date.now());
    managed.shellIntegrationActivationTimer = setTimeout(
      () => this.completeShellIntegrationActivation(managed),
      Math.min(promptIdleMs, remaining),
    );
    managed.shellIntegrationActivationTimer.unref();
  }

  private completeShellIntegrationActivation(managed: ManagedTerminal): void {
    managed.shellIntegrationActivationTimer = undefined;
    managed.shellIntegrationActivationDeadline = undefined;
    if (managed.closed || managed.shellIntegrationState !== 'pending') return;
    const buffered = Buffer.concat(managed.shellIntegrationBuffer, managed.shellIntegrationBytes);
    const marker = buffered.indexOf(SHELL_INTEGRATION_MARKER_BYTES);
    if (marker < 0) {
      this.failShellIntegration(managed);
      return;
    }
    managed.shellIntegrationBuffer = [];
    managed.shellIntegrationBytes = 0;
    managed.shellIntegrationState = 'active';
    this.resolveInputReady(managed, true);
    this.publishShellIntegrationState(managed);
    const replacementPrompt = buffered.subarray(marker);
    const initialOutput = this.takeShellIntegrationInitialOutput(
      managed,
      countLineFeeds(replacementPrompt),
    );
    if (initialOutput.length) this.broadcast(managed, initialOutput);
    this.restoreHiddenBracketedPasteMode(managed);
    // Retain the marker and following prompt bytes so the Renderer tracker
    // observes activation, while the echoed bootstrap command stays hidden.
    this.broadcast(managed, replacementPrompt);
    this.flushPendingInput(managed);
  }

  private takeShellIntegrationInitialOutput(
    managed: ManagedTerminal,
    replacementPromptLineFeeds?: number,
  ): Buffer {
    const output = Buffer.concat(
      managed.shellIntegrationInitialBuffer,
      managed.shellIntegrationInitialBytes,
    );
    managed.shellIntegrationInitialBuffer = [];
    managed.shellIntegrationInitialBytes = 0;
    if (replacementPromptLineFeeds === undefined || !output.length) return output;
    // Prompt frameworks such as ble.sh redraw in place with cursor movement and
    // can render the same prompt more than once in their raw byte stream. Line
    // counting cannot separate that drawing from startup output. Cursor hiding
    // marks the beginning of the interactive drawing phase; retain an SSH
    // banner before it, but never replay the obsolete prompt drawing itself.
    const complexPromptStart = output.indexOf(TERMINAL_CURSOR_HIDE_BYTES);
    if (complexPromptStart >= 0) {
      const retained = output.subarray(0, complexPromptStart);
      return isOnlyTerminalWhitespace(retained) ? Buffer.alloc(0) : retained;
    }
    let precedingLineFeed = output.length;
    for (let index = 0; index <= replacementPromptLineFeeds; index += 1) {
      precedingLineFeed = output.lastIndexOf(0x0a, precedingLineFeed - 1);
      if (precedingLineFeed < 0) return Buffer.alloc(0);
    }
    const retained = output.subarray(0, precedingLineFeed + 1);
    return isOnlyTerminalWhitespace(retained) ? Buffer.alloc(0) : retained;
  }

  private failShellIntegration(managed: ManagedTerminal): void {
    if (managed.shellIntegrationRecoveryTimer) return;
    if (managed.shellIntegrationTimeout) clearTimeout(managed.shellIntegrationTimeout);
    if (managed.shellIntegrationActivationTimer)
      clearTimeout(managed.shellIntegrationActivationTimer);
    managed.shellIntegrationTimeout = undefined;
    managed.shellIntegrationActivationTimer = undefined;
    managed.shellIntegrationActivationDeadline = undefined;
    // A slow shell line editor can still be rendering the injected hook when
    // the bounded timeout expires. Interrupt that private line before releasing
    // queued user/tool input, otherwise the two commands can be joined or lost.
    managed.shellIntegrationBuffer = [];
    managed.shellIntegrationBytes = 0;
    managed.channel.write(Buffer.from([0x03]));
    managed.shellIntegrationRecoveryDeadline = Date.now() + SHELL_INTEGRATION_RECOVERY_MAX_MS;
    this.scheduleShellIntegrationRecovery(managed);
  }

  private scheduleShellIntegrationRecovery(managed: ManagedTerminal): void {
    if (managed.shellIntegrationRecoveryTimer) clearTimeout(managed.shellIntegrationRecoveryTimer);
    const remaining = Math.max(
      0,
      (managed.shellIntegrationRecoveryDeadline ?? Date.now()) - Date.now(),
    );
    managed.shellIntegrationRecoveryTimer = setTimeout(
      () => this.completeShellIntegrationRecovery(managed),
      Math.min(SHELL_INTEGRATION_RECOVERY_MS, remaining),
    );
    managed.shellIntegrationRecoveryTimer.unref();
  }

  private completeShellIntegrationRecovery(managed: ManagedTerminal): void {
    managed.shellIntegrationRecoveryTimer = undefined;
    managed.shellIntegrationRecoveryDeadline = undefined;
    if (managed.closed) return;
    const recoveryOutput = Buffer.concat(
      managed.shellIntegrationBuffer,
      managed.shellIntegrationBytes,
    );
    managed.shellIntegrationBuffer = [];
    managed.shellIntegrationBytes = 0;
    managed.terminalModeTail = '';
    managed.shellIntegrationState = 'unavailable';
    this.resolveInputReady(managed, true);
    this.publishShellIntegrationState(managed);
    const initialOutput = this.takeShellIntegrationInitialOutput(
      managed,
      recoveryOutput.length > 0 ? 0 : undefined,
    );
    if (initialOutput.length) this.broadcast(managed, initialOutput);
    this.restoreHiddenBracketedPasteMode(managed);
    if (recoveryOutput.length) this.broadcast(managed, recoveryOutput);
    this.flushPendingInput(managed);
  }

  private publishShellIntegrationState(managed: ManagedTerminal): void {
    const message = JSON.stringify({
      type: 'shellIntegration',
      state: managed.shellIntegrationState,
    });
    for (const socket of managed.sockets.keys()) {
      if (socket.readyState !== 1) continue;
      if (socket.bufferedAmount > SOCKET_HIGH_WATER) {
        socket.close(1008, 'terminal control consumer limit');
        continue;
      }
      socket.send(message, { binary: false });
    }
  }

  private restoreHiddenBracketedPasteMode(managed: ManagedTerminal): void {
    // Startup prompt replacement can discard the shell's DECSET 2004. The
    // shell still has bracketed paste enabled, so mirror that mode to xterm
    // before flushing the user's first queued paste.
    if (managed.bracketedPasteEnabled) this.broadcast(managed, BRACKETED_PASTE_ON_BYTES);
  }

  private disposeShellIntegration(managed: ManagedTerminal): void {
    if (managed.shellIntegrationStartTimer) clearTimeout(managed.shellIntegrationStartTimer);
    if (managed.shellIntegrationTimeout) clearTimeout(managed.shellIntegrationTimeout);
    if (managed.shellIntegrationActivationTimer)
      clearTimeout(managed.shellIntegrationActivationTimer);
    if (managed.shellIntegrationRecoveryTimer) clearTimeout(managed.shellIntegrationRecoveryTimer);
    managed.shellIntegrationStartTimer = undefined;
    managed.shellIntegrationTimeout = undefined;
    managed.shellIntegrationActivationTimer = undefined;
    managed.shellIntegrationActivationDeadline = undefined;
    managed.shellIntegrationRecoveryTimer = undefined;
    managed.shellIntegrationRecoveryDeadline = undefined;
    managed.shellIntegrationInitialBuffer = [];
    managed.shellIntegrationInitialBytes = 0;
    managed.shellIntegrationBuffer = [];
    managed.shellIntegrationBytes = 0;
    managed.pendingInput = [];
    managed.pendingInputBytes = 0;
    this.resolveInputReady(managed, false);
  }

  private async runStartupSequence(
    managed: ManagedTerminal,
    steps: TerminalStartupStep[],
    controller: AbortController,
  ): Promise<void> {
    try {
      if (!(await this.waitForInputReady(managed, controller.signal))) return;
      for (const [index, step] of steps.entries()) {
        if (controller.signal.aborted || managed.closed) return;
        const text = step.text.replace(/\r?\n/gu, '\r');
        const data = Buffer.from(`${text}${step.sendEnter ? '\r' : ''}`, 'utf8');
        this.dataInterceptor?.observeInput(managed.metadata.id, data);
        this.writeChannelInput(managed, data);
        await abortableDelay(step.delayMs, controller.signal);
        if (step.waitForOutput && index < steps.length - 1)
          await this.waitForOutputIdle(
            managed,
            step.settleIdleMs,
            step.settleTimeoutMs,
            controller.signal,
          );
      }
    } finally {
      if (managed.startupSequenceAbort === controller) {
        managed.startupSequenceAbort = undefined;
        this.flushPendingInput(managed);
      }
    }
  }

  private waitForInputReady(managed: ManagedTerminal, signal: AbortSignal): Promise<boolean> {
    if (managed.closed || signal.aborted) return Promise.resolve(false);
    if (managed.shellIntegrationState !== 'pending') return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (ready: boolean) => {
        managed.inputReadyWaiters.delete(finish);
        signal.removeEventListener('abort', aborted);
        resolve(ready && !managed.closed && !signal.aborted);
      };
      const aborted = () => finish(false);
      managed.inputReadyWaiters.add(finish);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }

  private resolveInputReady(managed: ManagedTerminal, ready: boolean): void {
    const waiters = [...managed.inputReadyWaiters];
    managed.inputReadyWaiters.clear();
    for (const resolve of waiters) resolve(ready);
  }

  private waitForOutputIdle(
    managed: ManagedTerminal,
    idleMs: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (managed.closed || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let idleTimer: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(idleTimer);
        clearTimeout(timeoutTimer);
        managed.outputActivityListeners.delete(activity);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const scheduleIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(finish, idleMs);
        idleTimer.unref();
      };
      const activity = () => scheduleIdle();
      managed.outputActivityListeners.add(activity);
      signal.addEventListener('abort', finish, { once: true });
      const timeoutTimer = setTimeout(finish, timeoutMs);
      timeoutTimer.unref();
      scheduleIdle();
    });
  }

  private cancelStartupSequence(managed: ManagedTerminal): void {
    managed.startupSequenceAbort?.abort();
    managed.startupSequenceAbort = undefined;
    managed.outputActivityListeners.clear();
    this.resolveInputReady(managed, false);
  }

  private writeOrQueueInput(managed: ManagedTerminal, data: Uint8Array): boolean {
    this.dataInterceptor?.observeInput(managed.metadata.id, data);
    const encoded = this.encodeChannelInput(managed, data);
    if (managed.shellIntegrationState !== 'pending' && !managed.startupSequenceAbort) {
      managed.channel.write(encoded);
      return true;
    }
    if (managed.pendingInputBytes + encoded.byteLength > SHELL_INTEGRATION_INPUT_MAX_BYTES)
      return false;
    const chunk = Buffer.from(encoded);
    managed.pendingInput.push(chunk);
    managed.pendingInputBytes += chunk.length;
    return true;
  }

  private flushPendingInput(managed: ManagedTerminal): void {
    if (
      managed.closed ||
      managed.shellIntegrationState === 'pending' ||
      managed.startupSequenceAbort
    )
      return;
    const input = managed.pendingInput;
    managed.pendingInput = [];
    managed.pendingInputBytes = 0;
    for (const chunk of input) managed.channel.write(chunk);
  }

  private writeChannelInput(managed: ManagedTerminal, data: Uint8Array): void {
    managed.channel.write(this.encodeChannelInput(managed, data));
  }

  private encodeChannelInput(managed: ManagedTerminal, data: Uint8Array): Uint8Array {
    const encoding = managed.metadata.behavior.encoding;
    if (
      !['ssh', 'telnet', 'serial'].includes(managed.metadata.kind) ||
      /^(?:utf-?8)$/i.test(encoding)
    )
      return data;
    try {
      if (!iconv.encodingExists(encoding)) return data;
      return iconv.encode(Buffer.from(data).toString('utf8'), encoding);
    } catch {
      return data;
    }
  }

  private broadcast(managed: ManagedTerminal, data: Uint8Array): void {
    this.recordOutput(managed, data);
    for (const activity of managed.outputActivityListeners) activity();
    for (const observer of this.outputObservers) {
      try {
        observer.receive(managed.metadata.id, data, managed.metadata.behavior.encoding);
      } catch {
        // Output observers are ancillary and cannot interrupt terminal delivery.
      }
    }
    const chunk = this.remember(managed, data);
    let congested = false;
    for (const [socket, attachment] of managed.sockets) {
      if (socket.readyState !== 1) continue;
      if (socket.bufferedAmount > SOCKET_HIGH_WATER) {
        congested = true;
        continue;
      }
      this.sendOutputChunk(managed, socket, attachment, data, chunk.sequence);
    }
    if (congested && !managed.backpressureTimer) {
      managed.channel.pause();
      managed.backpressureTimer = setInterval(() => {
        if (
          [...managed.sockets.keys()].every((socket) => socket.bufferedAmount < SOCKET_LOW_WATER)
        ) {
          if (managed.backpressureTimer) clearInterval(managed.backpressureTimer);
          managed.backpressureTimer = undefined;
          if (!managed.closed && !managed.recording?.backpressured) {
            for (const [socket, attachment] of managed.sockets)
              this.replayToSocket(managed, socket, attachment.clientId);
            this.refreshOutputFlow(managed, true);
          }
        }
      }, 25);
      managed.backpressureTimer.unref();
    }
    this.refreshOutputFlow(managed);
  }

  private sendOutputChunk(
    managed: ManagedTerminal,
    socket: TerminalSocket,
    attachment: SocketAttachment,
    data: Uint8Array,
    sequence: number,
  ): void {
    if (!attachment.flow) {
      socket.send(data, { binary: true });
      this.touchClientCursor(managed, attachment.clientId, sequence);
      return;
    }
    for (let offset = 0; offset < data.byteLength; offset += TERMINAL_OUTPUT_FRAME_MAX_BYTES) {
      const frame = data.subarray(
        offset,
        Math.min(data.byteLength, offset + TERMINAL_OUTPUT_FRAME_MAX_BYTES),
      );
      if (!attachment.flow.canSend(frame.byteLength)) {
        socket.send(JSON.stringify({ type: 'error', code: 'TERMINAL_OUTPUT_CONSUMER_LIMIT' }), {
          binary: false,
        });
        socket.close(1008, 'terminal output consumer limit');
        return;
      }
      attachment.flow.sent(
        frame.byteLength,
        offset + frame.byteLength === data.byteLength ? sequence : undefined,
      );
      socket.send(frame, { binary: true });
    }
  }

  private refreshOutputFlow(managed: ManagedTerminal, releasedOtherOwner = false): void {
    const flows = [...managed.sockets.values()].flatMap((attachment) =>
      attachment.flow ? [attachment.flow] : [],
    );
    const wasPaused = managed.outputPaused;
    managed.outputPaused =
      flows.some((flow) => flow.high()) || (wasPaused && !flows.every((flow) => flow.low()));
    if (managed.closed) return;
    if (managed.outputPaused && !wasPaused) managed.channel.pause();
    else if (
      !managed.outputPaused &&
      (wasPaused || releasedOtherOwner) &&
      !managed.backpressureTimer &&
      !managed.recording?.backpressured
    )
      managed.channel.resume();
  }

  private remember(managed: ManagedTerminal, data: Uint8Array): RecentChunk {
    const chunk = { sequence: managed.nextSequence++, data: Buffer.from(data) };
    if (chunk.data.length > TERMINAL_REPLAY_MAX_BYTES) {
      managed.recent = [];
      managed.recentBytes = 0;
      managed.historyTruncated = true;
      return chunk;
    }
    managed.recent.push(chunk);
    managed.recentBytes += chunk.data.length;
    while (managed.recentBytes > TERMINAL_REPLAY_MAX_BYTES) {
      const removed = managed.recent.shift();
      if (!removed) break;
      managed.recentBytes -= removed.data.length;
      managed.historyTruncated = true;
    }
    return chunk;
  }

  private replayToSocket(managed: ManagedTerminal, socket: TerminalSocket, clientId: string): void {
    if (socket.readyState !== 1) return;
    const attachment = managed.sockets.get(socket);
    if (!attachment) return;
    const previousSequence =
      attachment.flow?.lastSentSequence ?? managed.clientCursors.get(clientId)?.sequence ?? 0;
    const chunks = managed.recent.filter((chunk) => chunk.sequence > previousSequence);
    const firstRetained = managed.recent[0]?.sequence;
    const truncated =
      previousSequence === 0
        ? managed.historyTruncated
        : firstRetained === undefined
          ? previousSequence < managed.nextSequence - 1
          : previousSequence + 1 < firstRetained;
    const byteLength = chunks.reduce((total, chunk) => total + chunk.data.length, 0);
    socket.send(
      JSON.stringify({
        type: 'replay',
        ...(chunks[0] ? { firstSequence: chunks[0].sequence } : {}),
        lastSequence: managed.nextSequence - 1,
        byteLength,
        truncated,
      }),
      { binary: false },
    );
    for (const chunk of chunks) {
      if (managed.sockets.get(socket) !== attachment || socket.readyState !== 1) break;
      this.sendOutputChunk(managed, socket, attachment, chunk.data, chunk.sequence);
    }
    if (!attachment.flow) this.touchClientCursor(managed, clientId, managed.nextSequence - 1);
  }

  private touchClientCursor(managed: ManagedTerminal, clientId: string, sequence: number): void {
    managed.clientCursors.delete(clientId);
    managed.clientCursors.set(clientId, { sequence, lastSeenAt: Date.now() });
    while (managed.clientCursors.size > MAX_CLIENT_CURSORS) {
      const oldest = managed.clientCursors.keys().next().value as string | undefined;
      if (!oldest) break;
      managed.clientCursors.delete(oldest);
    }
  }

  /** End native work without deleting the retained, read-only session/tab. */
  async disconnect(id: string): Promise<TerminalSession> {
    this.assertAccepting();
    const managed = this.sessions.get(id);
    if (!managed) throw new ApplicationError('NOT_FOUND', 'Terminal not found', 404);
    await this.shutdownManaged(managed);
    return structuredClone(managed.metadata);
  }

  private shutdownManaged(managed: ManagedTerminal): Promise<void> {
    if (managed.shutdown) return managed.shutdown;
    const id = managed.metadata.id;
    const task = Promise.resolve().then(async () => {
      try {
        managed.closed = true;
        this.cancelStartupSequence(managed);
        this.dataInterceptor?.closed(id);
        for (const observer of this.outputObservers) observer.closed(id);
        if (managed.backpressureTimer) clearInterval(managed.backpressureTimer);
        managed.backpressureTimer = undefined;
        await this.stopManagedRecording(managed).catch(() => {});
        this.disposeShellIntegration(managed);
        managed.disposeData();
        managed.disposeExit();
        managed.metadata = { ...managed.metadata, state: 'closed' };
        this.notifyMetadata(id);
        for (const [socket, attachment] of managed.sockets)
          this.finishExitedSocket(managed, socket, attachment);
      } finally {
        await managed.channel.close();
      }
    });
    managed.shutdown = task;
    this.shutdowns.set(id, task);
    void task.then(
      () => this.shutdowns.delete(id),
      () => {},
    );
    return task;
  }

  close(id: string): Promise<void> {
    const pending = this.closingChannels.get(id);
    if (pending) return pending;
    const managed = this.sessions.get(id);
    if (!managed) return Promise.resolve();
    this.sessions.delete(id);
    const task = Promise.resolve().then(async () => {
      // Explicit close revokes readers; a failed reader must never skip native channel cleanup.
      let cleanupError: unknown;
      try {
        for (const [socket, attachment] of managed.sockets) {
          try {
            attachment.dispose();
          } catch (error) {
            cleanupError ??= error;
          }
          try {
            socket.close(1000, 'terminal closed');
          } catch (error) {
            cleanupError ??= error;
          }
        }
      } finally {
        managed.sockets.clear();
        managed.clientCursors.clear();
        await this.shutdownManaged(managed);
      }
      if (cleanupError) throw cleanupError;
    });
    this.closingChannels.set(id, task);
    this.notifyChange({ type: 'remove', id });
    void task.then(
      () => this.closingChannels.delete(id),
      () => {},
    );
    return task;
  }

  activeTaskCount(): number {
    return (
      [...this.sessions.values()].filter(
        (session) => !session.closed && !this.shutdowns.has(session.metadata.id),
      ).length +
      new Set([...this.closingChannels.keys(), ...this.shutdowns.keys()]).size +
      this.openingChannels.size +
      this.recordingTasks.size
    );
  }

  resourceSnapshot(): Readonly<Record<string, number>> {
    return Object.freeze({
      terminals: this.resourceCount(),
      terminalStartupSequences: [...this.sessions.values()].filter(
        (item) => item.startupSequenceAbort !== undefined,
      ).length,
      terminalOutputConsumers: [...this.sessions.values()].reduce(
        (count, item) => count + item.sockets.size,
        0,
      ),
    });
  }
  resourceCount(): number {
    return (
      this.sessions.size +
      [...new Set([...this.closingChannels.keys(), ...this.shutdowns.keys()])].filter(
        (id) => !this.sessions.has(id),
      ).length +
      this.recordingTasks.size +
      this.openingChannels.size
    );
  }

  async closeAll(): Promise<void> {
    const pending = [...this.sessions.keys()].map((id) => this.close(id));
    const results = await Promise.allSettled([
      ...new Set([...pending, ...this.closingChannels.values()]),
    ]);
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('TERMINAL_DRAIN_FAILED');
  }

  /** Writes protocol bytes without text encoding or shell-integration buffering. */
  writeRaw(id: string, data: Uint8Array): void {
    this.assertAccepting();
    const managed = this.sessions.get(id);
    if (!managed || managed.closed)
      throw new ApplicationError('NOT_FOUND', 'Terminal not found', 404);
    managed.channel.write(data);
  }

  /** Publishes protocol-adjacent terminal output after the adapter has consumed a frame. */
  publishRawOutput(id: string, data: Uint8Array): void {
    this.assertAccepting();
    const managed = this.sessions.get(id);
    if (!managed || managed.closed || !data.byteLength) return;
    this.broadcast(managed, data);
  }

  setTransferState(id: string, transfer: TerminalTransferState): void {
    const managed = this.sessions.get(id);
    if (!managed) return;
    const parsed = terminalServerControlSchema.parse({ type: 'transfer', transfer });
    if (parsed.type !== 'transfer') return;
    managed.metadata = { ...managed.metadata, transfer: parsed.transfer };
    this.notifyMetadata(id);
    this.sendServerControl(id, parsed);
  }
  sendServerControl(id: string, control: TerminalServerControl): void {
    this.assertAccepting();
    const managed = this.sessions.get(id);
    if (!managed || managed.closed) return;
    const message = JSON.stringify(terminalServerControlSchema.parse(control));
    for (const socket of managed.sockets.keys()) {
      if (socket.readyState !== 1) continue;
      if (socket.bufferedAmount > SOCKET_HIGH_WATER) {
        socket.close(1008, 'terminal control consumer limit');
        continue;
      }
      socket.send(message, { binary: false });
    }
  }

  private recordOutput(managed: ManagedTerminal, data: Uint8Array): void {
    const recording = managed.recording;
    if (!recording) return;
    const writable = recording.writer.write(data);
    if (managed.recording !== recording) return;
    recording.metadata = {
      ...recording.metadata,
      bytesWritten: recording.writer.bytesWritten,
    };
    managed.metadata = { ...managed.metadata, recording: { ...recording.metadata } };
    this.notifyMetadata(managed.metadata.id);
    if (!writable && !recording.backpressured) {
      recording.backpressured = true;
      managed.channel.pause();
    }
  }

  private releaseRecordingBackpressure(managed: ManagedTerminal): void {
    const recording = managed.recording;
    if (!recording?.backpressured) return;
    recording.backpressured = false;
    this.refreshOutputFlow(managed, true);
  }

  private failRecording(managed: ManagedTerminal): void {
    const recording = managed.recording;
    if (!recording) return;
    managed.recording = undefined;
    const metadata: TerminalRecording = {
      ...recording.metadata,
      state: 'error',
      bytesWritten: recording.writer.bytesWritten,
      stoppedAt: new Date().toISOString(),
      errorCode: 'WRITE_FAILED',
    };
    this.trackRecordingClose(
      managed.metadata.id,
      Promise.resolve()
        .then(() => recording.writer.close())
        .then(
          () => structuredClone(metadata),
          () => structuredClone(metadata),
        ),
    );
    managed.metadata = { ...managed.metadata, recording: metadata };
    this.notifyMetadata(managed.metadata.id);
    this.publishRecordingState(managed, metadata);
    if (recording.backpressured) this.refreshOutputFlow(managed, true);
  }

  private stopManagedRecording(managed: ManagedTerminal): Promise<TerminalRecording> {
    const existing = this.recordingClosures.get(managed.metadata.id);
    if (existing) return existing;
    if (!managed.recording) return this.finishManagedRecording(managed);
    return this.trackRecordingClose(managed.metadata.id, this.finishManagedRecording(managed));
  }
  private trackRecordingClose(
    id: string,
    task: Promise<TerminalRecording>,
  ): Promise<TerminalRecording> {
    this.recordingClosures.set(id, task);
    this.recordingTasks.add(task);
    const release = () => {
      this.recordingTasks.delete(task);
      if (this.recordingClosures.get(id) === task) this.recordingClosures.delete(id);
    };
    void task.then(release, release);
    return task;
  }
  private async finishManagedRecording(managed: ManagedTerminal): Promise<TerminalRecording> {
    const recording = managed.recording;
    if (!recording) {
      const previous = managed.metadata.recording;
      if (previous) return { ...previous };
      throw new ApplicationError('INVALID_STATE', 'Terminal recording is not active', 409);
    }
    managed.recording = undefined;
    let state: TerminalRecording['state'] = 'stopped';
    try {
      await recording.writer.close();
    } catch {
      state = 'error';
    }
    const metadata: TerminalRecording = {
      ...recording.metadata,
      state,
      bytesWritten: recording.writer.bytesWritten,
      stoppedAt: new Date().toISOString(),
      ...(state === 'error' ? { errorCode: 'WRITE_FAILED' } : {}),
    };
    managed.metadata = { ...managed.metadata, recording: metadata };
    this.notifyMetadata(managed.metadata.id);
    this.publishRecordingState(managed, metadata);
    if (recording.backpressured) this.refreshOutputFlow(managed, true);
    return structuredClone(metadata);
  }

  private publishRecordingState(managed: ManagedTerminal, recording: TerminalRecording): void {
    const message = JSON.stringify({ type: 'recording', recording });
    for (const socket of managed.sockets.keys()) {
      if (socket.readyState !== 1) continue;
      if (socket.bufferedAmount > SOCKET_HIGH_WATER) {
        socket.close(1008, 'terminal control consumer limit');
        continue;
      }
      socket.send(message, { binary: false });
    }
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener('abort', finish, { once: true });
  });
}

function countLineFeeds(data: Uint8Array): number {
  let count = 0;
  for (const byte of data) if (byte === 0x0a) count += 1;
  return count;
}

function isOnlyTerminalWhitespace(data: Uint8Array): boolean {
  for (const byte of data)
    if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) return false;
  return true;
}
