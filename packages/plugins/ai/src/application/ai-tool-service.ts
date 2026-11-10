import { pluginToolInputSchema } from '@axterm/plugin-api/plugins';
import type { AiPluginManagementPort } from '../ports/plugins.ts';
import type { AiToolIdentity } from '../ports/tools.ts';
import type { AiToolResourcesPort } from '../ports/tool-resources.ts';
import { z } from 'zod';
import type { AiToolCall } from '@axterm/plugin-api/ai';
import type { AiWorkspaceService } from './ai-workspace-service.ts';
import { ApplicationError } from './errors.ts';
import type { McpToolDefinition } from '../ports/mcp.ts';

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
    private readonly resources: AiToolResourcesPort,
    private readonly workspaces?: AiWorkspaceService,
    private readonly plugins?: AiPluginManagementPort,
  ) {}

  modelTools(): readonly string[] {
    return this.plugins?.available() ? ['plugins.manage'] : [];
  }
  modelProposal(name: string, args: Record<string, unknown>) {
    if (name !== 'plugins.manage' || !this.plugins?.available())
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Model tool is unavailable', 503);
    const parsed = z.object({ request: pluginToolInputSchema }).strict().parse(args);
    return { name, args: parsed.request, target: this.plugins.target };
  }
  mcpTools(): McpToolDefinition[] {
    const tools = structuredClone(mcpToolDefinitions);
    if (this.plugins?.available())
      tools.push(
        mcpTool(
          'plugins.manage',
          'Manage Profile plugins',
          'Each request requires explicit application approval. Builds require a separate request and approval.',
          z.toJSONSchema(z.object({ request: pluginToolInputSchema }).strict()),
          'privileged',
        ),
      );
    return tools;
  }

  mcpProposal(name: string, args: Record<string, unknown>) {
    this.risk(name);
    if (name === 'plugins.manage') return this.modelProposal(name, args);
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
    if (name === 'plugins.manage' && !this.plugins?.available())
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Plugin management is unavailable', 503);
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
      'workspace.exec': 'mutating',
      'plugins.manage': 'privileged',
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
    identity?: AiToolIdentity,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    if (name === 'plugins.manage') {
      if (!this.plugins?.available() || !identity || target !== this.plugins.target)
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'Plugin management admission is unavailable',
          412,
        );
      return this.plugins.invoke(
        identity.id,
        identity.generation,
        pluginToolInputSchema.parse(args),
        signal,
      );
    }
    if (name === 'workspace.exec' && this.workspaces)
      return this.workspaces.execute(target, args, signal);
    if (name === 'host.getSummary') {
      const host = this.resources.hostSummary(targetSchema.parse({ id: target }).id);
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
        output: this.resources.recentOutput(targetSchema.parse({ id: target }).id).slice(-65_536),
      };
    if (name === 'sftp.list')
      return abortAfter(
        this.resources.listRemote(
          sftpArgs.parse(args).connectionId,
          sftpArgs.parse(args).path,
          signal,
        ),
        signal,
      );
    if (name === 'sftp.readText') {
      const parsed = sftpArgs.parse(args);
      const result = await abortAfter(
        this.resources.readRemoteText(parsed.connectionId, parsed.path, signal),
        signal,
      );
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
      return this.resources.execReadOnly(parsed.connectionId, {
        command: commands[parsed.action],
        maxBytes: 128 * 1024,
        ...(signal ? { signal } : {}),
      });
    }
    if (name === 'system.inspectMemory') return this.resources.memory();
    if (name === 'system.inspectDisk')
      return this.resources.fixedCommand(
        this.resources.platform === 'win32' ? 'wmic' : 'df',
        this.resources.platform === 'win32'
          ? ['logicaldisk', 'get', 'size,freespace,caption']
          : ['-h'],
        signal,
      );
    if (name === 'system.inspectProcesses')
      return this.resources.fixedCommand(
        this.resources.platform === 'win32' ? 'tasklist' : 'ps',
        this.resources.platform === 'win32' ? [] : ['-axo', 'pid,comm,%cpu,%mem'],
        signal,
      );
    if (name === 'system.inspectService') {
      const parsed = serviceArgs.parse(args);
      return this.resources.fixedCommand(
        this.resources.platform === 'win32' ? 'sc.exe' : 'systemctl',
        this.resources.platform === 'win32'
          ? ['query', parsed.name]
          : ['status', '--no-pager', parsed.name],
        signal,
      );
    }
    if (name === 'terminal.exec') {
      const parsed = commandArgs.parse(args);
      await this.resources.insertCommand(
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

async function abortAfter<T>(promise: Promise<T> | T, signal?: AbortSignal): Promise<T> {
  const result = await promise;
  signal?.throwIfAborted();
  return result;
}
