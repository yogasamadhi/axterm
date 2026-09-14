export function isTrustedDocument(candidate: string, trustedOrigin: string): boolean {
  try {
    const url = new URL(candidate);
    return (
      url.origin === trustedOrigin &&
      !url.username &&
      !url.password &&
      !url.search &&
      (url.pathname === '/' || url.pathname === '/index.html')
    );
  } catch {
    return false;
  }
}
