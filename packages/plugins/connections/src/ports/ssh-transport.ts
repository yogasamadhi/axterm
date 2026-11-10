import type { Readable } from 'node:stream';
import type { TerminalChannel } from './terminal-channel.ts';
import type { SshAgentStatus, SshAlgorithms } from '@axterm/plugin-api/connections';

export interface SshHostKey {
  algorithm: string;
  fingerprint: string;
  publicKey: string;
}

import type { RemoteFilesystem } from '@axterm/plugin-api/host';
export { RemoteFileCapabilityUnavailableError } from '@axterm/plugin-api/host';
export type {
  RemoteFileAttributes,
  RemoteFilesystemEntry,
  RemoteFilesystem,
} from '@axterm/plugin-api/host';

export interface SshConnectionHandle {
  readonly id: string;
  onClose(listener: (error?: Error) => void): () => void;
  openShell(input: {
    cols: number;
    rows: number;
    term: string;
    env: Record<string, string>;
    x11?: { display?: string };
  }): Promise<TerminalChannel>;
  openSftp(signal?: AbortSignal): Promise<RemoteFilesystem>;
  exec(input: {
    command: string;
    maxBytes?: number;
    signal?: AbortSignal;
  }): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  forwardOut(
    source: { host: string; port: number },
    target: { host: string; port: number },
  ): Promise<NodeJS.ReadWriteStream>;
  forwardIn(
    host: string,
    port: number,
    listener: (
      info: {
        sourceHost: string;
        sourcePort: number;
        destinationHost: string;
        destinationPort: number;
      },
      channel: NodeJS.ReadWriteStream,
    ) => void,
  ): Promise<number>;
  unforwardIn(host: string, port: number): Promise<void>;
  close(): Promise<void>;
}

export interface SshTransport {
  agentStatus?(path?: string): Promise<SshAgentStatus>;
  connect(input: {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    certificate?: string;
    agent?: string;
    socket?: Readable;
    signal?: AbortSignal;
    connectionTimeoutMs: number;
    keepaliveIntervalMs: number;
    keepaliveCountMax: number;
    compression: boolean;
    algorithms: SshAlgorithms;
    verifyHostKey(key: SshHostKey): Promise<boolean>;
    keyboardInteractive(input: {
      name: string;
      instructions: string;
      prompts: Array<{ prompt: string; echo: boolean }>;
    }): Promise<string[]>;
  }): Promise<SshConnectionHandle>;
}
