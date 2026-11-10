import { z } from 'zod';
import { remoteErrorOf } from '@axterm/plugin-api';
import { aiWorkspaceSchema, type AiWorkspace } from '@axterm/plugin-api/ai';
import type { TerminalApplication, ConnectionsApplication } from '@axterm/plugin-api/host';
import type { AiWorkspaceCommands } from '../ports/workspace-command.ts';
import { ApplicationError } from './errors.ts';
const commandSchema = z.object({ command: z.string().min(1).max(8192) }).strict();
const boundSchema = commandSchema.extend({ workspace: aiWorkspaceSchema }).strict();
/** Only selected owner projections are used; no native object or direct filesystem IO enters the application. */
export class AiWorkspaceService {
  constructor(
    private readonly terminals: Pick<TerminalApplication, 'get' | 'workingDirectory'>,
    private readonly connections: Pick<ConnectionsApplication, 'get' | 'executionTarget' | 'exec'>,
    private readonly commands: AiWorkspaceCommands,
    private readonly paths: { localHome: string; remoteWorkspace: string },
  ) {}
  async resolve(terminalId: string): Promise<AiWorkspace> {
    const terminal = readTarget(() => this.terminals.get(terminalId));
    if (terminal.state !== 'ready')
      throw new ApplicationError('INVALID_STATE', 'AI target is not ready');
    const directory = readTarget(() => this.terminals.workingDirectory(terminalId));
    const local = terminal.kind === 'local';
    const remote = terminal.kind === 'ssh' && !!terminal.connectionId;
    if (remote && readTarget(() => this.connections.get(terminal.connectionId!)).state !== 'ready')
      throw new ApplicationError('INVALID_STATE', 'SSH target is not ready');
    return aiWorkspaceSchema.parse({
      terminalId,
      terminalKind: terminal.kind,
      workspaceDirectory: local ? (directory ?? this.paths.localHome) : this.paths.remoteWorkspace,
      commandDirectory: local ? (directory ?? this.paths.localHome) : directory,
      execution: local ? 'local' : remote ? 'ssh' : 'unavailable',
      ...(remote
        ? {
            connectionId: terminal.connectionId!,
            sshTarget: readTarget(() => this.connections.executionTarget(terminal.connectionId!)),
          }
        : {}),
    });
  }
  async bind(target: string, args: Record<string, unknown>) {
    return { ...commandSchema.parse(args), workspace: await this.resolve(target) };
  }
  targetReady(workspace: AiWorkspace): boolean {
    try {
      const terminal = this.terminals.get(workspace.terminalId);
      return (
        terminal.state === 'ready' &&
        terminal.kind === workspace.terminalKind &&
        terminal.connectionId === workspace.connectionId &&
        (!workspace.connectionId ||
          (this.connections.get(workspace.connectionId).state === 'ready' &&
            !!workspace.sshTarget &&
            JSON.stringify(this.connections.executionTarget(workspace.connectionId)) ===
              JSON.stringify(workspace.sshTarget)))
      );
    } catch {
      return false;
    }
  }
  async execute(target: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const { command, workspace } = boundSchema.parse(args);
    if (workspace.terminalId !== target || !this.targetReady(workspace))
      throw new ApplicationError('PRECONDITION_FAILED', 'AI execution target changed', 412);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 30000);
    timer.unref();
    const owned = AbortSignal.any([timeout.signal, ...(signal ? [signal] : [])]);
    try {
      owned.throwIfAborted();
      if (workspace.execution === 'ssh' && workspace.connectionId) {
        const result = await this.connections.exec(workspace.connectionId, {
          command: this.commands.facts(command, workspace).command,
          maxBytes: 128 * 1024,
          signal: owned,
        });
        return { ...result, execution: 'ssh', terminalId: target };
      }
      if (workspace.execution !== 'local' || !workspace.commandDirectory)
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'AI command execution unavailable',
          503,
        );
      const result = await this.commands.execute(command, workspace.commandDirectory, owned);
      return { ...result, execution: 'local', terminalId: target };
    } catch (error) {
      if (owned.aborted)
        throw new ApplicationError('REQUEST_CANCELED', 'AI command canceled or timed out');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Only known public target-retirement failures imply an invalid execution binding. */
function readTarget<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    const marked = remoteErrorOf(error);
    if (
      marked &&
      (marked.code === 'connections/failure' || marked.code === 'terminals/failure') &&
      ['not-found', 'closed', 'stale'].includes(marked.details.reason)
    )
      throw new ApplicationError('INVALID_STATE', 'AI execution target is no longer ready');
    throw error;
  }
}
