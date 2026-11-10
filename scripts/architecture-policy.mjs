import ts from 'typescript';
import { posix } from 'node:path';

const systemCredentialModulePattern =
  /^(?:@electron\/safe-storage|@napi-rs\/keyring|keytar|keychain|keyring|node-keychain|keychain-service|credential-manager|wincred|libsecret|secret-service)(?:\/|$)/i;

const systemCredentialCommandPattern =
  /(?:\b(?:find|add|delete)-(?:generic|internet)-password\b|\b(?:dump|list|unlock|create|set)-keychain\b|\b(?:find-identity|find-certificate)\b|\bsecret-tool\b|\bkwallet(?:-query)?\b|\bgnome-keyring\b|\borg\.freedesktop\.secrets\b|\bcmdkey(?:\.exe)?\b|\b(?:Get|New|Remove)-StoredCredential\b|Windows\.Security\.Credentials\.PasswordVault|\bCred(?:Read|Write|Delete)[AW]?\b)/i;

// ADR-004 fixes credential persistence to the application-local vault. Renderer
// copy must not turn that product decision back into a choice or prompt.
const systemCredentialPromptPattern =
  /(?:\bkeychain\b|\bkeyring\b|\bcredential manager\b|\bsecret service\b|\bsafeStorage\b|钥匙串|系统凭据存储)/i;
const systemCredentialPromptError =
  'Renderer must not prompt for or offer a system credential store; local vault storage is fixed';

export function isSystemCredentialModule(specifier) {
  return systemCredentialModulePattern.test(specifier);
}

// Locale catalogs and HTML are not TypeScript ASTs, so the architecture gate
// scans their user-facing copy separately.
export function inspectRendererCopy(path, source) {
  return systemCredentialPromptPattern.test(source)
    ? [`${path}: ${systemCredentialPromptError}`]
    : [];
}

