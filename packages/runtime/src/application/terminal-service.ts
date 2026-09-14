import { randomUUID } from 'node:crypto';
import iconv from 'iconv-lite';
import type {
  TerminalAppearance,
  TerminalBehavior,
  TerminalRecording,
  TerminalServerControl,
  TerminalSession,
} from '@workspace/contracts';
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_BEHAVIOR,
  DEFAULT_TERMINAL_TYPE,
  TERMINAL_INPUT_FRAME_MAX_BYTES,
  TERMINAL_REPLAY_MAX_BYTES,
  terminalControlSchema,
  terminalServerControlSchema,
} from '@workspace/contracts';
import type { PtyPort, TerminalChannel } from '../ports/terminal-channel';
import type { ShellIntegrationKind } from '../ports/terminal-channel';
import { ApplicationError } from './errors';
import { createShellIntegrationCommand, SHELL_INTEGRATION_MARKER } from './shell-integration';
import { TerminalRecordingWriter } from './terminal-recording';

export interface TerminalSocket {
  readonly bufferedAmount: number;
  readonly readyState: number;
  send(data: Uint8Array | string, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: 'close' | 'error', listener: () => void): void;
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

export interface TerminalStartupStep {
  text: string;
  delayMs: number;
  sendEnter: boolean;
  waitForOutput: boolean;
  settleIdleMs: number;
  settleTimeoutMs: number;
}

interface ManagedTerminal {
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
  backpressureTimer: ReturnType<typeof setInterval> | undefined;
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
  writer: TerminalRecordingWriter;
  metadata: TerminalRecording;
  backpressured: boolean;
}

interface RecentChunk {
  sequence: number;
  data: Buffer;
}

interface SocketAttachment {
  clientId: string;
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

export class TerminalService {
  private readonly sessions = new Map<string, ManagedTerminal>();
  private dataInterceptor: TerminalDataInterceptor | undefined;
  private readonly outputObservers = new Set<TerminalOutputObserver>();

  constructor(private readonly pty: PtyPort) {}

  setDataInterceptor(interceptor: TerminalDataInterceptor): void {
    if (this.dataInterceptor && this.dataInterceptor !== interceptor)
      throw new ApplicationError('INVALID_STATE', 'Terminal data interceptor is already set', 409);
    this.dataInterceptor = interceptor;
  }

  addOutputObserver(observer: TerminalOutputObserver): () => void {
    this.outputObservers.add(observer);
    return () => this.outputObservers.delete(observer);
  }

  createLocal(input: {
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
  }): TerminalSession {
    const id = randomUUID();
    const channel = this.pty.open({
      ...(input.shell ? { shell: input.shell } : {}),
      args: input.shellArgs ?? [],
      ...(input.cwd ? { cwd: input.cwd } : {}),
      env: input.env ?? {},
      term: input.term ?? DEFAULT_TERMINAL_TYPE,
      loginShell: input.loginShell ?? false,
      cols: input.cols,
      rows: input.rows,
    });
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
      for (const socket of managed.sockets.keys()) {
        if (socket.readyState === 1)
          socket.send(JSON.stringify({ type: 'exit', exitCode }), { binary: false });
        socket.close(1000, 'terminal exited');
      }
      managed.sockets.clear();
      managed.clientCursors.clear();
      managed.disposeData();
      managed.disposeExit();
    });
    this.sessions.set(id, managed);
    this.startShellIntegration(managed, channel.shellIntegrationKind ?? 'unsupported');
    return { ...metadata };
  }

