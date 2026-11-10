import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkOperationMap, frozenOperations } from './level3-operation-map.mjs';
const sourceCommit = 'f252e62c7841ba906f9d4cb73152cd55a3bea9b3';
const sourceHash = '304c1e3771007e754efa9685953f39ae69186963aa428e3978781686b4676098';
import { inspectBindings } from './level3-operation-bindings.mjs';
export { serviceMethods, clientServiceMethods } from './level3-operation-bindings.mjs';
const safePath = (path) =>
  typeof path === 'string' &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  !path.split('/').some((p) => !p || p === '.' || p === '..');
export function inspectSourceReview(review, frozen, assets) {
  const errors = [],
    seen = new Set(),
    expected = new Map(frozen.map((row) => [row.operationId, row]));
  const fail = (id, why) => errors.push(`${id}: ${why}`);
  if (
    review?.schemaVersion !== 1 ||
    review.sourceCommit !== sourceCommit ||
    review.sourceClientSha256 !== sourceHash
  )
    fail('review', 'frozen identity changed');
  if (!Array.isArray(review?.operations)) return [...errors, 'review: operations missing'];
  for (const row of review.operations) {
    const id = row.operationId,
      original = expected.get(id);
    if (!original || seen.has(id)) fail(id, 'unknown or duplicate operation');
    seen.add(id);
    if (row.original?.method !== original?.method || row.original?.path !== original?.path)
      fail(id, 'frozen boundary changed');
    if (row.state !== 'bound' || !row.semantics?.trim() || !row.finalAcceptance?.trim())
      fail(id, 'unresolved source review or missing scope');
    if (!Array.isArray(row.replacements) || !row.replacements.length)
      fail(id, 'replacement missing');
    const { errors: bindingErrors, targets } = inspectBindings(id, row.replacements, assets);
    for (const error of bindingErrors) fail(id, error);
    if (!targets.has(row.target)) fail(id, 'primary target is not bound');
  }
  for (const id of expected.keys()) if (!seen.has(id)) fail(id, 'frozen operation missing');
  return errors;
}
export async function checkSourceReview(
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
) {
  await checkOperationMap(root); // Keep the existing final package/evidence gate intact.
  const read = (path) => readFile(resolve(root, path), 'utf8');
  const review = JSON.parse(
    await read('tests/fixtures/engineering/level3/operation-source-review.json'),
  );
  const frozen = frozenOperations(
    await read('tests/fixtures/engineering/level3/frozen/level1-api.d.ts'),
  );
  const assets = { packages: new Map(), sources: new Map() };
  for (const row of review.operations ?? [])
    for (const binding of row.replacements ?? []) {
      if (!safePath(binding.source)) continue;
      const directory = /^(packages\/(?:plugins|infra)\/[^/]+)\/src\//u.exec(binding.source)?.[1];
      if (!directory) continue;
      try {
        assets.packages.set(JSON.parse(await read(directory + '/package.json')).name, directory);
        assets.sources.set(binding.source, await read(binding.source));
      } catch {
        /* Report missing ownership or source below. */
      }
    }
  const errors = inspectSourceReview(review, frozen, assets);
  if (errors.length) throw Error(errors.join('\n'));
  return { total: frozen.length, bound: review.operations.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkSourceReview();
  console.info(
    `Source binding review passed: ${result.bound}/${result.total}; final engineering/package verification remains separate.`,
  );
}
