/** One page-owned, bounded loader for same-authority plugin factory scripts. */
export class ScriptBundleTransport {
  private readonly pending = new Set<() => void>();
  private closed = false;
  constructor(
    private readonly document: Document,
    private readonly timeoutMs = 15_000,
    private readonly limit = 32,
  ) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 30_000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 32
    )
      throw new Error('CLIENT_BUNDLE_LIMIT_INVALID');
  }
  load = (reference: string): Promise<void> => {
    if (this.closed) return Promise.reject(new Error('CLIENT_BUNDLE_TRANSPORT_CLOSED'));
    if (this.pending.size >= this.limit) return Promise.reject(new Error('CLIENT_BUNDLE_CAPACITY'));
    let url: URL;
    try {
      const base = new URL(this.document.baseURI);
      url = new URL(reference, base);
      if (
        reference.length > 4096 ||
        !['http:', 'https:', 'axterm-app:'].includes(base.protocol) ||
        url.protocol !== base.protocol ||
        url.host !== base.host ||
        url.username ||
        url.password ||
        url.hash ||
        url.searchParams.has('token')
      )
        throw new Error();
    } catch {
      return Promise.reject(new Error('CLIENT_BUNDLE_AUTHORITY_REFUSED'));
    }
    return new Promise<void>((resolve, reject) => {
      const script = this.document.createElement('script');
      script.src = url.href;
      const finish = (failure?: string) => {
        clearTimeout(timer);
        this.pending.delete(cancel);
        script.onload = null;
        script.onerror = null;
        script.remove();
        if (failure) reject(new Error(failure));
        else resolve();
      };
      const cancel = () => finish('CLIENT_BUNDLE_TRANSPORT_CLOSED');
      const timer = setTimeout(() => finish('CLIENT_BUNDLE_TIMEOUT'), this.timeoutMs);
      script.onload = () => finish();
      script.onerror = () => finish('CLIENT_BUNDLE_UNAVAILABLE');
      this.pending.add(cancel);
      this.document.head.append(script);
    });
  };
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cancel of [...this.pending]) cancel();
  }
}
