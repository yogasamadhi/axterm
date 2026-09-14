import { execFile } from 'node:child_process';
import { freemem, loadavg, platform, totalmem, uptime } from 'node:os';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { AiToolCall } from '@workspace/contracts';
import type { ProductRepository } from '../adapters/sqlite/product-repository';
import type { ConnectionService } from './connection-service';
import type { SftpService } from './sftp-service';
import type { TerminalService } from './terminal-service';
import { ApplicationError } from './errors';
import type { McpToolDefinition } from '../ports/widget-server';

const execFileAsync = promisify(execFile);
const targetSchema = z.object({ id: z.uuid() }).strict();
const sftpArgs = z
  .object({ connectionId: z.uuid(), path: z.string().startsWith('/').max(4096) })
  .strict();
const commandArgs = z.object({ command: z.string().min(1).max(8192) }).strict();
const readActionArgs = z
  .object({
    action: z.enum(['uname', 'uptime', 'whoami', 'disk', 'memory', 'processes']),
    connectionId: z.uuid(),
  })
  .strict();
const serviceArgs = z.object({ name: z.string().regex(/^[a-zA-Z0-9_.@-]{1,100}$/) }).strict();
const mcpHostArgs = z.object({ hostId: z.uuid() }).strict();
const mcpTerminalArgs = z.object({ terminalId: z.uuid() }).strict();
const mcpTerminalCommandArgs = mcpTerminalArgs.extend(commandArgs.shape).strict();
const emptyArgs = z.object({}).strict();

const mcpToolDefinitions: McpToolDefinition[] = [
  mcpTool(
    'host.getSummary',
    'Host summary',
    'Read the non-secret connection fields for one saved host.',
    objectSchema({ hostId: stringSchema('Saved host UUID', 'uuid') }, ['hostId']),
    'read_only',
  ),
  mcpTool(
    'terminal.getRecentOutput',
    'Recent terminal output',
    'Read at most 64 KiB of recent output from one active terminal.',
    objectSchema({ terminalId: stringSchema('Active terminal UUID', 'uuid') }, ['terminalId']),
    'read_only',
  ),
  mcpTool(
    'terminal.execReadOnly',
    'Run a diagnostic command',
    'Run one fixed allowlisted diagnostic action on an existing SSH connection.',
    objectSchema(
      {
        connectionId: stringSchema('Ready SSH connection UUID', 'uuid'),
        action: {
          type: 'string',
          enum: ['uname', 'uptime', 'whoami', 'disk', 'memory', 'processes'],
        },
      },
      ['connectionId', 'action'],
    ),
    'read_only',
  ),
  mcpTool(
    'sftp.list',
    'List a remote directory',
    'List one absolute remote path through an existing SSH connection.',
    remotePathSchema('Remote directory path'),
    'read_only',
  ),
  mcpTool(
    'sftp.readText',
    'Read remote text',
    'Read a bounded UTF-8 text file through an existing SSH connection.',
    remotePathSchema('Remote text file path'),
    'read_only',
  ),
  mcpTool(
    'system.inspectDisk',
    'Inspect local disks',
    'Read bounded local disk usage from the Axterm Runtime.',
    objectSchema({}, []),
    'read_only',
  ),
  mcpTool(
    'system.inspectMemory',
    'Inspect local memory',
    'Read local memory, uptime and load information from the Axterm Runtime.',
    objectSchema({}, []),
    'read_only',
  ),
  mcpTool(
    'system.inspectProcesses',
    'Inspect local processes',
    'Read a bounded local process snapshot from the Axterm Runtime.',
    objectSchema({}, []),
    'read_only',
  ),
  mcpTool(
    'system.inspectService',
    'Inspect a local service',
    'Read status for one validated local service name.',
    objectSchema(
      {
        name: {
          type: 'string',
          description: 'Service name',
          pattern: '^[a-zA-Z0-9_.@-]{1,100}$',
        },
      },
      ['name'],
    ),
    'read_only',
  ),
  mcpTool(
    'terminal.exec',
    'Insert a terminal command',
    'Insert a command into an active terminal after explicit desktop approval.',
    objectSchema(
      {
        terminalId: stringSchema('Active terminal UUID', 'uuid'),
        command: {
          type: 'string',
          description: 'Command to insert',
          minLength: 1,
          maxLength: 8192,
        },
      },
      ['terminalId', 'command'],
    ),
    'mutating',
  ),
];

export class AiToolService {
  constructor(
    private readonly repository: ProductRepository,
    private readonly terminals: TerminalService,
    private readonly connections: ConnectionService,
    private readonly sftp: SftpService,
  ) {}

  mcpTools(): McpToolDefinition[] {
    return structuredClone(mcpToolDefinitions);
  }

  mcpProposal(name: string, args: Record<string, unknown>) {
    this.risk(name);
    if (name === 'host.getSummary') {
      const parsed = mcpHostArgs.parse(args);
      return { name, args: {}, target: parsed.hostId };
    }
    if (name === 'terminal.getRecentOutput') {
      const parsed = mcpTerminalArgs.parse(args);
      return { name, args: {}, target: parsed.terminalId };
    }
    if (name === 'terminal.execReadOnly') {
      const parsed = readActionArgs.parse(args);
      return { name, args: parsed, target: parsed.connectionId };
    }
    if (name === 'sftp.list' || name === 'sftp.readText') {
      const parsed = sftpArgs.parse(args);
      return { name, args: parsed, target: parsed.connectionId };
    }
    if (
      name === 'system.inspectDisk' ||
      name === 'system.inspectMemory' ||
      name === 'system.inspectProcesses'
    ) {
      emptyArgs.parse(args);
      return { name, args: {}, target: 'local-runtime' };
    }
    if (name === 'system.inspectService') {
      const parsed = serviceArgs.parse(args);
      return { name, args: parsed, target: 'local-runtime' };
    }
    if (name === 'terminal.exec') {
      const parsed = mcpTerminalCommandArgs.parse(args);
      return {
        name,
        args: { command: parsed.command },
        target: parsed.terminalId,
      };
    }
    throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI tool is not allowlisted', 503);
  }

