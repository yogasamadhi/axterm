import { randomBytes, timingSafeEqual } from 'node:crypto';

const opaqueToken = () => randomBytes(32).toString('base64url');
const matches = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Generation-scoped, bounded, memory-only credentials. Owned by the HTTP runtime. */
export class RuntimeAuth {
  private bootstrapToken = opaqueToken();
  private bootstrapExpiresAt: number;
  private sessionToken: string | undefined;
  private windowStartedAt = 0;
  private attempts = 0;
  private disposed = false;

  constructor(private readonly now = Date.now) {
    this.bootstrapExpiresAt = now() + 30_000;
  }

  currentBootstrap(): string {
    return this.bootstrapToken;
  }

  rotateBootstrap(): string {
    if (this.disposed) throw new Error('Runtime authentication is closed');
    this.bootstrapToken = opaqueToken();
    this.bootstrapExpiresAt = this.now() + 30_000;
    return this.bootstrapToken;
  }

  allowAttempt(): boolean {
    if (this.now() - this.windowStartedAt >= 60_000) {
      this.windowStartedAt = this.now();
      this.attempts = 0;
    }
    return ++this.attempts <= 20;
  }

  exchange(token: string): string | undefined {
    if (
      this.disposed ||
      this.now() >= this.bootstrapExpiresAt ||
      !matches(token, this.bootstrapToken)
    )
      return undefined;
    this.rotateBootstrap();
    this.sessionToken = opaqueToken();
    return this.sessionToken;
  }

  authorize(header: string | undefined): boolean {
    return (
      !this.disposed &&
      !!this.sessionToken &&
      !!header &&
      matches(header, `Bearer ${this.sessionToken}`)
    );
  }

  authorizeToken(token: string | undefined): boolean {
    return !this.disposed && !!this.sessionToken && !!token && matches(token, this.sessionToken);
  }

  logout(): void {
    this.sessionToken = undefined;
  }

  dispose(): void {
    this.logout();
    this.bootstrapToken = '';
    this.disposed = true;
  }
}
