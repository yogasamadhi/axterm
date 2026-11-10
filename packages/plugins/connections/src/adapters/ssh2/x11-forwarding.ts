import { spawn } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';

export type LocalX11Endpoint = { path: string } | { host: '127.0.0.1'; port: number };

export interface ResolvedX11Forwarding {
  display: string;
  screen: number;
  cookie?: string;
  endpoint: LocalX11Endpoint;
}

const X11_CONNECT_TIMEOUT_MS = 800;
const XAUTH_TIMEOUT_MS = 1_000;
const XAUTH_OUTPUT_MAX_BYTES = 8 * 1024;

export async function resolveLocalX11(
  configuredDisplay?: string,
  platform: NodeJS.Platform = process.platform,
  environmentDisplay: string | undefined = process.env.DISPLAY,
): Promise<ResolvedX11Forwarding> {
  const display = (
    configuredDisplay ||
    environmentDisplay ||
    (platform === 'win32' ? ':0' : '')
  ).trim();
  if (!display) throw new Error('X11 forwarding requires DISPLAY or an explicit local display');
  const parsed = parseLocalX11Display(display, platform);
  let endpoint: LocalX11Endpoint | undefined;
  for (const candidate of parsed.endpoints) {
    if (await probeLocalX11(candidate)) {
      endpoint = candidate;
      break;
    }
  }
  if (!endpoint) throw new Error(`No local X server is reachable for display ${display}`);
  const cookie = platform === 'win32' ? undefined : await resolveXauthCookie(display, platform);
  return { display, screen: parsed.screen, ...(cookie ? { cookie } : {}), endpoint };
}

export function parseLocalX11Display(
  display: string,
  platform: NodeJS.Platform = process.platform,
): { screen: number; endpoints: LocalX11Endpoint[] } {
  const value = display.trim();
  if (!value || /[\0\r\n]/u.test(value)) throw new Error('Invalid X11 display');
  if (value.startsWith('/')) return { screen: 0, endpoints: [{ path: value }] };
  const match = /^(?:(localhost|127\.0\.0\.1):)?(\d+)(?:\.(\d+))?$/u.exec(
    value.startsWith(':') ? value.slice(1) : value,
  );
  if (!match) throw new Error('X11 display must be local (:N, localhost:N or a socket path)');
  const displayNumber = Number(match[2]);
  const screen = Number(match[3] ?? 0);
  if (displayNumber > 99 || screen > 99)
    throw new Error('X11 display and screen must be at most 99');
  const endpoints: LocalX11Endpoint[] = [];
  if (platform !== 'win32') endpoints.push({ path: `/tmp/.X11-unix/X${displayNumber}` });
  endpoints.push({ host: '127.0.0.1', port: 6_000 + displayNumber });
  return { screen, endpoints };
}

export function connectLocalX11(endpoint: LocalX11Endpoint): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const timer = setTimeout(
      () => finish(new Error('Local X server connection timed out')),
      X11_CONNECT_TIMEOUT_MS,
    );
    timer.unref();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
      if (error) {
        socket.destroy();
        reject(error);
      } else resolve(socket);
    };
    const onConnect = () => finish();
    const onError = (error: Error) => finish(error);
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

async function probeLocalX11(endpoint: LocalX11Endpoint): Promise<boolean> {
  try {
    const socket = await connectLocalX11(endpoint);
    socket.destroy();
    return true;
  } catch {
    return false;
  }
}

async function resolveXauthCookie(
  display: string,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const executables = platform === 'darwin' ? ['/opt/X11/bin/xauth', 'xauth'] : ['xauth'];
  for (const executable of executables) {
    const cookie = await readXauth(executable, display);
    if (cookie) return cookie;
  }
  return undefined;
}

function readXauth(executable: string, display: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(executable, ['list', display], {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let output = Buffer.alloc(0);
    let settled = false;
    const finish = (cookie?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeAllListeners();
      child.removeAllListeners();
      if (!child.killed) child.kill();
      resolve(cookie);
    };
    const timer = setTimeout(() => finish(), XAUTH_TIMEOUT_MS);
    timer.unref();
    child.once('error', () => finish());
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > XAUTH_OUTPUT_MAX_BYTES) return finish();
      output = Buffer.concat([output, chunk]);
    });
    child.once('close', (code) => {
      if (code !== 0) return finish();
      const match = /\bMIT-MAGIC-COOKIE-1\s+([0-9a-f]{32,})\b/iu.exec(output.toString('utf8'));
      finish(match?.[1]);
    });
  });
}
