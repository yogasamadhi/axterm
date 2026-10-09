import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function nameOf(property: ts.PropertyName): string {
  if (ts.isIdentifier(property) || ts.isStringLiteral(property)) return property.text;
  throw new Error('The UI copy catalog must use literal keys');
}

describe('transition product copy', () => {
  it('limits old-product names to active migration and workflow compatibility copy', () => {
    const path = resolve('apps/desktop/src/renderer/src/i18n/core.ts');
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const declaration = source.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === 'axtermMessages',
      );
    if (!declaration?.initializer || !ts.isAsExpression(declaration.initializer))
      throw new Error('Axterm UI copy catalog not found');
    const catalog = declaration.initializer.expression;
    if (!ts.isObjectLiteralExpression(catalog)) throw new Error('Invalid Axterm UI copy catalog');

    const violations: string[] = [];
    for (const locale of catalog.properties) {
      if (!ts.isPropertyAssignment(locale) || !ts.isObjectLiteralExpression(locale.initializer))
        throw new Error('Axterm UI copy locale must be a literal object');
      for (const entry of locale.initializer.properties) {
        if (!ts.isPropertyAssignment(entry)) throw new Error('UI copy entry must be literal');
        const key = nameOf(entry.name);
        if (!/\bLegacy Prototype\b/u.test(entry.initializer.getText(source))) continue;
        violations.push(`${nameOf(locale.name)}: ${key}`);
      }
    }
    expect(violations).toEqual([]);

    const navigationSource = readFileSync(
      resolve('scripts/localization/axterm-navigation-source.json'),
      'utf8',
    );
    expect(navigationSource).not.toMatch(/\bLegacy Prototype\b/u);

    const themeWorkspace = readFileSync(
      resolve('apps/desktop/src/renderer/src/app/terminal-themes/terminal-theme-workspace.tsx'),
      'utf8',
    );
    expect(themeWorkspace).not.toContain('theme.legacy-prototype.org');

    const ordinaryRendererSources = [
      'apps/desktop/src/renderer/src/app/app.tsx',
      'apps/desktop/src/renderer/src/app/bookmarks/ssh-bookmark-form.css',
      'apps/desktop/src/renderer/src/app/connection-profiles/connection-profiles.css',
      'apps/desktop/src/renderer/src/app/file-selection-model.ts',
      'apps/desktop/src/renderer/src/app/ssh-config-import/ssh-config-import.css',
      'apps/desktop/src/renderer/src/components/terminal-key-input.ts',
      'apps/desktop/src/renderer/src/components/terminal-timestamp.ts',
    ];
    for (const rendererSource of ordinaryRendererSources)
      expect(readFileSync(resolve(rendererSource), 'utf8')).not.toMatch(/\bLegacy Prototype\b/u);

    const connectionService = readFileSync(
      resolve('packages/runtime/src/application/connection-service.ts'),
      'utf8',
    );
    expect(connectionService).not.toMatch(/[\p{Script=Han}]/u);
    expect(connectionService).toContain("kind: 'sshHostKey'");
    expect(connectionService).toContain("kind: 'keyboardInteractive'");
  });
});
