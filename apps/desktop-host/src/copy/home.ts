import { runProfile } from '@axterm/cli/profile-boot';
import { PROFILE_TEMPLATES } from '@axterm/cli/profile-templates';
import { createRequire } from 'node:module';
import { homeCopyReceiptSchema as receipt } from '../protocol.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as Schema from '@axterm/data-schema';
import { withFileLock } from '@axterm/infra-atomic-write';
import { EncryptedVault } from '@axterm/infra-credential-vault';
import {
  copyGeneration2Database,
  copyMigrationFile,
  identifyMigrationFile,
  inspectMigrationDatabase,
  verifyMigrationFile,
  type CopyIdentity,
} from '@axterm/infra-storage-relational/copy';
import { migrateCopiedData as catalog } from '@axterm/plugin-catalog/copy';
import { migrateCopiedData as configuration } from '@axterm/plugin-configuration/copy';
import { migrateCopiedData as ai } from '@axterm/plugin-ai/copy';
import { migrateCopiedData as automation } from '@axterm/plugin-automation/copy';
import { migrateCopiedData as transfers } from '@axterm/plugin-transfers/copy';
import { migrateCopiedData as desktop } from '@axterm/plugin-desktop/copy';
import { migrateCopiedData as terminals } from '@axterm/plugin-terminals/copy';
import { z } from 'zod';
const entries = ['data-v2', 'vault-v2', 'desktop'] as const;
type Receipt = z.infer<typeof receipt>;
export interface HomeCopyOptions {
  readonly source: string;
  readonly home: string;
  readonly action?: 'copy' | 'resume' | 'retry';
  /** Test fault injection only, called at concrete durable transitions. Never accepts an IO replacement. */
  readonly checkpoint?: (point: string) => void | Promise<void>;
}
const journalName = 'level3-data-copy.json';
const absent = async (path: string) =>
  !(await lstat(path).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  ));
