import { readdir, readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isBuiltin } from 'node:module';
import ts from 'typescript';

const root = resolve('apps/desktop/out');
await access(`${root}/main/index.js`);
await access(`${root}/preload/index.cjs`);
await access(`${root}/renderer/index.html`);
let utilities = 0;
let rdpWasmAssets = 0;
let vncClientAssets = 0;
let spiceClientAssets = 0;
let terminalTransferBundles = 0;
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (path.includes('/renderer/assets/rdp_client_bg-') && path.endsWith('.wasm'))
      rdpWasmAssets += 1;
    if (/\/renderer\/assets\/rfb-[^/]+\.js$/u.test(path)) vncClientAssets += 1;
    if (/\/renderer\/assets\/spice-client-[^/]+\.js$/u.test(path)) spiceClientAssets += 1;
    if (!/\.(js|cjs)$/.test(path)) continue;
    const text = await readFile(path, 'utf8');
    if (
      path.includes('/main/desktop-') &&
      text.includes('zmodem-event') &&
      text.includes('xmodem-event') &&
      text.includes('trzsz-event')
    )
      terminalTransferBundles += 1;
    if (path.includes('/main/') && text.includes('process.parentPort')) utilities += 1;
    if (
      text.includes(resolve('.')) ||
      /@workspace\/|packages\/runtime\/src|vendor\/electerm/.test(text)
    )
      throw new Error(`Packaged source/workspace dependency: ${path}`);
    const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    function visit(node) {
      let specifier;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        specifier = node.moduleSpecifier;
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require'
      )
        specifier = node.arguments[0];
      if (
        specifier &&
        ts.isStringLiteral(specifier) &&
        !specifier.text.startsWith('.') &&
        !isBuiltin(specifier.text) &&
        specifier.text !== 'electron' &&
        !(
          ['node-pty', 'serialport', 'ssh2', 'ws'].includes(specifier.text) &&
          path.includes('/main/desktop-')
        )
      )
        throw new Error(`Unbundled dependency ${specifier.text} in ${path}`);
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
}
await scan(root);
if (utilities !== 1)
  throw new Error(`Expected one separate Runtime utility bundle; found ${utilities}`);
if (rdpWasmAssets !== 1)
  throw new Error(`Expected one bundled IronRDP WASM asset; found ${rdpWasmAssets}`);
if (vncClientAssets !== 1)
  throw new Error(`Expected one bundled noVNC RFB asset; found ${vncClientAssets}`);
if (spiceClientAssets !== 1)
  throw new Error(`Expected one bundled SPICE client asset; found ${spiceClientAssets}`);
if (terminalTransferBundles !== 1)
  throw new Error(
    `Expected one bundled ZMODEM/XMODEM/trzsz Runtime implementation; found ${terminalTransferBundles}`,
  );
console.info(
  'Packaged layout check passed: separate Runtime, bundled RDP/noVNC/SPICE and terminal-transfer clients, no source or workspace dependencies.',
);