  registerExternal(
    metadata: TerminalSession,
    channel: TerminalChannel,
    shellIntegrationKind: ShellIntegrationKind = channel.shellIntegrationKind ?? 'unsupported',
  ): TerminalSession {
    const managed: ManagedTerminal = {
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
      for (const socket of managed.sockets.keys()) {
        if (socket.readyState === 1)
          socket.send(JSON.stringify({ type: 'exit', exitCode }), { binary: false });
        socket.close(1000, 'terminal exited');
      }
      managed.sockets.clear();
      managed.clientCursors.clear();
      managed.disposeData();
      managed.disposeExit();
    });
    this.sessions.set(metadata.id, managed);
    this.startShellIntegration(managed, shellIntegrationKind);
    return { ...metadata };
  }

  list(): TerminalSession[] {
    return [...this.sessions.values()].map(({ metadata }) => ({ ...metadata }));
  }

  get(id: string): TerminalSession {
    const managed = this.sessions.get(id);
    if (!managed) throw new ApplicationError('NOT_FOUND', 'Terminal not found', 404);
    return { ...managed.metadata };
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

  async startRecording(
    id: string,
    input: { path: string; fileName: string; timestamps: boolean; includeRecent: boolean },
  ): Promise<TerminalRecording> {
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
    let writer: TerminalRecordingWriter;
    try {
      writer = await TerminalRecordingWriter.open({
        path: input.path,
        encoding: managed.metadata.behavior.encoding,
        timestamps: input.timestamps,
        onDrain: () => this.releaseRecordingBackpressure(managed),
        onError: () => this.failRecording(managed),
      });
    } catch {
      throw new ApplicationError('INVALID_STATE', 'Unable to open the granted log file', 409);
    }
    managed.recording = { writer, metadata, backpressured: false };
    managed.metadata = { ...managed.metadata, recording: { ...metadata } };
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

  attach(id: string, socket: TerminalSocket, clientId: string = randomUUID()): void {
    const managed = this.sessions.get(id);
    if (!managed || managed.closed)
      throw new ApplicationError('NOT_FOUND', 'Terminal not found', 404);

    for (const [attachedSocket, attachment] of managed.sockets) {
      if (attachment.clientId !== clientId) continue;
      managed.sockets.delete(attachedSocket);
      attachedSocket.close(1000, 'terminal client replaced');
    }
    managed.sockets.set(socket, { clientId });
    this.touchClientCursor(managed, clientId, managed.clientCursors.get(clientId)?.sequence ?? 0);
    socket.send(JSON.stringify({ type: 'ready' }), { binary: false });
    socket.send(
      JSON.stringify({ type: 'shellIntegration', state: managed.shellIntegrationState }),
      { binary: false },
    );
    if (managed.metadata.recording)
      socket.send(JSON.stringify({ type: 'recording', recording: managed.metadata.recording }), {
        binary: false,
      });
    this.replayToSocket(managed, socket, clientId);
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
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
      if (control.type === 'resize') managed.channel.resize(control.cols, control.rows);
      else if (control.type === 'signal') managed.channel.signal(control.signal);
      else if (control.type === 'ping')
        socket.send(JSON.stringify({ type: 'pong', nonce: control.nonce }));
      else void this.close(id);
    });
    const detach = () => managed.sockets.delete(socket);
    socket.on('close', detach);
    socket.on('error', detach);
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
    if (recoveryOutput.length) this.broadcast(managed, recoveryOutput);
    this.flushPendingInput(managed);
  }

  private publishShellIntegrationState(managed: ManagedTerminal): void {
    const message = JSON.stringify({
      type: 'shellIntegration',
      state: managed.shellIntegrationState,
    });
    for (const socket of managed.sockets.keys())
      if (socket.readyState === 1) socket.send(message, { binary: false });
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
      socket.send(data, { binary: true });
      this.touchClientCursor(managed, attachment.clientId, chunk.sequence);
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
            managed.channel.resume();
          }
        }
      }, 25);
      managed.backpressureTimer.unref();
    }
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
    const previousSequence = managed.clientCursors.get(clientId)?.sequence ?? 0;
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
    for (const chunk of chunks) socket.send(chunk.data, { binary: true });
    this.touchClientCursor(managed, clientId, managed.nextSequence - 1);
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

  async close(id: string): Promise<void> {
    const managed = this.sessions.get(id);
    if (!managed) return;
    this.sessions.delete(id);
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
    for (const socket of managed.sockets.keys()) socket.close(1000, 'terminal closed');
    managed.sockets.clear();
    managed.clientCursors.clear();
    await managed.channel.close();
    managed.metadata = { ...managed.metadata, state: 'closed' };
  }

  resourceCount(): number {
    return this.sessions.size;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  /** Writes protocol bytes without text encoding or shell-integration buffering. */
  writeRaw(id: string, data: Uint8Array): void {
    const managed = this.sessions.get(id);
    if (!managed || managed.closed)
      throw new ApplicationError('NOT_FOUND', 'Terminal not found', 404);
    managed.channel.write(data);
  }

  /** Publishes protocol-adjacent terminal output after the adapter has consumed a frame. */
  publishRawOutput(id: string, data: Uint8Array): void {
    const managed = this.sessions.get(id);
    if (!managed || managed.closed || !data.byteLength) return;
    this.broadcast(managed, data);
  }

  sendServerControl(id: string, control: TerminalServerControl): void {
    const managed = this.sessions.get(id);
    if (!managed || managed.closed) return;
    const message = JSON.stringify(terminalServerControlSchema.parse(control));
    for (const socket of managed.sockets.keys())
      if (socket.readyState === 1) socket.send(message, { binary: false });
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
    if (!writable && !recording.backpressured) {
      recording.backpressured = true;
      managed.channel.pause();
    }
  }

  private releaseRecordingBackpressure(managed: ManagedTerminal): void {
    const recording = managed.recording;
    if (!recording?.backpressured) return;
    recording.backpressured = false;
    if (!managed.closed && !managed.backpressureTimer) managed.channel.resume();
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
    managed.metadata = { ...managed.metadata, recording: metadata };
    this.publishRecordingState(managed, metadata);
    if (recording.backpressured && !managed.closed && !managed.backpressureTimer)
      managed.channel.resume();
  }

  private async stopManagedRecording(managed: ManagedTerminal): Promise<TerminalRecording> {
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
    this.publishRecordingState(managed, metadata);
    if (recording.backpressured && !managed.closed && !managed.backpressureTimer)
      managed.channel.resume();
    return { ...metadata };
  }

  private publishRecordingState(managed: ManagedTerminal, recording: TerminalRecording): void {
    const message = JSON.stringify({ type: 'recording', recording });
    for (const socket of managed.sockets.keys())
      if (socket.readyState === 1) socket.send(message, { binary: false });
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
