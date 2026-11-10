import type { ConnectionHandle, ConnectionWebSocket } from '@axterm/infra-connection/client';
import { idSchema } from '@axterm/plugin-api/catalog';
import {
  REMOTE_DESKTOP_CREDENTIAL_PATH,
  remoteDesktopCredentialsSchema,
  type RemoteDesktopCredentials,
} from '@axterm/plugin-api/remote-desktop';
/** One transient protocol claim. Never place its result in a Client model or replay it. */
export function claimRemoteDesktopCredentials(
  connection: Pick<ConnectionHandle, 'generation' | 'openWebSocket'>,
  id: string,
  signal?: AbortSignal,
): Promise<RemoteDesktopCredentials> {
  signal?.throwIfAborted();
  idSchema.parse(id);
  const generation = connection.generation.getSnapshot();
  if (!generation) return Promise.reject(new Error('REMOTE_DESKTOP_GENERATION_UNAVAILABLE'));
  const socket: ConnectionWebSocket = connection.openWebSocket(
    REMOTE_DESKTOP_CREDENTIAL_PATH + '?' + new URLSearchParams({ id }),
  );
  socket.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const clean = () => {
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener('abort', failed);
      socket.removeEventListener('message', message);
      socket.removeEventListener('error', failed);
      socket.removeEventListener('close', failed);
      socket.close();
    };
    const failed = () => {
      if (settled) return;
      settled = true;
      clean();
      reject(new Error('REMOTE_DESKTOP_CREDENTIAL_UNAVAILABLE'));
    };
    const message = (event: { data: unknown }) => {
      if (settled) return;
      if (
        !(event.data instanceof ArrayBuffer) ||
        !event.data.byteLength ||
        event.data.byteLength > 128 * 1024
      ) {
        failed();
        return;
      }
      try {
        const credentials = remoteDesktopCredentialsSchema.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(event.data)),
        );
        settled = true;
        clean();
        resolve(credentials);
      } catch {
        failed();
      }
    };
    const timer = setTimeout(failed, 10000);
    socket.addEventListener('message', message);
    socket.addEventListener('error', failed);
    socket.addEventListener('close', failed);
    signal?.addEventListener('abort', failed, { once: true });
    unsubscribe = connection.generation.subscribe(() => {
      if (connection.generation.getSnapshot() !== generation) failed();
    });
    if (settled) unsubscribe();
    if (signal?.aborted || connection.generation.getSnapshot() !== generation) failed();
  });
}