  risk(name: string): AiToolCall['risk'] {
    const risks: Record<string, AiToolCall['risk']> = {
      'host.getSummary': 'read_only',
      'terminal.getRecentOutput': 'read_only',
      'terminal.execReadOnly': 'read_only',
      'sftp.list': 'read_only',
      'sftp.readText': 'read_only',
      'system.inspectDisk': 'read_only',
      'system.inspectMemory': 'read_only',
      'system.inspectProcesses': 'read_only',
      'system.inspectService': 'read_only',
      'terminal.exec': 'mutating',
    };
    const risk = risks[name];
    if (!risk)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI tool is not allowlisted', 503);
    return risk;
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    target: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    if (name === 'host.getSummary') {
      const host = this.repository.getHost(targetSchema.parse({ id: target }).id);
      return {
        id: host.id,
        name: host.name,
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        authType: host.authType,
      };
    }
    if (name === 'terminal.getRecentOutput')
      return {
        output: this.terminals.recentOutput(targetSchema.parse({ id: target }).id).slice(-65_536),
      };
    if (name === 'sftp.list')
      return abortAfter(
        this.sftp.list(sftpArgs.parse(args).connectionId, sftpArgs.parse(args).path),
        signal,
      );
    if (name === 'sftp.readText') {
      const parsed = sftpArgs.parse(args);
      const result = await abortAfter(this.sftp.readText(parsed.connectionId, parsed.path), signal);
      return { ...result, content: result.content.slice(0, 65_536) };
    }
    if (name === 'terminal.execReadOnly') {
      const parsed = readActionArgs.parse(args);
      const commands = {
        uname: 'uname -a',
        uptime: 'uptime',
        whoami: 'whoami',
        disk: 'df -h',
        memory: 'free -m',
        processes: 'ps -eo pid,comm,%cpu,%mem --sort=-%cpu | head -n 30',
      } as const;
      return this.connections.handle(parsed.connectionId).exec({
        command: commands[parsed.action],
        maxBytes: 128 * 1024,
        ...(signal ? { signal } : {}),
      });
    }
    if (name === 'system.inspectMemory')
      return {
        platform: platform(),
        totalBytes: totalmem(),
        freeBytes: freemem(),
        uptimeSeconds: uptime(),
        loadAverage: loadavg(),
      };
    if (name === 'system.inspectDisk')
      return fixedCommand(
        process.platform === 'win32' ? 'wmic' : 'df',
        process.platform === 'win32' ? ['logicaldisk', 'get', 'size,freespace,caption'] : ['-h'],
        signal,
      );
    if (name === 'system.inspectProcesses')
      return fixedCommand(
        process.platform === 'win32' ? 'tasklist' : 'ps',
        process.platform === 'win32' ? [] : ['-axo', 'pid,comm,%cpu,%mem'],
        signal,
      );
    if (name === 'system.inspectService') {
      const parsed = serviceArgs.parse(args);
      return fixedCommand(
        process.platform === 'win32' ? 'sc.exe' : 'systemctl',
        process.platform === 'win32'
          ? ['query', parsed.name]
          : ['status', '--no-pager', parsed.name],
        signal,
      );
    }
    if (name === 'terminal.exec') {
      const parsed = commandArgs.parse(args);
      await this.terminals.executeCommand(
        targetSchema.parse({ id: target }).id,
        parsed.command,
        signal,
      );
      return { inserted: true, commandLength: parsed.command.length };
    }
    throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI tool is not allowlisted', 503);
  }
}

function mcpTool(
  name: string,
  title: string,
  description: string,
  inputSchema: Record<string, unknown>,
  risk: McpToolDefinition['risk'],
): McpToolDefinition {
  return { name, title, description, inputSchema, risk };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function stringSchema(description: string, format?: string): Record<string, unknown> {
  return { type: 'string', description, ...(format ? { format } : {}) };
}

function remotePathSchema(description: string): Record<string, unknown> {
  return objectSchema(
    {
      connectionId: stringSchema('Ready SSH connection UUID', 'uuid'),
      path: {
        type: 'string',
        description,
        minLength: 1,
        maxLength: 4096,
        pattern: '^/',
      },
    },
    ['connectionId', 'path'],
  );
}

async function fixedCommand(file: string, args: string[], signal?: AbortSignal) {
  const { stdout, stderr } = await execFileAsync(file, args, {
    timeout: 5_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
    ...(signal ? { signal } : {}),
  });
  return { stdout: stdout.slice(0, 128 * 1024), stderr: stderr.slice(0, 16 * 1024) };
}

async function abortAfter<T>(promise: Promise<T> | T, signal?: AbortSignal): Promise<T> {
  const result = await promise;
  signal?.throwIfAborted();
  return result;
}
