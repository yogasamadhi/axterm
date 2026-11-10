import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export function inspectSourceBoundary(root, filename, source) {
  const errors = [];
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  function inspect(value) {
    if (/^@axterm\/(?:platform-|admin$|portal$)/u.test(value))
      errors.push('Private platform import');
    if (value.startsWith('.') || isAbsolute(value)) {
      const path = relative(root, resolve(dirname(filename), value));
      if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))
        errors.push('Import escapes Desktop source root');
    }
  }
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      inspect(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      inspect(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return errors;
}

export async function checkSourceBoundaries(root) {
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', 'lib', 'dist', 'tests', 'framework'].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (/\.[cm]?[jt]sx?$/u.test(path) && !/\.(?:test|spec)\.[jt]sx?$/u.test(path)) {
        const errors = inspectSourceBoundary(root, path, await readFile(path, 'utf8'));
        if (errors.length) throw new Error(`${path}: ${errors.join(', ')}`);
      }
    }
  }
  // Negative architecture fixtures intentionally contain only the category under test.
  // The owning architecture gate separately rejects an entirely empty source tree.
  for (const path of ['apps', 'packages', 'scripts']) {
    const directory = resolve(root, path);
    if (existsSync(directory)) await scan(directory);
  }
}