// Used for executable repository scripts and CI configuration, where the full
// TypeScript architecture analysis does not apply.
export function inspectCredentialScript(path, source) {
  const errors = [];
  if (
    /(?:from\s*|require\(\s*|import\(\s*)['"](?:@electron\/safe-storage|@napi-rs\/keyring|keytar|keychain|keyring|node-keychain|keychain-service|credential-manager|wincred|libsecret|secret-service)(?:\/[^'"]*)?['"]/i.test(
      source,
    ) ||
    /\bsafeStorage\b/.test(source)
  )
    errors.push('System credential-store APIs are forbidden; use the application-local vault');
  if (systemCredentialCommandPattern.test(source))
    errors.push('System credential-store commands are forbidden in repository automation');
  return [...new Set(errors)].map((error) => `${path}: ${error}`);
}

function selectedComputedLoad(path, node) {
  const argument = node.arguments[0];
  if (!argument) return false;
  const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  if (path === 'packages/infra/lazy-require/src/index.ts')
    return !dynamicImport && ts.isIdentifier(argument) && argument.text === 'specifier';
  if (
    [
      'packages/infra/hmr/src/package-manifest.ts',
      'packages/infra/app-boot/src/profile-resolution/resolver.ts',
    ].includes(path)
  )
    return !dynamicImport && ts.isIdentifier(argument) && argument.text === 'id';
  if (path === 'packages/infra/typert-loader/src/index.ts')
    return (
      dynamicImport &&
      ts.isPropertyAccessExpression(argument) &&
      ts.isIdentifier(argument.expression) &&
      argument.expression.text === 'url' &&
      argument.name.text === 'href'
    );
  if (
    path !== 'packages/plugins/remote-desktop/src/client/index.ts' ||
    !dynamicImport ||
    !ts.isPropertyAccessExpression(argument) ||
    argument.name.text !== 'href'
  )
    return false;
  const url = argument.expression;
  return (
    ts.isNewExpression(url) &&
    ts.isIdentifier(url.expression) &&
    url.expression.text === 'URL' &&
    url.arguments?.length === 2 &&
    ts.isIdentifier(url.arguments[0]) &&
    url.arguments[0].text === 'path' &&
    ts.isPropertyAccessExpression(url.arguments[1]) &&
    ts.isIdentifier(url.arguments[1].expression) &&
    url.arguments[1].expression.text === 'document' &&
    url.arguments[1].name.text === 'baseURI'
  );
}
function selectedClientTransport(path, node) {
  const route = node.arguments[0];
  if (!route) return false;
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    [
      'packages/infra/connection/src/client/rpc.ts',
      'packages/infra/client-hmr/src/client/index.ts',
      'packages/plugins/files/src/client/imports.ts',
      'packages/plugins/configuration/src/client/portable.ts',
    ].includes(path)
  )
    return true;
  if (path === 'packages/infra/client-hmr/src/client/index.ts')
    return ts.isIdentifier(route) && route.text === 'EVENTS_ROUTE';
  return (
    path === 'apps/web/src/auth.ts' &&
    ts.isStringLiteralLike(route) &&
    route.text === './connect' &&
    node.arguments[1] &&
    ts.isObjectLiteralExpression(node.arguments[1]) &&
    node.arguments[1].properties.some(
      (field) =>
        ts.isPropertyAssignment(field) &&
        (ts.isIdentifier(field.name) || ts.isStringLiteralLike(field.name)) &&
        field.name.text === 'method' &&
        ts.isStringLiteralLike(field.initializer) &&
        field.initializer.text === 'POST',
    )
  );
}
export function inspectSource(path, source) {
  const errors = [];
  const tree = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const renderer =
    path.includes('/renderer/') ||
    path.includes('/src/client/') ||
    path.startsWith('apps/web/src/');
  const preload = path.includes('/preload/') || path.endsWith('/shell/preload.ts');
  const ipcAliases = new Set(['ipcMain', 'ipcRenderer']);
  const nativeDropInstances = new Set();
  const nativeMetadataAliases = new Set();
  const nativeCollectors = new Set();
  // Collect imported aliases before walking uses, including imports placed after a use.
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    if (statement.moduleSpecifier.text === 'electron') {
      for (const element of bindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === 'webUtils')
          nativeMetadataAliases.add(element.name.text);
      }
    }
  }

  function inspectImport(specifier, isStatic) {
    if (isSystemCredentialModule(specifier)) {
      errors.push('System credential stores are forbidden; use the application-local vault');
    }
    const target = posix.normalize(posix.join(posix.dirname(path), specifier.split('?')[0]));
    const isRuntimeEntry = /packages\/runtime\/src\/entry\/desktop(?:\.ts)?$/.test(target);
    const allowedBuildImport =
      isStatic &&
      path === 'apps/desktop/src/main/index.ts' &&
      specifier === '../../../../packages/runtime/src/entry/desktop.ts?modulePath';
    if (
      (specifier.includes('?modulePath') || (path.includes('/main/') && isRuntimeEntry)) &&
      !allowedBuildImport
    ) {
      errors.push(
        'Only the explicit utility-process entry may cross the Main/Runtime build boundary',
      );
    }
  }
  function visit(node) {
    if (
      renderer &&
      (ts.isStringLiteralLike(node) || ts.isJsxText(node)) &&
      systemCredentialPromptPattern.test(node.text)
    )
      errors.push(systemCredentialPromptError);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      inspectImport(specifier, true);
      const bindings = node.importClause?.namedBindings;
      if (
        ((path === 'apps/desktop/src/preload/index.ts' && specifier === './dropped-directories') ||
          (path === 'apps/desktop/src/shell/preload.ts' && specifier === './directory-drop.ts')) &&
        bindings &&
        ts.isNamedImports(bindings)
      ) {
        for (const element of bindings.elements) {
          if ((element.propertyName?.text ?? element.name.text) === 'DroppedDirectories')
            nativeCollectors.add(element.name.text);
        }
      }
      if (
        specifier === 'electron' &&
        (!bindings || !ts.isNamedImports(bindings) || node.importClause?.name)
      ) {
        errors.push('Electron must use explicit named imports for IPC analysis');
      }
      if (specifier === 'electron' && bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (importedName === 'safeStorage')
            errors.push(
              'Electron safeStorage is forbidden; use the application-local credential vault',
            );
          if (['ipcMain', 'ipcRenderer'].includes(importedName)) ipcAliases.add(element.name.text);
          if (
            preload &&
            importedName === 'webUtils' &&
            ['apps/desktop/src/preload/index.ts', 'apps/desktop/src/shell/preload.ts'].includes(
              path,
            )
          ) {
            nativeMetadataAliases.add(element.name.text);
          } else if (preload && !['contextBridge', 'ipcRenderer'].includes(importedName)) {
            errors.push(
              'Preload only permits bootstrap imports and the ADR-026 native drop metadata collector',
            );
          }
        }
      }
      if (
        specifier.includes('?modulePath') &&
        !(
          path === 'apps/desktop/src/main/index.ts' &&
          specifier === '../../../../packages/runtime/src/entry/desktop.ts?modulePath'
        )
      )
        errors.push(
          'Only the explicit utility-process entry may cross the Main/Runtime build boundary',
        );
    }
    if (
      path === 'apps/desktop/src/shell/preload.ts' &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const value = node.initializer;
      if (
        ts.isNewExpression(value) &&
        ts.isIdentifier(value.expression) &&
        nativeCollectors.has(value.expression.text) &&
        value.arguments?.length === 1
      ) {
        const adapter = value.arguments[0];
        if (
          ts.isArrowFunction(adapter) &&
          adapter.parameters.length === 1 &&
          ts.isCallExpression(adapter.body) &&
          ts.isPropertyAccessExpression(adapter.body.expression) &&
          ts.isIdentifier(adapter.body.expression.expression) &&
          nativeMetadataAliases.has(adapter.body.expression.expression.text) &&
          adapter.body.expression.name.text === 'getPathForFile'
        )
          nativeDropInstances.add(node.name.text);
      }
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (
        (expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(expression) && expression.text === 'require')) &&
        ts.isStringLiteral(node.arguments[0] ?? tree)
      )
        inspectImport(node.arguments[0].text, false);
      if (
        ts.isIdentifier(expression) &&
        expression.text === 'require' &&
        ts.isStringLiteral(node.arguments[0] ?? tree) &&
        node.arguments[0].text === 'electron'
      ) {
        errors.push('Electron must use explicit named imports for IPC analysis');
      }
      if (
        (expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(expression) && expression.text === 'require')) &&
        !ts.isStringLiteral(node.arguments[0] ?? tree) &&
        !selectedComputedLoad(path, node)
      )
        errors.push('Computed imports cannot bypass architecture analysis');
      if (
        renderer &&
        ((ts.isIdentifier(expression) && ['fetch', 'require', 'eval'].includes(expression.text)) ||
          (ts.isPropertyAccessExpression(expression) &&
            ts.isIdentifier(expression.expression) &&
            ['globalThis', 'window'].includes(expression.expression.text) &&
            ['fetch', 'require', 'eval'].includes(expression.name.text))) &&
        !(
          ((ts.isIdentifier(expression) && expression.text === 'fetch') ||
            (ts.isPropertyAccessExpression(expression) && expression.name.text === 'fetch')) &&
          selectedClientTransport(path, node)
        )
      )
        errors.push(
          path.includes('/renderer/')
            ? 'Renderer transport must use @workspace/client'
            : 'Client transport must use its owned Connection or generated Remote',
        );
      if (
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        ipcAliases.has(expression.expression.text)
      ) {
        const channel = node.arguments[0];
        // ADR-135: one shell-owned physical keyboard protocol, never a business RPC channel.
        const keyboardIpc =
          channel &&
          ts.isStringLiteral(channel) &&
          ((channel.text === 'desktop:keyboard' &&
            ((path === 'apps/desktop/src/shell/keyboard.ts' &&
              ['handle', 'removeHandler'].includes(expression.name.text)) ||
              (path === 'apps/desktop/src/shell/preload.ts' &&
                expression.name.text === 'invoke' &&
                ts.isCallExpression(node.arguments[1] ?? tree) &&
                ts.isIdentifier(node.arguments[1].expression) &&
                node.arguments[1].expression.text === 'parseKeyboardRequest' &&
                node.arguments[1].arguments.length === 1))) ||
            (channel.text === 'desktop:keyboard-input' &&
              path === 'apps/desktop/src/shell/preload.ts' &&
              ['on', 'removeListener'].includes(expression.name.text)));
        if (
          !keyboardIpc &&
          (!channel ||
            !ts.isStringLiteral(channel) ||
            !(
              channel.text === 'desktop:bootstrap' ||
              (channel.text === 'desktop:directory-drop' &&
                ((path === 'apps/desktop/src/shell/preload.ts' &&
                  expression.name.text === 'invoke' &&
                  ts.isCallExpression(node.arguments[1] ?? tree) &&
                  ts.isPropertyAccessExpression(node.arguments[1].expression) &&
                  ts.isIdentifier(node.arguments[1].expression.expression) &&
                  nativeDropInstances.has(node.arguments[1].expression.expression.text) &&
                  node.arguments[1].expression.name.text === 'takePaths' &&
                  node.arguments[1].arguments.length === 0) ||
                  (path === 'apps/desktop/src/shell/application.ts' &&
                    ['handle', 'removeHandler'].includes(expression.name.text))))
            ) ||
            !['handle', 'invoke', 'removeHandler'].includes(expression.name.text))
        )
          errors.push(
            'Electron IPC is limited to literal desktop bootstrap and owned shell capabilities',
          );
      }
    }
    // ADR-026 permits exactly one local metadata call inside the trusted drop collector.
    // The module object, property references and arbitrary direct calls remain forbidden.
    if (
      ts.isIdentifier(node) &&
      nativeMetadataAliases.has(node.text) &&
      !ts.isImportSpecifier(node.parent)
    ) {
      const member = node.parent;
      const call = member.parent;
      const factory = call.parent;
      const collector = factory.parent;
      const allowed =
        ts.isPropertyAccessExpression(member) &&
        member.expression === node &&
        member.name.text === 'getPathForFile' &&
        ts.isCallExpression(call) &&
        call.expression === member &&
        call.arguments.length === 1 &&
        ts.isArrowFunction(factory) &&
        factory.body === call &&
        factory.parameters.length === 1 &&
        ts.isIdentifier(factory.parameters[0].name) &&
        ts.isIdentifier(call.arguments[0]) &&
        factory.parameters[0].name.text === call.arguments[0].text &&
        ts.isNewExpression(collector) &&
        ts.isIdentifier(collector.expression) &&
        nativeCollectors.has(collector.expression.text) &&
        collector.arguments?.length === 1 &&
        collector.arguments[0] === factory;
      if (!allowed)
        errors.push(
          'Native file metadata is restricted to the ADR-026 trusted directory drop collector',
        );
    }
    if (ts.isIdentifier(node) && node.text === 'safeStorage')
      errors.push('Electron safeStorage is forbidden; use the application-local credential vault');
    if (ts.isStringLiteral(node) && systemCredentialCommandPattern.test(node.text))
      errors.push('System credential-store commands are forbidden in product code');
    // Referencing an IPC object outside a direct allowed call is an escape hatch.
    if (
      ts.isIdentifier(node) &&
      ipcAliases.has(node.text) &&
      !ts.isImportSpecifier(node.parent) &&
      !(
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.expression === node &&
        ts.isCallExpression(node.parent.parent) &&
        node.parent.parent.expression === node.parent
      )
    ) {
      errors.push('IPC objects cannot be aliased, exported or accessed indirectly');
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (
    /(?:exec|spawn)(?:File|Sync)?\s*\([^\n]{0,160}['"]security['"][^\n]{0,240}(?:find|add|delete)-(?:generic|internet)-password/.test(
      source,
    ) ||
    systemCredentialCommandPattern.test(source)
  )
    errors.push('System credential-store commands are forbidden in product code');
  return [...new Set(errors)].map((error) => `${path}: ${error}`);
}
