/**
 * Node module resolution hook for workspace TypeScript sources.
 *
 * The workspace sources use extension-less relative imports (for example
 * `./quick-connect`). Node's ESM resolver requires explicit extensions, so
 * this hook maps those specifiers onto the TypeScript sources that the
 * bundler-based build already resolves. Runtime behaviour stays identical to
 * the previous Bun execution: every module is still loaded from source.
 */
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CANDIDATE_SUFFIXES = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const base = new URL(specifier, context.parentURL);
    const hasExtension = CANDIDATE_SUFFIXES.some((suffix) => base.pathname.endsWith(suffix));
    if (!hasExtension) {
      const candidates = [
        ...CANDIDATE_SUFFIXES.map((suffix) => new URL(`${base.href}${suffix}`)),
        ...CANDIDATE_SUFFIXES.map((suffix) => new URL(`${base.href}/index${suffix}`)),
      ];
      for (const candidate of candidates) {
        if (isFile(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
