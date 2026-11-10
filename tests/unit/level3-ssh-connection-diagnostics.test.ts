import { sshOperationDiagnosticSchema } from '@axterm/plugin-api/catalog';
import { expect, it, vi } from 'vitest';
import { connectionSchema } from '@axterm/plugin-api/connections';
import type { ConnectionsState } from '../../packages/plugins/connections/src/client/index.ts';
import { ConnectionWorkspaceAdmissions } from '../../packages/plugins/connections/src/client/ui/workspace-owner.ts';
it('uses the captured failed connection and actual admission identity, dropping unrecognized provider codes before UI delivery', async () => {
  for (const code of ['SSH_CONNECTION_REFUSED', 'password=PRIVATE_SSH_FAILURE'] as const) {
    const generation = crypto.randomUUID();
    const row = connectionSchema.parse({
      id: crypto.randomUUID(),
      hostId: crypto.randomUUID(),
      state: 'failed',
      errorCode: code,
      reconnectAttempt: 0,
      nextReconnectAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const state: ConnectionsState = {
      status: 'ready',
      baseline: {
        generation,
        cursor: 0,
        revision: 0,
        connections: [row],
        ftpConnections: [],
        interactions: [],
        knownHosts: [],
        tunnelProfiles: [],
        tunnels: [],
      },
    };
    const listeners = new Set<() => void>();
    const model = {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      createConnection: vi.fn(async (_key: string) => row),
      reconnectConnectionHistory: vi.fn(),
      getConnectionCommandOutcome: vi.fn(),
      closeConnection: vi.fn(async () => {}),
    };
    const terminals = { open: vi.fn(), activate: vi.fn() };
    const owner = new ConnectionWorkspaceAdmissions(model, terminals);
    const error: unknown = await owner
      .openSsh({ hostId: row.hostId })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'connections/failure',
      details: { reason: 'unavailable' },
    });
    if (code === 'SSH_CONNECTION_REFUSED')
      expect(error).toMatchObject({
        details: { diagnostic: { code, operationId: model.createConnection.mock.calls[0]![0] } },
      });
    else expect(JSON.stringify(error)).not.toContain('PRIVATE_SSH_FAILURE');
    expect(terminals.open).not.toHaveBeenCalled();
    expect(model.closeConnection).toHaveBeenCalledExactlyOnceWith(row.id, generation);
    expect(listeners.size).toBe(0);
    await owner.dispose();
  }
});

it('rejects invalid public diagnostic codes, dynamic fields, excess labels and invented operation identifiers', () => {
  const value = {
    code: 'HOST_NAME_CONFLICT',
    fields: ['host.name'],
    operationId: crypto.randomUUID(),
  };
  expect(sshOperationDiagnosticSchema.parse(value)).toEqual(value);
  for (const invalid of [
    { ...value, code: 'PRIVATE_VALUE' },
    { ...value, fields: ['host.startup.environment.PRIVATE_VALUE'] },
    { ...value, fields: Array.from({ length: 9 }, () => 'host.port') },
    { ...value, operationId: 'PRIVATE_VALUE' },
    { ...value, message: 'password=PRIVATE_VALUE' },
  ])
    expect(sshOperationDiagnosticSchema.safeParse(invalid).success).toBe(false);
});
