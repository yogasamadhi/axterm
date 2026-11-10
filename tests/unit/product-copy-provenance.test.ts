import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { auditOwnedClients } from '../../scripts/localization/audit-owned-client.mjs';
import { describe, expect, it } from 'vitest';

function nameOf(property: ts.PropertyName): string {
  if (ts.isIdentifier(property) || ts.isStringLiteral(property)) return property.text;
  throw new Error('The UI copy catalog must use literal keys');
}

describe('transition product copy', () => {
  it('limits old-product names to active migration and workflow compatibility copy', async () => {
    await auditOwnedClients();
    const path = resolve('tests/fixtures/migration/generation2-localization/core.ts.txt');
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
      resolve('packages/plugins/terminals/src/client/themes/panel.tsx'),
      'utf8',
    );
    expect(themeWorkspace).not.toContain('theme.legacy-prototype.org');

    const ordinaryRendererSources = [
      'packages/plugins/workspace/src/client/index.tsx',
      'packages/plugins/catalog/src/client/ui/editor/editor.module.css',
      'packages/plugins/catalog/src/client/ui/profiles/profiles.module.css',
      'packages/plugins/files/src/client/ui/file-selection-model.ts',
      'packages/plugins/catalog/src/client/ui/import.module.css',
      'packages/plugins/terminals/src/client/rendering/key-input.ts',
      'packages/plugins/terminals/src/client/rendering/timestamp.ts',
    ];
    for (const rendererSource of ordinaryRendererSources)
      expect(readFileSync(resolve(rendererSource), 'utf8')).not.toMatch(/\bLegacy Prototype\b/u);

    const connectionService = readFileSync(
      resolve('packages/plugins/connections/src/application/connection-service.ts'),
      'utf8',
    );
    expect(connectionService).not.toMatch(/[\p{Script=Han}]/u);
    expect(connectionService).toContain("kind: 'sshHostKey'");
    expect(connectionService).toContain("kind: 'keyboardInteractive'");
  });
});
