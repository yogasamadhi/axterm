import { DESKTOP_AUTH_HEADER } from '@axterm/infra-connection';
export const APP_ORIGIN = 'axterm-app://app';
export const APP_URL = APP_ORIGIN + '/';
export interface FrameIdentity {
  readonly processId: number;
  readonly routingId: number;
  readonly url: string;
}
export interface WindowIdentity {
  readonly id: number;
  readonly frame: FrameIdentity;
}
export interface WindowRequest {
  readonly url: string;
  readonly webContentsId?: number;
  readonly frame?: FrameIdentity | null;
  readonly requestHeaders: Readonly<Record<string, string>>;
}
export interface HostAuthority {
  readonly generation: string;
  readonly origin: string;
  readonly credential: string;
}
export function isApplicationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'axterm-app:' && url.host === 'app' && !url.username && !url.password;
  } catch {
    return false;
  }
}
export function isApplicationDocument(value: string): boolean {
  if (!isApplicationUrl(value)) return false;
  const url = new URL(value);
  return ['/', '/index.html'].includes(url.pathname) && !url.searchParams.has('token');
}
export function ownsMainFrame(
  request: Pick<WindowRequest, 'webContentsId' | 'frame'>,
  owner: WindowIdentity | undefined,
): boolean {
  return (
    owner !== undefined &&
    request.webContentsId === owner.id &&
    request.frame !== undefined &&
    request.frame !== null &&
    request.frame.processId === owner.frame.processId &&
    request.frame.routingId === owner.frame.routingId &&
    isApplicationDocument(request.frame.url) &&
    isApplicationDocument(owner.frame.url)
  );
}
export function isHostWebSocket(value: string, host: HostAuthority | undefined): boolean {
  if (!host) return false;
  try {
    const url = new URL(value);
    const target = new URL(host.origin);
    return (
      url.protocol === 'ws:' &&
      url.host === target.host &&
      !url.username &&
      !url.password &&
      !url.searchParams.has('token')
    );
  } catch {
    return false;
  }
}
/** Strip first on every destination; only an owned frame's exact current Host WS receives a credential. */
export function webSocketHeaders(
  request: WindowRequest,
  owner: WindowIdentity | undefined,
  host: HostAuthority | undefined,
): { cancel?: boolean; requestHeaders: Record<string, string> } {
  const headers = Object.fromEntries(
    Object.entries(request.requestHeaders).map(([key, value]) => [key.toLowerCase(), value]),
  );
  delete headers[DESKTOP_AUTH_HEADER];
  if (!isHostWebSocket(request.url, host)) return { requestHeaders: headers };
  if (!ownsMainFrame(request, owner) || headers.origin !== APP_ORIGIN)
    return { cancel: true, requestHeaders: headers };
  delete headers.cookie;
  delete headers.authorization;
  headers[DESKTOP_AUTH_HEADER] = host!.credential;
  headers.origin = host!.origin;
  headers['sec-fetch-site'] = 'same-origin';
  return { requestHeaders: headers };
}
