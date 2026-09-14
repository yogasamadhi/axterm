const DEEP_LINK_SCHEMES = [
  'ssh',
  'telnet',
  'vnc',
  'rdp',
  'spice',
  'serial',
  'ftp',
  'axterm',
  'electerm',
] as const;
const INGRESS_SCHEMES = [...DEEP_LINK_SCHEMES, 'local'] as const;

const MAX_DEEP_LINK_BYTES = 16_384;
const MAX_PENDING_DEEP_LINKS = 32;
const schemePattern = new RegExp(`^(?:${INGRESS_SCHEMES.join('|')}):\\/\\/`, 'i');

interface RuntimeIngress {
  baseUrl: string;
  generation: string;
  token: string;
}

export function extractDeepLinks(argv: readonly string[]): string[] {
  return argv.filter(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_DEEP_LINK_BYTES && schemePattern.test(value),
  );
}

export class DesktopDeepLinkBridge {
  private readonly pending: string[] = [];
  private runtime: RuntimeIngress | undefined;
  private draining = false;

  constructor(
    private readonly focusWindow: () => void,
    private readonly transport: typeof fetch = globalThis.fetch,
  ) {}

  receive(source: string): boolean {
    if (Buffer.byteLength(source, 'utf8') > MAX_DEEP_LINK_BYTES || !schemePattern.test(source))
      return false;
    if (this.pending.length >= MAX_PENDING_DEEP_LINKS) this.pending.shift();
    this.pending.push(source);
    this.focusWindow();
    void this.drain();
    return true;
  }

  connect(runtime: RuntimeIngress): void {
    this.runtime = { ...runtime };
    void this.drain();
  }

  disconnect(): void {
    this.runtime = undefined;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.runtime) return;
    this.draining = true;
    try {
      while (this.runtime && this.pending[0]) {
        const runtime: RuntimeIngress = this.runtime;
        const source = this.pending[0];
        try {
          const response = await this.transport(
            new URL('/desktop/v1/deep-links', runtime.baseUrl),
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${runtime.token}`,
                'Content-Type': 'application/json',
                'X-Runtime-Generation': runtime.generation,
              },
              body: JSON.stringify({ source }),
              signal: AbortSignal.timeout(5_000),
            },
          );
          if (!response.ok) throw new Error('Runtime ingress rejected the deep link');
          if (this.runtime !== runtime) continue;
          this.pending.shift();
        } catch {
          if (this.runtime === runtime) this.runtime = undefined;
          break;
        }
      }
    } finally {
      this.draining = false;
      if (this.runtime && this.pending.length) void this.drain();
    }
  }
}

export const AXTERM_DEEP_LINK_SCHEMES = [...DEEP_LINK_SCHEMES];
