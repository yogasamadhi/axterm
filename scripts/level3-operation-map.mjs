import {
  remoteDeclarations,
  inspectBindings,
  isSelectedOperationTarget,
} from './level3-operation-bindings.mjs';
export { remoteDeclarations } from './level3-operation-bindings.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const sourceCommit = 'f252e62c7841ba906f9d4cb73152cd55a3bea9b3';
const sourceHash = '304c1e3771007e754efa9685953f39ae69186963aa428e3978781686b4676098';
/** Parse the frozen generated contract rather than trusting mutable mapping metadata. */
export function frozenOperations(source) {
  const ast = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true);
  const paths = ast.statements.find(
    (node) => ts.isInterfaceDeclaration(node) && node.name.text === 'paths',
  );
  const rows = [];
  for (const path of paths?.members ?? []) {
    if (
      !ts.isPropertySignature(path) ||
      !ts.isStringLiteral(path.name) ||
      !path.type ||
      !ts.isTypeLiteralNode(path.type)
    )
      continue;
    for (const method of path.type.members) {
      if (
        !ts.isPropertySignature(method) ||
        !method.type ||
        !ts.isIndexedAccessTypeNode(method.type) ||
        method.type.objectType.getText(ast) !== 'operations' ||
        !ts.isLiteralTypeNode(method.type.indexType) ||
        !ts.isStringLiteral(method.type.indexType.literal)
      )
        continue;
      rows.push({
        operationId: method.type.indexType.literal.text,
        method: method.name.getText(ast).toUpperCase(),
        path: path.name.text,
      });
    }
  }
  return rows;
}
const safePath = (path) =>
  typeof path === 'string' &&
  !path.includes('\\') &&
  !path.split('/').some((part) => part === '..' || part === '' || part === '.') &&
  !path.startsWith('/');
export function inspectOperationMap(map, frozen, assets) {
  const errors = [];
  const fail = (id, detail) => errors.push(`${id}: ${detail}`);
  if (
    map?.schemaVersion !== 2 ||
    map.sourceCommit !== sourceCommit ||
    map.sourceClientSha256 !== sourceHash
  )
    fail('map', 'frozen metadata changed');
  if (!Array.isArray(map?.operations)) return [...errors, 'map: operations missing'];
  const expected = new Map(frozen.map((row) => [row.operationId, row]));
  const seen = new Set();
  for (const row of map.operations) {
    const id = row.operationId;
    const original = expected.get(id);
    if (!original || seen.has(id)) fail(id, 'unknown or duplicate frozen operation');
    seen.add(id);
    if (row.method !== original?.method || row.path !== original?.path)
      fail(id, 'frozen HTTP boundary changed');
    if (
      typeof row.namespace !== 'string' ||
      typeof row.target !== 'string' ||
      (!row.target.startsWith(row.namespace + '.') && !isSelectedOperationTarget(row))
    )
      fail(id, 'owner/target mismatch');
    if (
      !['remote', 'binary-http', 'remote-stream', 'binary-ws', 'streaming-http'].includes(
        row.transport,
      ) &&
      !isSelectedOperationTarget(row)
    )
      fail(id, 'unknown transport');
    if (row.state === 'pending') {
      if (row.replacements !== undefined || !Array.isArray(row.evidence) || row.evidence.length)
        fail(id, 'pending assignment claims verification');
      continue;
    }
    if (row.state !== 'verified') {
      fail(id, 'unknown verification state');
      continue;
    }
    if (!row.semantics?.trim()) fail(id, 'replacement semantics missing');
    if (!Array.isArray(row.replacements) || !row.replacements.length)
      fail(id, 'actual replacement missing');
    const { errors: bindingErrors, targets } = inspectBindings(id, row.replacements, assets);
    for (const error of bindingErrors) fail(id, error);
    if (!targets.has(row.target)) fail(id, 'target has no actual replacement');
    if (
      !Array.isArray(row.tests) ||
      !row.tests.length ||
      row.tests.some(
        (path) =>
          !safePath(path) ||
          !/^tests\/(integration|unit)\/.+\.test\.tsx?$/.test(path) ||
          !assets.files.has(path),
      )
    )
      fail(id, 'executable verification tests missing');
    if (!Array.isArray(row.evidence) || !row.evidence.length)
      fail(id, 'engineering evidence missing');
    for (const path of row.evidence ?? []) {
      const record = assets.evidence.get(path);
      if (
        !safePath(path) ||
        !path.startsWith('docs/implementation/evidence/') ||
        !record ||
        !(record.sourceFreeMacPackage?.passedTests > 0)
      )
        fail(id, 'successful packaged engineering evidence missing');
      const checks = record?.checks;
      if (!(checks?.scoped?.passedTests > 0 || checks?.whole?.passedTests > 0))
        fail(id, 'successful scoped/whole engineering evidence missing');
    }
  }
  for (const id of expected.keys()) if (!seen.has(id)) fail(id, 'frozen operation missing');
  return errors;
}
/** The finished repository cannot regress to an incomplete migration record. */
export function inspectFinalOperationMap(map, frozen, assets) {
  const errors = inspectOperationMap(map, frozen, assets);
  for (const row of Array.isArray(map?.operations) ? map.operations : [])
    if (row.state !== 'verified')
      errors.push(`${row.operationId}: final operation acceptance is incomplete`);
  return errors;
}
export async function checkOperationMap(
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
) {
  const read = (path) =>
    readFile(
      resolve(
        root,
        path.replace('docs/implementation/evidence/', 'tests/fixtures/engineering/evidence/'),
      ),
      'utf8',
    );
  const source = await read('tests/fixtures/engineering/level3/frozen/level1-api.d.ts');
  if (createHash('sha256').update(source).digest('hex') !== sourceHash)
    throw new Error('Frozen Contract source changed');
  const frozen = frozenOperations(source);
  if (frozen.length !== 264 || new Set(frozen.map((row) => row.operationId)).size !== 264)
    throw new Error('Frozen Contract operation identity changed');
  const map = JSON.parse(await read('tests/fixtures/engineering/level3/operation-map.json'));
  const assets = {
    packages: new Map(),
    remotes: new Map(),
    sources: new Map(),
    files: new Set(),
    evidence: new Map(),
  };
  for (const row of map.operations ?? []) {
    for (const replacement of row.replacements ?? []) {
      if (!safePath(replacement.source)) continue;
      const match = /^(packages\/(?:plugins|infra)\/[^/]+)\/src\//.exec(replacement.source);
      if (!match) continue;
      try {
        const manifest = JSON.parse(await read(match[1] + '/package.json'));
        assets.packages.set(manifest.name, match[1]);
        const source = await read(replacement.source);
        assets.sources.set(replacement.source, source);
        assets.remotes.set(replacement.source, remoteDeclarations(source));
      } catch {
        /* Validation reports an unresolved owner/declaration. */
      }
    }
    for (const path of row.tests ?? [])
      if (safePath(path))
        try {
          await read(path);
          assets.files.add(path);
        } catch {
          /* Report missing evidence. */
        }
    for (const path of row.evidence ?? [])
      if (safePath(path))
        try {
          assets.evidence.set(path, JSON.parse(await read(path)));
        } catch {
          /* Report missing evidence. */
        }
  }
  const errors = inspectFinalOperationMap(map, frozen, assets);
  if (errors.length) throw new Error(errors.join('\n'));
  return {
    total: frozen.length,
    verified: map.operations.filter((row) => row.state === 'verified').length,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkOperationMap();
  console.info(
    `Operation migration gate passed: ${result.verified}/${result.total} with recorded engineering verification; whole cutover remains separate.`,
  );
}
