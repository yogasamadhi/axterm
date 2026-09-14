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

export function inspectSource(path, source) {
  const errors = [];
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const renderer = path.includes('/renderer/');
  const preload = path.includes('/preload/');
  const ipcAliases = new Set(['ipcMain', 'ipcRenderer']);
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
          if (preload && !['contextBridge', 'ipcRenderer'].includes(importedName))
            errors.push('Preload may only import contextBridge and ipcRenderer');
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
        !ts.isStringLiteral(node.arguments[0] ?? tree)
      )
        errors.push('Computed imports cannot bypass architecture analysis');
      if (
        renderer &&
        ts.isIdentifier(expression) &&
        ['fetch', 'require', 'eval'].includes(expression.text)
      )
        errors.push('Renderer transport must use @workspace/client');
      if (
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        ipcAliases.has(expression.expression.text)
      ) {
        const channel = node.arguments[0];
        if (
          !channel ||
          !ts.isStringLiteral(channel) ||
          channel.text !== 'desktop:bootstrap' ||
          !['handle', 'invoke', 'removeHandler'].includes(expression.name.text)
        )
          errors.push('Electron IPC is limited to literal desktop:bootstrap discovery');
      }
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
