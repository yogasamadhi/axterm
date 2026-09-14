import type { Connection, CreateConnectionInput, Host } from '@workspace/contracts';

export interface ConnectionHistoryRecorder {
  recordSuccessful(input: { host: Host; persistedHostId: string | null }): void;
}

export interface ConnectionStarter {
  create(input: CreateConnectionInput): Connection;
}
