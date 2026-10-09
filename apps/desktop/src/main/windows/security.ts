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

const trustedClipboardPermissions = new Set(['clipboard-read', 'clipboard-sanitized-write']);

export function isTrustedClipboardPermission(
  permission: string,
  candidateDocument: string,
  trustedOrigin: string,
  requestingOrigin?: string,
): boolean {
  if (!trustedClipboardPermissions.has(permission)) return false;
  if (!isTrustedDocument(candidateDocument, trustedOrigin)) return false;
  if (requestingOrigin === undefined) return true;
  try {
    return new URL(requestingOrigin).origin === trustedOrigin;
  } catch {
    return false;
  }
}
