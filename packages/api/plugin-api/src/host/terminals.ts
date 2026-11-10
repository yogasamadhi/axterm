import type * as Contract from '../terminals.ts';
import type { RelationalParticipant } from '../storage.ts';
import type { TerminalSession } from '../terminals.ts';
import type { TerminalChannel, ShellIntegrationKind } from './terminal-channel.ts';
export interface TerminalStartupStep {
  text: string;
  delayMs: number;
  sendEnter: boolean;
  waitForOutput: boolean;
  settleIdleMs: number;
  settleTimeoutMs: number;
}
export interface TerminalOutputObserver {
  receive(terminalId: string, data: Uint8Array, encoding: string): void;
  closed(terminalId: string): void;
}
export interface TerminalApplication {
  addOutputObserver(observer: TerminalOutputObserver): () => void;
  insertText(id: string, text: string): void;
  /** Application-authorized interactive insertion; waits for startup input and honors cancellation. */
  executeCommand(id: string, command: string, signal?: AbortSignal): Promise<void>;
  registerExternal(
    metadata: Omit<TerminalSession, 'id'>,
    channel: TerminalChannel,
    kind?: ShellIntegrationKind,
  ): TerminalSession;
  enqueueStartupSequence(id: string, steps: TerminalStartupStep[]): void;
  list(): TerminalSession[];
  get(id: string): TerminalSession;
  /** Readonly workspace projection. Null means no confirmed command directory. */
  workingDirectory(id: string): string | null;
  /** At most 64 KiB of decoded UTF-8 text; terminal byte buffers remain private. */
  recentOutput(id: string): string;
  /** Drain the native channel while retaining the bounded read-only session and view. */
  disconnect(id: string): Promise<TerminalSession>;
  close(id: string): Promise<void>;
  resourceCount(): number;
}
export interface TerminalHistoryOwner {
  readonly participant: RelationalParticipant;
  state(): { readonly revision: number; readonly etag: string };
  purge(): { readonly deletedCount: number };
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    terminalHistory: TerminalHistoryOwner;
    terminalFacts: TerminalFactsOwner;
    terminals: TerminalApplication;
  }
}

export interface TerminalFactsOwner {
  readonly participant: RelationalParticipant;
  listProfiles(): Contract.TerminalProfile[];
  getProfile(id: string): Contract.TerminalProfile;
  listThemes(): Contract.TerminalTheme[];
  listHistory(input?: Contract.CommandHistoryPageQuery): Contract.CommandHistoryPage;
  createProfile(key: string, input: Contract.TerminalProfileInput): Contract.TerminalFactsReceipt;
  updateProfile(
    key: string,
    id: string,
    input: Contract.TerminalProfilePatch,
    ifMatch: string | undefined,
  ): Contract.TerminalFactsReceipt;
  deleteProfile(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Contract.TerminalFactsReceipt;
  createTheme(key: string, input: Contract.TerminalThemeInput): Contract.TerminalFactsReceipt;
  cloneTheme(key: string, id: string, name?: string): Contract.TerminalFactsReceipt;
  updateTheme(
    key: string,
    id: string,
    input: Contract.TerminalThemePatch,
    ifMatch: string | undefined,
  ): Contract.TerminalFactsReceipt;
  deleteTheme(key: string, id: string, ifMatch: string | undefined): Contract.TerminalFactsReceipt;
  recordHistory(
    key: string,
    input: Contract.RecordCommandHistoryInput,
  ): Contract.RecordCommandHistoryResult;
  deleteHistory(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Contract.DeleteCommandHistoryResult;
  clearHistory(key: string, ifMatch: string | undefined): Contract.ClearCommandHistoryResult;
  watch(signal: AbortSignal): AsyncIterable<Contract.TerminalFactsUpdate>;
}

/** Readonly metadata facet; background bytes and mutation stay in their owner. */
export interface TerminalAssetReferences {
  readonly participant: RelationalParticipant;
  get(id: string): Contract.TerminalBackgroundMetadata;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    terminalAssetReferences: TerminalAssetReferences;
  }
}
