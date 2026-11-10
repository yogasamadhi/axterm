/** Application document policy; startup code remains owned by its HTML/Native producer. */
import { createHash, randomBytes } from 'node:crypto';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
export type DocumentSurface =
  { readonly surface: 'desktop' } | { readonly surface: 'web'; readonly url: string };
const NONCE_META = 'axterm-csp-nonce';
const EXECUTABLE_TYPES = new Set([
  '',
  'module',
  'importmap',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
]);
/** Preserve the original markup while authorizing only its actual inline script nodes. */
export function protectApplicationDocument(
  html: string,
  target: DocumentSurface,
): { html: string; headers: Readonly<Record<string, string>> } {
  if (html.length > 8 * 1024 * 1024) throw Error('DOCUMENT_POLICY_LIMIT');
  const sources: string[] = [];
  if (target.surface === 'desktop') sources.push('ws:');
  else if (target.surface === 'web') {
    let url: URL;
    try {
      url = new URL(target.url);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.searchParams.has('token')
      )
        throw Error();
    } catch {
      throw Error('DOCUMENT_POLICY_ORIGIN_INVALID');
    }
  } else throw Error('DOCUMENT_POLICY_SURFACE_INVALID');
  const nonce = randomBytes(24).toString('base64'),
    hashes = new Set<string>(),
    pending: DefaultTreeAdapterTypes.Node[] = [parse(html, { sourceCodeLocationInfo: true })];
  let insertion = 0,
    visited = 0,
    scripts = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (++visited > 100000) throw Error('DOCUMENT_POLICY_LIMIT');
    if ('tagName' in node) {
      if (node.tagName === 'head' && node.namespaceURI === 'http://www.w3.org/1999/xhtml')
        insertion =
          node.sourceCodeLocation?.endTag?.startOffset ??
          node.sourceCodeLocation?.startTag?.endOffset ??
          insertion;
      if (
        node.tagName === 'meta' &&
        node.attrs.some((attr) => attr.name === 'name' && attr.value === 'axterm-csp-nonce')
      )
        throw Error('DOCUMENT_POLICY_NONCE_DUPLICATE');
      if (
        node.tagName === 'script' &&
        !node.attrs.some((attr) => attr.name === 'src') &&
        EXECUTABLE_TYPES.has(
          (node.attrs.find((attr) => attr.name === 'type')?.value ?? '').trim().toLowerCase(),
        )
      ) {
        if (++scripts > 128) throw Error('DOCUMENT_POLICY_LIMIT');
        const text = node.childNodes.map((child) => ('value' in child ? child.value : '')).join('');
        hashes.add("'sha256-" + createHash('sha256').update(text).digest('base64') + "'");
      }
    }
    if ('childNodes' in node)
      for (const child of node.childNodes) {
        if (pending.length >= 100000) throw Error('DOCUMENT_POLICY_LIMIT');
        pending.push(child);
      }
  }
  const policy =
    [
      "default-src 'self'",
      ["script-src 'self' 'wasm-unsafe-eval'", `'nonce-${nonce}'`, ...hashes].join(' '),
      "style-src 'self' 'unsafe-inline'",
      ["connect-src 'self' data:", ...sources].join(' '),
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "worker-src 'self' blob:",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'none'",
    ].join('; ') + ';';
  const meta = `<meta name="${NONCE_META}" content="${nonce}">`;
  return {
    html: html.slice(0, insertion) + meta + html.slice(insertion),
    headers: {
      'content-security-policy': policy,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  };
}
