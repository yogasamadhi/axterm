/** Keep executable/public SDK artifacts and legal inputs; omit deployment-only waste. */
export function deploymentFileAllowed(manifest, name, workspace) {
  const parts = name.replaceAll('\\', '/').split('/');
  if (parts.includes('node_modules') || parts.includes('.git')) return false;
  if (manifest.name === 'spice-client' && parts.join('/') === 'dist/esm/index.js.map') return true;
  if (name.endsWith('.map')) return false;
  if (manifest.name === '@axterm/engine-pi-core' && name === 'dist/metafile.json') return false;
  if (
    !workspace &&
    parts.some((part) =>
      [
        'test',
        'tests',
        '__tests__',
        'examples',
        'docs',
        'doc',
        'benchmarks',
        'benchmark',
        'coverage',
      ].includes(part),
    )
  )
    return false;
  return true;
}
