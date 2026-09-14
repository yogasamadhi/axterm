import type { Readable, Writable } from 'node:stream';
import type { TerminalChannel } from './terminal-channel';
import type { SshAgentStatus, SshAlgorithms } from '@workspace/contracts';

export interface SshHostKey {
  algorithm: string;
  fingerprint: string;
  publicKey: string;
}

export interface SftpAttributes {
  size: number;
  mode: number;
  atime: number;
  mtime: number;
  uid: number;
  gid: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}
export interface SftpEntry {
  filename: string;
  attrs: SftpAttributes;
}
export class SftpCapabilityUnavailableError extends Error {
  constructor(readonly capability: 'atomic-replace') {
    super(`SFTP capability is unavailable: ${capability}`);
    this.name = 'SftpCapabilityUnavailableError';
  }
}
export interface SftpHandle {
  list(path: string): Promise<SftpEntry[]>;
  stat(path: string): Promise<SftpAttributes>;
  lstat(path: string): Promise<SftpAttributes>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  replace(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  readStream(path: string, options?: { start?: number; end?: number }): Readable;
  writeStream(path: string, options?: { flags?: 'w' | 'wx' | 'a'; mode?: number }): Writable;
  close(): Promise<void>;
}

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
  openSftp(): Promise<SftpHandle>;
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
