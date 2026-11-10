import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const legacyRoots = [
  'packages/runtime',
  'packages/client',
  'packages/contracts',
  'packages/db-schema',
  'packages/shared',
  'apps/desktop/src/main',
  'apps/desktop/src/preload',
  'apps/desktop/src/renderer',
];
const legacy = (path) => legacyRoots.some((root) => path === root || path.startsWith(root + '/'));
/** Inventory is deliberately broader than direct-import counts; findings require ownership review. */
export function inventoryLegacyReferences(root, files) {
  root = resolve(root);
  files = [...new Set(files)].filter((file) => existsSync(resolve(root, file))).sort();
  const available = new Set(files);
  const config = available.has('tsconfig.json')
    ? JSON.parse(readFileSync(resolve(root, 'tsconfig.json'), 'utf8'))
    : {};
  const aliases = Object.entries(config.compilerOptions?.paths ?? {}).sort(
    ([a], [b]) => b.length - a.length,
  );
  const oldAliases = Object.fromEntries(
    ['runtime', 'client', 'contracts', 'db-schema', 'shared'].map((name) => [
      '@workspace/' + name,
      'packages/' + name + '/src/index.ts',
    ]),
  );
  const parsed = new Map();
  function target(from, specifier) {
    if (oldAliases[specifier]) return oldAliases[specifier];
    let bases = [];
    if (specifier.startsWith('.'))
      bases = [relative(root, resolve(root, dirname(from), specifier)).replaceAll('\\', '/')];
    else
      for (const [alias, values] of aliases) {
        const star = alias.indexOf('*');
        if (star < 0 && alias === specifier) {
          bases = values;
          break;
        }
        if (
          star >= 0 &&
          specifier.startsWith(alias.slice(0, star)) &&
          specifier.endsWith(alias.slice(star + 1))
        ) {
          const part = specifier.slice(star, specifier.length - (alias.length - star - 1));
          bases = values.map((value) => value.replace('*', part));
          break;
        }
      }
    for (let base of bases) {
      base = base.replace(/^\.\//, '');
      if (legacy(base)) return base;
      for (const candidate of [
        base,
        base.replace(/\.js$/, '.ts'),
        base + '.ts',
        base + '.tsx',
        base + '.mjs',
        base + '/index.ts',
        base + '/index.tsx',
      ])
        if (available.has(candidate)) return candidate;
    }
  }
  function parse(file) {
    if (parsed.has(file)) return parsed.get(file);
    const source = readFileSync(resolve(root, file), 'utf8');
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      /\.tsx$/.test(file) ? ts.ScriptKind.TSX : undefined,
    );
    const imports = [];
    function collect(specifier) {
      const next = target(file, specifier);
      if (next) imports.push({ specifier, target: next });
    }
    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      )
        collect(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          /^(?:require|\w*Require)$/.test(node.expression.getText(ast)))
      )
        collect(node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    parsed.set(file, imports);
    return imports;
  }
  const testEntries = files.filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file));
  const tests = [];
  for (const entry of testEntries) {
    const queue = [{ file: entry, chain: [entry] }],
      seen = new Set();
    const findings = [];
    if (legacy(entry)) findings.push({ specifier: '<legacy-test-entry>', chain: [entry] });
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i];
      if (seen.has(current.file)) continue;
      seen.add(current.file);
      for (const edge of parse(current.file)) {
        const chain = [...current.chain, edge.target];
        if (legacy(edge.target)) findings.push({ specifier: edge.specifier, chain });
        else if (/\.[cm]?[jt]sx?$/.test(edge.target)) queue.push({ file: edge.target, chain });
      }
    }
    if (findings.length) tests.push({ entry, findings });
  }
  const references = [];
  for (const file of files.filter(
    (file) => !legacy(file) && /\.(?:[cm]?[jt]sx?|json|ya?ml|py|sh)$/.test(file),
  )) {
    const lines = readFileSync(resolve(root, file), 'utf8').split('\n');
    const matches = lines.flatMap((line, index) =>
      legacyRoots.some((path) => line.includes(path)) ||
      /@workspace\/(?:runtime|client|contracts|db-schema|shared)\b/.test(line)
        ? [{ line: index + 1, text: line.trim().slice(0, 300) }]
        : [],
    );
    if (matches.length) references.push({ file, matches });
  }
  return {
    testEntries: testEntries.length,
    tests,
    references,
    note: 'Static path literals include negative gates and provenance; classify each before removal. Direct imports alone do not prove production/build retirement.',
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, '..');
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\0')
    .filter((file) => file && !/^(?:vendor|docs|compliance|licenses|patches|out)\//.test(file));
  console.log(JSON.stringify(inventoryLegacyReferences(root, files), null, 2));
}
