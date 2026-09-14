import { z } from 'zod';

export const healthSchema = z.object({ status: z.literal('ok') }).strict();
export const versionSchema = z
  .object({
    apiVersion: z.literal('v1'),
    appVersion: z.string(),
  })
  .strict();
export const runtimeMetadataSchema = z
  .object({
    runtimeId: z.uuid(),
    generation: z.uuid(),
    state: z.literal('ready'),
    startedAt: z.iso.datetime(),
    pid: z.number().int().positive(),
    mode: z.enum(['desktop', 'headless']),
  })
  .strict();
export const capabilitiesSchema = z
  .object({
    apiVersion: z.literal('v1'),
    capabilities: z.array(
      z.enum([
        'runtime.metadata',
        'persistence',
        'host.manager',
        'bookmark.tree',
        'connection.history',
        'command.history',
        'connection.profiles',
        'data.electerm',
        'data.sync',
        'quick-command.tree',
        'batch-operations',
        'terminal.triggers',
        'terminal.information',
        'widgets',
        'widgets.file-renamer',
        'widgets.local-file-server',
        'widgets.local-ftp-server',
        'widgets.local-ssh-server',
        'widgets.mcp-server',
        'terminal.local',
        'terminal.ssh',
        'proxy.ssh',
        'sftp',
        'sftp.recursive',
        'sftp.edit',
        'sftp.chmod',
        'ftp',
        'ftps',
        'ftp.recursive',
        'terminal.telnet',
        'terminal.serial',
        'terminal.transfers',
        'session.rdp',
        'session.vnc',
        'session.spice',
        'session.web',
        'tunnels',
        'ai',
        'ai.tools',
        'desktop.window',
        'desktop.deep-links',
      ]),
    ),
  })
  .strict();
export const bootstrapRequestSchema = z
  .object({
    bootstrapToken: z.string().min(32).max(256),
  })
  .strict();
export const bootstrapResponseSchema = z
  .object({
    sessionToken: z.string().min(32),
    generation: z.uuid(),
    runtimeId: z.uuid(),
  })
  .strict();
export type RuntimeMetadata = z.infer<typeof runtimeMetadataSchema>;
