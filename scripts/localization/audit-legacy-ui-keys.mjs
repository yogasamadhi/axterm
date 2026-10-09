import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rendererRoot = resolve(repositoryRoot, 'apps/desktop/src/renderer/src');
const catalogPath = resolve(rendererRoot, 'i18n/axterm-navigation.generated.json');

const dynamicSources = new Map([
  [
    'app/activity-rail-settings-panel.tsx:translationKeys[item]',
    { file: 'app/activity-rail-settings-panel.tsx', variable: 'translationKeys', property: null },
  ],
  [
    'app/shell-controls.tsx:choice.labelKey',
    { file: 'app/shell-controls.tsx', variable: 'layoutChoices', property: 'labelKey' },
  ],
  [
    'app/app.tsx:definition.translationKey',
    { file: 'app/app.tsx', variable: 'activityRailDefinitions', property: 'translationKey' },
  ],
  [
    'app/panels.tsx:translationKey',
    {
      file: 'app/settings-navigation.ts',
      variable: 'SETTINGS_CATEGORIES',
      property: 'translationKey',
    },
  ],
]);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && /\.tsx?$/u.test(entry.name) ? [path] : [];
    })
    .sort();
}

function parse(path) {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

function propertyName(node) {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;
}

function variableInitializer(ast, name) {
  let result;
  function walk(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      result = node.initializer;
    }
    ts.forEachChild(node, walk);
  }
  walk(ast);
  if (!result) throw new Error(`Missing dynamic translation source ${name} in ${ast.fileName}`);
  return result;
}

function valuesFromDefinition(ast, variable, property) {
  const result = new Set();
  const initializer = variableInitializer(ast, variable);
  if (property === null) {
    if (!ts.isObjectLiteralExpression(initializer)) {
      throw new Error(`${variable} is no longer a literal object`);
    }
    for (const entry of initializer.properties) {
      if (!ts.isPropertyAssignment(entry) || !ts.isStringLiteral(entry.initializer)) {
        throw new Error(`${variable} contains a non-literal translation key`);
      }
      result.add(entry.initializer.text);
    }
  } else {
    function walk(node) {
      if (ts.isPropertyAssignment(node) && propertyName(node.name) === property) {
        if (!ts.isStringLiteral(node.initializer)) {
          throw new Error(`${variable}.${property} contains a non-literal translation key`);
        }
        result.add(node.initializer.text);
      }
      ts.forEachChild(node, walk);
    }
    walk(initializer);
  }
  if (!result.size) throw new Error(`No translation keys found in ${variable}`);
  return result;
}

export function auditLegacyUiKeys({ catalogFile = catalogPath } = {}) {
  const catalog = catalogFile ? JSON.parse(readFileSync(catalogFile, 'utf8')) : null;
  const english = catalog?.locales.find(({ id }) => id === 'en');
  if (catalog && !english) throw new Error('The Axterm catalog has no English fallback');
  const catalogKeys = english ? new Set(Object.keys(english.messages)) : null;
  const usedKeys = new Set();
  const dynamicCalls = [];
  const unrecognizedDynamicCalls = [];
  const definitionCache = new Map();
  let literalCalls = 0;

  for (const file of sourceFiles(rendererRoot)) {
    const ast = parse(file);
    const relativePath = relative(rendererRoot, file).replaceAll('\\', '/');
    function walk(node) {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === 'useI18n' &&
        ts.isObjectBindingPattern(node.name)
      ) {
        for (const binding of node.name.elements) {
          const exportedName = binding.propertyName ?? binding.name;
          if (
            ts.isIdentifier(exportedName) &&
            exportedName.text === 't' &&
            (!ts.isIdentifier(binding.name) || binding.name.text !== 't')
          ) {
            throw new Error(`Review aliased useI18n().t binding in ${relativePath}`);
          }
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 't'
      ) {
        throw new Error(`Review property-access t() call in ${relativePath}`);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 't'
      ) {
        const first = node.arguments[0];
        if (!first) throw new Error(`t() has no key at ${relativePath}`);
        if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
          usedKeys.add(first.text);
          literalCalls += 1;
        } else {
          const expression = first.getText(ast);
          const site = `${relativePath}:${expression}`;
          const definition = dynamicSources.get(site);
          const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
          if (!definition) {
            unrecognizedDynamicCalls.push(`${relativePath}:${line} ${expression}`);
          } else {
            let keys = definitionCache.get(site);
            if (!keys) {
              keys = valuesFromDefinition(
                parse(resolve(rendererRoot, definition.file)),
                definition.variable,
                definition.property,
              );
              definitionCache.set(site, keys);
            }
            for (const key of keys) usedKeys.add(key);
            dynamicCalls.push({ file: relativePath, line, expression, keys: [...keys].sort() });
          }
        }
      }
      ts.forEachChild(node, walk);
    }
    walk(ast);
  }

  const compare = (a, b) => a.localeCompare(b, 'en');
  const missingKeys = catalogKeys
    ? [...usedKeys].filter((key) => !catalogKeys.has(key)).sort(compare)
    : [];
  return {
    catalogKeyCount: catalogKeys?.size ?? null,
    literalCalls,
    dynamicCalls,
    usedKeys: [...usedKeys].sort(compare),
    unusedKeys: catalogKeys
      ? [...catalogKeys].filter((key) => !usedKeys.has(key)).sort(compare)
      : [],
    missingKeys,
    unexpectedMissingKeys: missingKeys,
    unrecognizedDynamicCalls,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = auditLegacyUiKeys();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `Axterm navigation catalog: ${report.usedKeys.length}/${report.catalogKeyCount} keys used; ` +
        `${report.unusedKeys.length} not referenced; ${report.literalCalls} literal calls, ` +
        `${report.dynamicCalls.length} mapped dynamic calls.`,
    );
  }
  if (report.unexpectedMissingKeys.length || report.unrecognizedDynamicCalls.length) {
    console.error(
      `Unexpected missing keys: ${report.unexpectedMissingKeys.join(', ') || 'none'}; ` +
        `unrecognized dynamic calls: ${report.unrecognizedDynamicCalls.join(', ') || 'none'}`,
    );
    process.exitCode = 1;
  }
}
