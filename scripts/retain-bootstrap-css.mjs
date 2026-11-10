import { resolve } from 'node:path';

/** Static document entries own these globals before any Client plugin is loaded. */
export function retainBootstrapCss(root) {
  const normalize = (value) => value.replaceAll('\\', '/');
  const entries = new Set(
    [
      'apps/web/src/auth.module.css',
      'apps/web/src/base.module.css',
      'packages/infra/ui-theme/lib/bootstrap.module.css',
    ].map((path) => normalize(resolve(root, path))),
  );
  return {
    name: 'axterm-static-bootstrap-css',
    enforce: 'post',
    apply: 'build',
    transform(code, id) {
      if (!entries.has(normalize(id.split('?')[0]))) return null;
      return { code, map: null, moduleSideEffects: 'no-treeshake' };
    },
  };
}
