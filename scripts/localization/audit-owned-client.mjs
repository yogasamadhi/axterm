import { globSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export const productLocales = ['en', 'ja', 'zh-CN', 'zh-TW'];
const cjk = /[\u3400-\u9fff]/u;
const placeholders = (value) =>
  [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)].map((match) => match[1]).sort();
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const languages = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function inspectOwnedDictionary(owner, dictionary) {
  const errors = [];
  if (!languages(dictionary) || !same(Object.keys(dictionary).sort(), [...productLocales].sort()))
    return [`${owner}: exactly four product languages are required`];
  const keys = Object.keys(dictionary.en ?? {}).sort();
  if (!keys.length) errors.push(`${owner}: empty English dictionary`);
  for (const language of productLocales) {
    const messages = dictionary[language];
    if (!languages(messages) || !same(Object.keys(messages).sort(), keys)) {
      errors.push(`${owner}: ${language} key coverage differs`);
      continue;
    }
    for (const key of keys) {
      const value = messages[key];
      if (typeof value !== 'string' || !value.trim())
        errors.push(`${owner}: ${language}/${key} must be nonempty text`);
      else if (
        typeof dictionary.en[key] === 'string' &&
        !same(placeholders(value), placeholders(dictionary.en[key]))
      )
        errors.push(`${owner}: ${language}/${key} interpolation differs`);
    }
  }
  return errors;
}

const propertyName = (node) =>
  ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
const unwrap = (node) => {
  while (
    node &&
    (ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node))
  )
    node = node.expression;
  return node;
};
function text(node) {
  node = unwrap(node);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return (
      node.head.text +
      node.templateSpans
        .map((span) => `{${span.expression.getText().replaceAll(/\s/gu, '')}}${span.literal.text}`)
        .join('')
    );
}

/** Validate every inline DSH locale record and reject bare UI copy rather than grandfathering it. */
export function inspectOwnedClientText(
  path,
  source,
  knownKeys,
  { keys = true, literals = true } = {},
) {
  const errors = [],
    inlineCatalogs = [],
    translated = new Set(),
    localized = new Set();
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function record(node) {
    if (!ts.isObjectLiteralExpression(node)) return;
    const fields = node.properties.filter(ts.isPropertyAssignment);
    const localeFields = fields.filter((field) =>
      productLocales.includes(propertyName(field.name)),
    );
    if (!localeFields.length) return;
    const values = localeFields.map((field) => unwrap(field.initializer));
    const plain = values.every((value) => text(value) !== undefined);
    const nested = values.every(ts.isObjectLiteralExpression);
    if (!plain && !nested) return;
    if (
      fields.length !== 4 ||
      localeFields.length !== 4 ||
      new Set(localeFields.map((field) => propertyName(field.name))).size !== 4
    ) {
      errors.push(`${path}: incomplete inline locale record`);
      return;
    }
    const dictionary = {};
    for (const field of localeFields) {
      const value = unwrap(field.initializer);
      if (plain) dictionary[propertyName(field.name)] = { text: text(value) };
      else {
        const entries = value.properties;
        // Imported/spread catalogs are validated from their actual pure module, never evaluated as code here.
        if (
          entries.some(
            (entry) => !ts.isPropertyAssignment(entry) || text(entry.initializer) === undefined,
          )
        )
          return;
        dictionary[propertyName(field.name)] = Object.fromEntries(
          entries.map((entry) => [propertyName(entry.name), text(entry.initializer)]),
        );
      }
    }
    errors.push(...inspectOwnedDictionary(path, dictionary));
    if (nested) inlineCatalogs.push(dictionary);
    function mark(child) {
      localized.add(child);
      ts.forEachChild(child, mark);
    }
    mark(node);
  }
  function collect(node) {
    record(node);
    ts.forEachChild(node, collect);
  }
  collect(ast);
  const available = new Set([
    ...knownKeys,
    ...inlineCatalogs.flatMap((dictionary) => Object.keys(dictionary.en)),
  ]);
  function inspect(node) {
    if (
      literals &&
      (ts.isStringLiteralLike(node) || ts.isJsxText(node)) &&
      cjk.test(node.text) &&
      !localized.has(node)
    )
      errors.push(`${path}: bare CJK Client text must use an owned locale`);
    if (
      keys &&
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 't') ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 't')) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const key = node.arguments[0].text;
      translated.add(key);
      if (!available.has(key)) errors.push(`${path}: unknown owned translation key ${key}`);
    }
    ts.forEachChild(node, inspect);
  }
  inspect(ast);
  return { errors: [...new Set(errors)], inlineCatalogs, translated: [...translated].sort() };
}

export async function auditOwnedClients(
  root = resolve(import.meta.dirname, '../..'),
  mode = 'all',
) {
  const catalogs = [],
    errors = [],
    keys = new Set();
  for (const path of [
    ...globSync('packages/{plugins,infra,api}/*/src/client/**/*locales.{ts,json}', { cwd: root }),
  ].sort()) {
    const module = path.endsWith('.json')
      ? { default: JSON.parse(readFileSync(resolve(root, path), 'utf8')) }
      : await import(pathToFileURL(resolve(root, path)).href);
    const candidates = Object.values(module).filter((value) => languages(value) && value.en);
    if (candidates.length !== 1) {
      errors.push(`${path}: one owned dictionary export is required`);
      continue;
    }
    const dictionary = candidates[0];
    errors.push(...inspectOwnedDictionary(path, dictionary));
    catalogs.push(path);
    for (const key of Object.keys(dictionary.en)) keys.add(key);
  }
  if (!catalogs.length) errors.push('No actual owned Client catalogs discovered');
  let sources = 0,
    inlineCatalogs = 0;
  const translated = new Set();
  if (mode !== 'catalogs')
    for (const path of globSync(
      ['packages/plugins/*/src/client/**/*.{ts,tsx}', 'apps/web/src/**/*.{ts,tsx}'],
      { cwd: root },
    )) {
      if (/\.(?:test|spec|d)\.tsx?$/u.test(path) || /locales\.ts$/u.test(path)) continue;
      const report = inspectOwnedClientText(
        relative(root, resolve(root, path)),
        readFileSync(resolve(root, path), 'utf8'),
        keys,
        { keys: mode !== 'literals', literals: mode !== 'keys' },
      );
      sources++;
      errors.push(...report.errors);
      inlineCatalogs += report.inlineCatalogs.length;
      for (const key of report.translated) translated.add(key);
    }
  if (errors.length) throw Error(errors.join('\n'));
  return { catalogs: catalogs.length, sources, inlineCatalogs, literalKeys: translated.size };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes('--catalogs')
    ? 'catalogs'
    : process.argv.includes('--keys')
      ? 'keys'
      : process.argv.includes('--literals')
        ? 'literals'
        : 'all';
  console.log(await auditOwnedClients(undefined, mode));
}
