import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { preprocessCSS, resolveConfig } from 'vite';

/** CSS has no side effects until its owning Client plugin explicitly installs cssText. */
export function ownedClientCss(directory) {
  const sourceRoot = resolve(directory, 'src/client');
  const emittedRoot = resolve(directory, 'lib/types/client');
  let configuration;
  const sources = new Map();
  const ownId = (path, identity) => {
    const id = '\0axterm-css:' + identity + '?axterm-css.js';
    sources.set(id, path);
    return id;
  };
  const inside = (root, path) => {
    const suffix = relative(root, path);
    return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep);
  };
  return {
    name: 'axterm-owned-client-css',
    async resolveId(name, importer) {
      if (!/\.css$/u.test(name)) return null;
      if (!importer) throw new Error('Client CSS must have an owner');
      if (!name.startsWith('.')) {
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        const packageName = name.startsWith('@')
          ? name.split('/').slice(0, 2).join('/')
          : name.split('/')[0];
        if (packageName.startsWith('@axterm/') || !manifest.dependencies?.[packageName])
          throw new Error(
            'Client CSS must be an owned relative stylesheet or declared vendor asset',
          );
        const path = createRequire(join(directory, 'package.json')).resolve(name);
        return ownId(path, 'vendor/' + name);
      }
      let path = resolve(dirname(importer), name);
      if (inside(emittedRoot, path)) path = resolve(sourceRoot, relative(emittedRoot, path));
      if (!inside(sourceRoot, path)) throw new Error('Client CSS escaped its package source');
      return ownId(path, 'src/client/' + relative(sourceRoot, path).split(sep).join('/'));
    },
    async load(id) {
      if (!id.startsWith('\0axterm-css:')) return null;
      const path = sources.get(id);
      if (!path) throw new Error('Unknown owned Client stylesheet');
      const source = await readFile(path, 'utf8');
      if (Buffer.byteLength(source) > 2 * 1024 * 1024)
        throw new Error('Client stylesheet exceeds its source budget');
      // Package assets must use the separately reviewed, revisioned asset route.
      // Reject unowned network/import/file dependencies instead of silently emitting broken URLs.
      if (/@import\b|url\s*\(/iu.test(source))
        throw new Error('Client CSS asset references require an explicit package asset');
      configuration ??= resolveConfig(
        {
          configFile: false,
          root: directory,
          logLevel: 'silent',
          css: {
            modules: {
              generateScopedName(name, filename) {
                const identity = relative(sourceRoot, filename).split(sep).join('/');
                const hash = createHash('sha256')
                  .update(directory.split(sep).slice(-2).join('/') + '/' + identity + ':' + name)
                  .digest('hex')
                  .slice(0, 10);
                return 'ax_' + hash + '_' + name;
              },
            },
          },
        },
        'build',
        'production',
      );
      const result = await preprocessCSS(source, path, await configuration);
      return (
        'export const cssText=' +
        JSON.stringify(result.code) +
        ';\nexport default ' +
        JSON.stringify(result.modules ?? {}) +
        ';\n'
      );
    },
  };
}