const beneath = (root: string, path: string) => {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep);
};
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return; // Windows uses atomic rename; native power-loss durability is not certified here.
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function durableJson(path: string, value: unknown): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}
async function loadReceipt(home: string): Promise<Receipt | undefined> {
  const path = join(home, journalName);
  if (await absent(path)) return;
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.size > 4096)
    throw Error('DATA_COPY_INVALID_JOURNAL');
  return receipt.parse(JSON.parse(await readFile(path, 'utf8')));
}
async function directory(path: string): Promise<void> {
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink()) throw Error('DATA_COPY_INVALID_DIRECTORY');
}
async function copyDirectory(
  source: string,
  target: string,
  limit: number,
  identities: CopyIdentity[],
  budget: { files: number },
): Promise<void> {
  await directory(source);
  await mkdir(target, { mode: 0o700 });
  const children = await readdir(source, { withFileTypes: true });
  for (const child of children) {
    if (++budget.files > 100_000 || !child.isFile() || child.isSymbolicLink())
      throw Error('DATA_COPY_INVALID_FILE_TREE');
    const identity = await copyMigrationFile(
      join(source, child.name),
      join(target, child.name),
      limit,
    );
    identities.push(identity);
  }
}
async function validateVault(path: string, references: readonly string[]): Promise<void> {
  // Opening a copied Vault may recover its own journal; the source Vault is never opened.
  const vault = new EncryptedVault(path);
  try {
    await vault.open();
    const metadata = await vault.list(),
      known = new Set(metadata.map((entry) => entry.ref));
    for (const entry of metadata) await vault.get(entry.ref);
    if (references.some((ref) => !known.has(ref))) throw Error('DATA_COPY_MISSING_CREDENTIAL');
  } finally {
    await vault.close();
  }
}
async function convert(stage: string): Promise<void> {
  const overlay = join(stage, 'copy-profile.patch.yml');
  const file = await open(overlay, 'wx', 0o600);
  try {
    await file.writeFile(
      '- id: headless-entry\n  disabled: true\n- id: credentials\n  disabled: true\n- id: desktop-runtime\n  disabled: true\n- id: desktop-task-inspection\n  disabled: true\n',
    );
    await file.sync();
  } finally {
    await file.close();
  }
  const anchor = resolve(
    dirname(createRequire(import.meta.url).resolve('@axterm/cli/profile-boot')),
    '../package.json',
  );
  const application = await runProfile({
    profile: 'headless',
    home: stage,
    installAnchor: anchor,
    templates: PROFILE_TEMPLATES,
    patchFiles: [overlay],
    args: [],
    requiredServices: ['storageDomain'],
  });
  const ctx = application.ctx;
  try {
    if (ctx.runtimeIdentity.mode !== 'headless' || ctx.get('webServer') || ctx.get('credentials'))
      throw Error('DATA_COPY_WORKER_PROFILE');
    const results = [];
    for (const owner of [catalog, configuration, ai, automation, transfers])
      results.push(await owner(ctx));
    const assetsPath = join(stage, 'data-v2/terminal-backgrounds');
    const terminal = await terminals(ctx, (await absent(assetsPath)) ? undefined : assetsPath);
    results.push(terminal);
    const preferencesPath = join(stage, 'desktop/window-preferences.json');
    const preferences = (await absent(preferencesPath))
      ? undefined
      : JSON.parse(await readFile(preferencesPath, 'utf8'));
    await desktop(ctx, preferences);
    const credentialRefs = [...new Set(results.flatMap((result) => result.credentialRefs))];
    const backgroundIds = [...new Set(results.flatMap((result) => result.backgroundIds))];
    const themeIds = [...new Set(results.flatMap((result) => result.themeIds))];
    if (themeIds.some((id) => !terminal.themes.includes(id)))
      throw Error('DATA_COPY_MISSING_THEME');
    if (backgroundIds.some((id) => !terminal.assets.includes(id)))
      throw Error('DATA_COPY_MISSING_BACKGROUND');
    await validateVault(join(stage, 'vault-v2'), credentialRefs);
  } finally {
    await application.shutdown.shutdown(0);
  }
}
async function validatePublishedRoot(root: string, id: string): Promise<void> {
  await directory(root);
  const marker = join(root, '.level3-data-copy-owner');
  const status = await lstat(marker);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.size > 64 ||
    (await readFile(marker, 'utf8')) !== id
  )
    throw Error('DATA_COPY_TARGET_CONFLICT');
}
async function targetIdentities(stage: string): Promise<CopyIdentity[]> {
  const values: CopyIdentity[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const selected = join(path, entry.name);
      if (entry.isSymbolicLink()) throw Error('DATA_COPY_INVALID_FILE_TREE');
      if (entry.isDirectory()) await walk(selected);
      else {
        if (!entry.isFile() || values.length >= 100_000) throw Error('DATA_COPY_CAPACITY');
        const value = await identifyMigrationFile(selected);
        values.push({ ...value, path: relative(stage, selected) });
      }
    }
  };
  for (const entry of entries) await walk(join(stage, entry));
  return values;
}
async function validatePrepared(
  home: string,
  stage: string,
  source: string,
  id: string,
): Promise<void> {
  const path = join(stage, 'validation.json'),
    status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.size > 64 * 1024 ** 2)
    throw Error('DATA_COPY_INVALID_VALIDATION');
  const identity = z
    .object({
      path: z.string().min(1).max(4096),
      device: z.number().nonnegative(),
      inode: z.number().nonnegative(),
      size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      modified: z.number().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict();
  const report = z
    .object({
      sources: z.array(identity).min(1).max(100_000),
      targets: z.array(identity).min(1).max(100_000),
    })
    .strict()
    .parse(JSON.parse(await readFile(path, 'utf8')));
  for (const value of report.sources) {
    if (!beneath(source, value.path)) throw Error('DATA_COPY_INVALID_VALIDATION');
    await verifyMigrationFile(value);
  }
  for (const value of report.targets) {
    const selected = resolve(stage, value.path),
      entry = entries.find((entry) => beneath(join(stage, entry), selected));
    if (!entry || isAbsolute(value.path)) throw Error('DATA_COPY_INVALID_VALIDATION');
    const staged = join(stage, entry),
      root = (await absent(staged)) ? home : stage;
    await validatePublishedRoot(join(root, entry), id);
    await verifyMigrationFile({ ...value, path: resolve(root, value.path) });
  }
}
/** Require the legacy Electron instance lease before calling; keep it until this finite worker exits. */
export async function copyGeneration2Home(
  options: HomeCopyOptions,
): Promise<{ id: string; state: 'committed' }> {
  if (!isAbsolute(options.home) || !isAbsolute(options.source))
    throw Error('DATA_COPY_ABSOLUTE_ROOT_REQUIRED');
  const source = await realpath(options.source);
  await directory(options.source);
  await mkdir(options.home, { recursive: true, mode: 0o700 });
  await directory(options.home);
  const home = await realpath(options.home);
  const normalize = (value: string) =>
    process.platform === 'darwin' || process.platform === 'win32' ? value.toLowerCase() : value;
  if (beneath(normalize(source), normalize(home)) || beneath(normalize(home), normalize(source)))
    throw Error('DATA_COPY_ROOT_ALIAS');
  const sourceIdentity = createHash('sha256').update(source).digest('hex');
  return withFileLock(
    join(home, 'data-migration'),
    async () => {
      let journal = await loadReceipt(home);
      if (journal && journal.source !== sourceIdentity) throw Error('DATA_COPY_SOURCE_CONFLICT');
      if (journal?.state === 'committed') {
        for (const entry of entries) await validatePublishedRoot(join(home, entry), journal.id);
        return { id: journal.id, state: 'committed' as const };
      }
      if (journal && options.action !== 'resume' && options.action !== 'retry')
        throw Error('DATA_COPY_RECOVERY_REQUIRED');
      if (!journal && (await readdir(home)).some((name) => name.startsWith('.level3-copy-')))
        throw Error('DATA_COPY_RECOVERY_REQUIRED');
      if (journal?.state === 'copying' && options.action !== 'retry')
        throw Error('DATA_COPY_RETRY_REQUIRED');
      if (journal?.state === 'copying') {
        for (const entry of entries)
          if (!(await absent(join(home, entry)))) throw Error('DATA_COPY_TARGET_CONFLICT');
        const stale = join(home, '.level3-copy-' + journal.id);
        await validatePublishedRoot(stale, journal.id);
        await rm(stale, { recursive: true });
        journal = undefined;
      }
      if (!journal) {
        for (const entry of entries)
          if (!(await absent(join(home, entry)))) throw Error('DATA_COPY_TARGET_CONFLICT');
        const sourceDatabase = join(source, 'data-v2/axterm.sqlite');
        await directory(join(source, 'data-v2'));
        await directory(join(source, 'vault-v2'));
        for (const required of ['master.key'])
          if (await absent(join(source, 'vault-v2', required)))
            throw Error('DATA_COPY_VAULT_MISSING');
        const medium = await lstat(sourceDatabase),
          capacity = await statfs(home, { bigint: true });
        if (capacity.bavail * capacity.bsize < BigInt(medium.size) * 3n + 32n * 1024n ** 2n)
          throw Error('DATA_COPY_NO_SPACE');
        const id = randomUUID(),
          stage = join(home, '.level3-copy-' + id);
        await mkdir(stage, { mode: 0o700 });
        const owner = await open(join(stage, '.level3-data-copy-owner'), 'wx', 0o600);
        try {
          await owner.writeFile(id);
          await owner.sync();
        } finally {
          await owner.close();
        }
        journal = {
          version: 1,
          id,
          source: sourceIdentity,
          state: 'copying',
          published: [],
          createdAt: new Date().toISOString(),
        };
        await durableJson(join(home, journalName), journal);
        await options.checkpoint?.('copying');
        const snapshot = await copyGeneration2Database(
          sourceDatabase,
          join(stage, 'scratch'),
          join(stage, 'data-v2/axterm.sqlite'),
          {
            migrations: Schema.legacyMigrations,
            minimumMigrationId: Schema.GENERATION2_MIN_SCHEMA_VERSION,
            tables: Schema.productBootstrap.tables
              .map((table) => table.table)
              .filter((table) => !(Schema.forwardTableNames as readonly string[]).includes(table)),
          },
        );
        const identities = [...snapshot.identities],
          budget = {
            files: identities.length,
          };
        await copyDirectory(
          join(source, 'vault-v2'),
          join(stage, 'vault-v2'),
          32 * 1024 ** 2,
          identities,
          budget,
        );
        await mkdir(join(stage, 'desktop'), { mode: 0o700 });
        if (!(await absent(join(source, 'desktop/window-preferences.json'))))
          identities.push(
            await copyMigrationFile(
              join(source, 'desktop/window-preferences.json'),
              join(stage, 'desktop/window-preferences.json'),
              16 * 1024,
            ),
          );
        if (!(await absent(join(source, 'data-v2/terminal-backgrounds'))))
          await copyDirectory(
            join(source, 'data-v2/terminal-backgrounds'),
            join(stage, 'data-v2/terminal-backgrounds'),
            16 * 1024 ** 2,
            identities,
            budget,
          );
        await options.checkpoint?.('copied');
        await convert(stage);
        const finalCounts = inspectMigrationDatabase(join(stage, 'data-v2/axterm.sqlite'));
        for (const [table, count] of Object.entries(snapshot.counts))
          if (table === 'app_meta' ? finalCounts[table]! < count : finalCounts[table] !== count)
            throw Error('DATA_COPY_COUNT_MISMATCH');
        for (const identity of identities) await verifyMigrationFile(identity);
        await rm(join(stage, 'scratch'), { recursive: true });
        for (const entry of entries) {
          const marker = await open(join(stage, entry, '.level3-data-copy-owner'), 'wx', 0o600);
          try {
            await marker.writeFile(id);
            await marker.sync();
          } finally {
            await marker.close();
          }
          await syncDirectory(join(stage, entry));
        }
        await durableJson(join(stage, 'validation.json'), {
          sources: identities,
          targets: await targetIdentities(stage),
        });
        journal.state = 'prepared';
        await durableJson(join(home, journalName), journal);
        await options.checkpoint?.('prepared');
      }
      const stage = join(home, '.level3-copy-' + journal.id);
      await validatePublishedRoot(stage, journal.id);
      await validatePrepared(home, stage, source, journal.id);
      journal.state = 'publishing';
      await durableJson(join(home, journalName), journal);
      for (const entry of entries) {
        const pending = join(stage, entry),
          target = join(home, entry);
        if (!(await absent(target))) {
          if (!(await absent(pending))) throw Error('DATA_COPY_TARGET_CONFLICT');
          await validatePublishedRoot(target, journal.id);
        } else {
          if (journal.published.includes(entry)) throw Error('DATA_COPY_INCOMPLETE_TARGET');
          await validatePublishedRoot(pending, journal.id);
          await rename(pending, target);
          await syncDirectory(home);
        }
        if (!journal.published.includes(entry)) journal.published.push(entry);
        await durableJson(join(home, journalName), journal);
        await options.checkpoint?.('published:' + entry);
      }
      journal.state = 'committed';
      await durableJson(join(home, journalName), journal);
      await options.checkpoint?.('committed');
      return { id: journal.id, state: 'committed' as const };
    },
    { waitMs: 0 },
  );
}
