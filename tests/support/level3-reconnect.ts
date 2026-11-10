import { expect, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionHandle } from '@axterm/infra-connection/client';
import type WebSocket from 'ws';

/** Await the real next transport generation before issuing a new explicit command. */
export async function reconnectLevel3Client(context: Context, sockets: Set<WebSocket>) {
  // The repository-wide test tsconfig includes the Host face; this is the installed Client face.
  const connection = context.get('connection') as unknown as ConnectionHandle;
  const before = connection.generation.getSnapshot();
  expect(before).toBeDefined();
  for (const socket of sockets) socket.terminate();
  await vi.waitFor(() => {
    const after = connection.generation.getSnapshot();
    expect(after !== undefined && after.id > before!.id).toBe(true);
    expect(connection.state.getSnapshot()).toBe('connected');
  });
}
