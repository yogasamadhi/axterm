import { readdir, readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { isBuiltin } from 'node:module';
import ts from 'typescript';
import { hasPackagedWorkspaceReference } from './packaging-workspace-reference.mjs';

const root = resolve('apps/desktop/out');
const spiceProvenance = JSON.parse(
  await readFile(`${root}/renderer/axterm-spice-client-bundle-provenance.json`, 'utf8'),
);
if (
  spiceProvenance.package !== 'spice-client@1.2.0' ||
  spiceProvenance.chunks?.length !== 1 ||
  !/^assets\/spice-client-[a-zA-Z0-9_.-]+\.js$/u.test(spiceProvenance.chunks[0]?.path)
) {
  throw new Error('Expected one provenance-identified SPICE client bundle');
}
const spiceClientAsset = `${root}/renderer/${spiceProvenance.chunks[0].path}`;
const rdpSource = await readFile(
  resolve(
    'apps/desktop/node_modules/@devolutions/iron-remote-desktop-rdp/iron-remote-desktop-rdp.js',
  ),
  'utf8',
);
function embeddedWasmHash(text) {
  const match = text.match(/data:application\/wasm;base64,([A-Za-z0-9+/=]+)/u);
  if (!match) throw new Error('Official IronRDP bundle lacks embedded WASM');
  return createHash('sha256').update(Buffer.from(match[1], 'base64')).digest('hex');
}
const officialRdpWasmHash = embeddedWasmHash(rdpSource);
await access(`${root}/main/index.js`);
await access(`${root}/preload/index.cjs`);
await access(`${root}/renderer/index.html`);
let utilities = 0;
let rdpClientBundles = 0;
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
    if (/\/renderer\/assets\/rdp_client_bg-[^/]+\.wasm$/u.test(path))
      throw new Error(`Retired Legacy Prototype RDP WASM asset remains bundled: ${path}`);
    if (/\/renderer\/assets\/rfb-[^/]+\.js$/u.test(path)) vncClientAssets += 1;
    if (path === spiceClientAsset) {
      if (
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex') !== spiceProvenance.chunks[0].sha256
      )
        throw new Error(`SPICE client bundle differs from its source provenance: ${path}`);
      spiceClientAssets += 1;
    }
    if (!/\.(js|cjs)$/.test(path)) continue;
    const text = await readFile(path, 'utf8');
    if (/\/renderer\/assets\/iron-remote-desktop-rdp-[^/]+\.js$/u.test(path)) {
      if (embeddedWasmHash(text) !== officialRdpWasmHash || !text.includes('WebAssembly'))
        throw new Error(`IronRDP WASM differs from installed official package: ${path}`);
      rdpClientBundles += 1;
    }
    if (
      path.includes('/main/desktop-') &&
      text.includes('zmodem-event') &&
      text.includes('xmodem-event') &&
      text.includes('trzsz-event')
    )
      terminalTransferBundles += 1;
    if (path.includes('/main/') && text.includes('process.parentPort')) utilities += 1;
    if (
      hasPackagedWorkspaceReference(text) ||
      /@workspace\/|packages\/runtime\/src|vendor\/legacy-prototype/.test(text)
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
          (['node-pty', 'serialport', 'ssh2', 'ws'].includes(specifier.text) ||
            specifier.text.startsWith('@openclaw/fs-safe/')) &&
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
if (rdpClientBundles !== 1)
  throw new Error(`Expected one official IronRDP client bundle; found ${rdpClientBundles}`);
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
