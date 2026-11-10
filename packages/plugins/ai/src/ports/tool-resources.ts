import type { Host } from '@axterm/plugin-api/catalog';
import type { RemoteFileEntry, RemoteText } from '@axterm/plugin-api/files';
export interface AiToolResourcesPort {
  readonly platform: string;
  hostSummary(
    id: string,
  ): Pick<Host, 'id' | 'name' | 'hostname' | 'port' | 'username' | 'authType'>;
  recentOutput(id: string): string;
  listRemote(connectionId: string, path: string, signal?: AbortSignal): Promise<RemoteFileEntry[]>;
  readRemoteText(connectionId: string, path: string, signal?: AbortSignal): Promise<RemoteText>;
  execReadOnly(
    connectionId: string,
    input: { command: string; maxBytes: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  memory(): {
    platform: string;
    totalBytes: number;
    freeBytes: number;
    uptimeSeconds: number;
    loadAverage: number[];
  };
  fixedCommand(
    file: string,
    args: string[],
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string }>;
  insertCommand(id: string, command: string, signal?: AbortSignal): Promise<void>;
}
