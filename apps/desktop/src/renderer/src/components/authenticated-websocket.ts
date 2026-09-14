interface Registration {
  protocols: string[];
  remainingUses: number;
}

const registrations = new Map<string, Registration>();
let installedWindow: Window | undefined;

/**
 * IronRDP owns WebSocket construction internally. This exact-URL registry adds
 * the generation-bound subprotocols without putting authentication in a URL.
 */
export function registerAuthenticatedWebSocket(
  url: string,
  protocols: string[],
  maxUses = 1,
): () => void {
  installAuthenticatedWebSocket();
  const key = new URL(url, window.location.href).toString();
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 16)
    throw new Error('Authenticated WebSocket use limit must be between 1 and 16');
  registrations.set(key, { protocols: [...protocols], remainingUses: maxUses });
  return () => registrations.delete(key);
}

function installAuthenticatedWebSocket() {
  if (installedWindow === window) return;
  installedWindow = window;
  const NativeWebSocket = window.WebSocket;
  const AuthenticatedWebSocket = new Proxy(NativeWebSocket, {
    construct(target, argumentsList, newTarget) {
      const key = new URL(String(argumentsList[0]), window.location.href).toString();
      const registered = registrations.get(key);
      if (registered) {
        registered.remainingUses -= 1;
        if (!registered.remainingUses) registrations.delete(key);
        return Reflect.construct(target, [argumentsList[0], registered.protocols], newTarget);
      }
      return Reflect.construct(target, argumentsList, newTarget);
    },
  });
  window.WebSocket = AuthenticatedWebSocket;
}
