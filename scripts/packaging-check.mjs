import { access, readFile } from 'node:fs/promises';
import { globSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { assertClientArtifact } from './client-artifact.mjs';
import { hasPackagedWorkspaceReference } from './packaging-workspace-reference.mjs';
import { verifyNoVncRendererBundle } from './commercialization/generate-novnc-source-notices.mjs';
import { verifySpiceRendererBundle } from './commercialization/generate-spice-source-notices.mjs';

export function inspectBuiltDesktopModule(path, source, root) {
  const errors = [];
  if (
    hasPackagedWorkspaceReference(source, root) ||
    /@workspace\/|packages\/runtime\/src|vendor\/legacy-prototype/u.test(source)
  )
    errors.push('Built desktop module contains a source/workspace dependency');
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      specifier = node.moduleSpecifier;
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      specifier = node.arguments[0];
    if (
      specifier &&
      ts.isStringLiteralLike(specifier) &&
      (isAbsolute(specifier.text) ||
        /^file:/u.test(specifier.text) ||
        /\.tsx?$/u.test(specifier.text))
    )
      errors.push('Built desktop imports must resolve through copied JavaScript outputs');
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return errors;
}
function embeddedWasmHash(source) {
  const match = /data:application\/wasm;base64,([A-Za-z0-9+/=]+)/u.exec(source);
  if (!match) throw Error('Official IronRDP embedded WASM is missing');
  return createHash('sha256').update(Buffer.from(match[1], 'base64')).digest('hex');
}
export async function checkBuiltDesktop(root = resolve(import.meta.dirname, '..')) {
  const manifest = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'));
  if (
    manifest.name !== '@axterm/desktop' ||
    manifest.main !== 'lib/shell/main.js' ||
    typeof manifest.axterm?.migrationValidation !== 'boolean'
  )
    throw Error('Desktop build has an invalid owned Shell entry');
  for (const name of [
    'apps/desktop/lib/shell/main.js',
    'apps/desktop/lib/shell/preload.cjs',
    'apps/desktop-host/lib/index.js',
    'apps/cli/lib/index.js',
    'apps/web/dist/index.html',
  ])
    await access(join(root, name));
  let clients = 0,
    modules = 0;
  for (const path of globSync(['packages/*/*/package.json', 'apps/*/package.json'], {
    cwd: root,
  })) {
    const directory = resolve(root, path, '..');
    const pkg = JSON.parse(await readFile(join(root, path), 'utf8'));
    if (pkg.axterm?.client?.platform !== 'web') continue;
    await assertClientArtifact(directory, pkg);
    clients++;
  }
  if (!clients) throw Error('Built desktop has no actual browser Clients');
  for (const path of globSync(
    [
      'apps/{desktop,desktop-host,cli}/lib/**/*.{js,cjs}',
      'apps/web/dist/assets/*.js',
      'packages/{api,infra,plugins,engines,data,bundles}/*/lib/**/*.{js,cjs}',
    ],
    { cwd: root },
  )) {
    const errors = inspectBuiltDesktopModule(path, await readFile(join(root, path), 'utf8'), root);
    if (errors.length) throw Error(path + ': ' + errors.join('; '));
    modules++;
  }
  const protocol = join(root, 'packages/plugins/remote-desktop');
  const official = await readFile(
    join(protocol, 'node_modules/@devolutions/iron-remote-desktop-rdp/iron-remote-desktop-rdp.js'),
    'utf8',
  );
  const factory = await readFile(join(protocol, 'lib/client.browser.js'), 'utf8');
  if (embeddedWasmHash(official) !== embeddedWasmHash(factory))
    throw Error('Built IronRDP WASM differs from the official installed package');
  await verifyNoVncRendererBundle();
  await verifySpiceRendererBundle();
  return {
    clients,
    modules,
    host: 'RunAsNode Profile runner',
    protocolOwners: ['IronRDP', 'noVNC', 'SPICE'],
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log('Owned desktop build layout:', await checkBuiltDesktop());
