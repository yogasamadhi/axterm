import { resolve, sep } from 'node:path';

export function hasPackagedWorkspaceReference(text, sourceRoot = resolve('.')) {
  const trimmedRoot = sourceRoot.replace(/[\\/]+$/u, '');
  const nativePrefix = `${trimmedRoot}${sep}`;
  const slashPrefix = `${trimmedRoot.replaceAll('\\', '/')}/`;
  const backslashPrefix = `${trimmedRoot.replaceAll('/', '\\')}\\`;
  const fileUrlPrefix = `file://${slashPrefix}`;

  return [nativePrefix, slashPrefix, backslashPrefix, fileUrlPrefix].some((prefix) =>
    text.includes(prefix),
  );
}
