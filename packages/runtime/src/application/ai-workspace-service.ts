import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { aiWorkspaceSchema, type AiWorkspace } from '@workspace/contracts';
import { z } from 'zod';
import type { TerminalService } from './terminal-service';
import type { ConnectionService } from './connection-service';
import { ApplicationError } from './errors';

import { executeWorkspaceCommand } from '../adapters/ai/workspace-command';
const commandSchema = z.object({ command: z.string().min(1).max(8192) }).strict();
const boundSchema = commandSchema.extend({ workspace: aiWorkspaceSchema }).strict();
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export class AiWorkspaceService {
  constructor(
    private readonly terminals: TerminalService,
    private readonly connections: ConnectionService,
    private readonly localHome = homedir(),
  ) {}

  async resolve(terminalId: string): Promise<AiWorkspace> {
    const terminal = this.terminals.get(terminalId);
    if (terminal.state !== 'ready')
      throw new ApplicationError('INVALID_STATE', 'AI target is not ready', 409);
    const directory = this.terminals.workingDirectory(terminalId);
    const local = terminal.kind === 'local';
    const remote = terminal.kind === 'ssh' && !!terminal.connectionId;
    const workspaceDirectory = local
      ? (directory ?? this.localHome)
      : join(this.localHome, '.axterm');
    if (!local) await mkdir(workspaceDirectory, { recursive: true, mode: 0o700 });
    if (remote && this.connections.get(terminal.connectionId!).state !== 'ready')
      throw new ApplicationError('INVALID_STATE', 'SSH connection is not ready', 409);
    return {
      terminalId,
      terminalKind: terminal.kind,
      workspaceDirectory,
      commandDirectory: local ? workspaceDirectory : directory,
      execution: local ? 'local' : remote ? 'ssh' : 'unavailable',
      ...(remote ? { connectionId: terminal.connectionId! } : {}),
    };
  }

  async bind(target: string, args: Record<string, unknown>) {
    const command = commandSchema.parse(args);
    return { ...command, workspace: await this.resolve(target) };
  }

  async execute(target: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const { command, workspace } = boundSchema.parse(args);
    let terminal;
    try {
      terminal = this.terminals.get(target);
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'NOT_FOUND')
        throw new ApplicationError('PRECONDITION_FAILED', 'AI execution target closed', 412);
      throw error;
    }
    if (
      workspace.terminalId !== target ||
      terminal.kind !== workspace.terminalKind ||
      terminal.state !== 'ready' ||
      terminal.connectionId !== workspace.connectionId
    )
      throw new ApplicationError('PRECONDITION_FAILED', 'AI execution target changed', 412);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 30_000);
    timer.unref();
    const boundedSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      boundedSignal.throwIfAborted();
      if (workspace.execution === 'ssh' && workspace.connectionId) {
        const result = await this.connections.exec(workspace.connectionId, {
          command: workspace.commandDirectory
            ? `cd -- ${quote(workspace.commandDirectory)} && (\n${command}\n)`
            : command,
          maxBytes: 128 * 1024,
          signal: boundedSignal,
        });
        return { ...result, execution: 'ssh', terminalId: target };
      }
      if (
        workspace.execution !== 'local' ||
        terminal.kind !== 'local' ||
        !workspace.commandDirectory
      )
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'AI command execution is unavailable',
          503,
        );
      const result = await executeWorkspaceCommand(
        command,
        workspace.commandDirectory,
        boundedSignal,
      );
      return { ...result, execution: 'local', terminalId: target };
    } catch (error) {
      if (boundedSignal.aborted)
        throw new ApplicationError('REQUEST_CANCELED', 'AI command canceled or timed out', 409);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
