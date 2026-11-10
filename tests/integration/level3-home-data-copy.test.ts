import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';
import { settingsSchema, workspaceLayoutSchema } from '@axterm/plugin-api/configuration';
import { terminalVisualSettingsSchema } from '@axterm/plugin-api/terminals';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { Generation2Database as ProductDatabase } from '../fixtures/migration/generation2-database.ts';
import { Generation2Vault as CredentialVault } from '../fixtures/migration/generation2-vault.ts';
import { copyGeneration2Home } from '../../apps/desktop-host/src/copy/home.ts';
import { assertDataMigrationReady } from '../../packages/infra/storage-relational/src/copy.ts';
import { DEFAULT_DESKTOP_WINDOW_PREFERENCES } from '@axterm/plugin-api/desktop';
import { legacyMigrations } from '@axterm/data-schema';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'axterm-home-copy-'));
  roots.push(root);
  const source = join(root, 'current'),
    home = join(root, 'new');
  await mkdir(join(source, 'data-v2'), { recursive: true });
  await mkdir(join(source, 'desktop'), { recursive: true });
  const database = await ProductDatabase.open(join(source, 'data-v2/axterm.sqlite'));
  database.close();
  const vault = new CredentialVault(join(source, 'vault-v2'));
  await vault.open();
  const secret = await vault.put({
    kind: 'password',
    label: 'Fixture',
    secret: 'COPY_SECRET_NEVER_LOGGED',
  });
  vault.close();
  await writeFile(
    join(source, 'desktop/window-preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: { ...DEFAULT_DESKTOP_WINDOW_PREFERENCES, zoomFactor: 1.25 },
    }),
  );
  const provider = randomUUID(),
    run = randomUUID(),
    call = randomUUID(),
    approval = randomUUID(),
    transfer = randomUUID(),
    now = new Date().toISOString();
  const sql = new DatabaseSync(join(source, 'data-v2/axterm.sqlite'));
  sql
    .prepare('INSERT INTO ai_providers(id,name,payload,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(
      provider,
      'Retained',
      JSON.stringify({
        credentialRef: secret.ref,
        enabled: true,
        baseUrl: 'https://fixture.invalid/v1',
      }),
      now,
      now,
    );
  sql
    .prepare(
      'INSERT INTO ai_runs(id,state,use_case,request,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    )
    .run(run, 'running', 'chat', '{}', now, now);
  sql
    .prepare(
      'INSERT INTO ai_tool_calls(id,run_id,tool_name,risk,args_hash,args_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(call, run, 'workspace.exec', 'mutating', 'a'.repeat(64), '{}', 'running', now, now);
  sql
    .prepare(
      'INSERT INTO ai_approvals(id,run_id,tool_call_id,args_hash,target,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(
      approval,
      run,
      call,
      'a'.repeat(64),
      'fixture',
      'pending',
      new Date(Date.now() + 60000).toISOString(),
      now,
      now,
    );
  sql
    .prepare(
      'INSERT INTO transfer_history(id,connection_id,direction,state,source,destination,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(transfer, randomUUID(), 'download', 'running', 'remote.txt', 'old-stage', now, now);
  sql.close();
  return { root, source, home, ref: secret.ref, run, approval, call, transfer };
}
async function hashes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (path: string, prefix: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(path, entry.name), name + '/');
      else
        result[name] = createHash('sha256')
          .update(await readFile(join(path, entry.name)))
          .digest('hex');
    }
  };
  await walk(root, '');
  return result;
}
it('copies WAL consistently, keeps source/key/ciphertext unchanged and interrupts old approvals/tasks without replay', async () => {
  const f = await fixture(),
    live = new DatabaseSync(join(f.source, 'data-v2/axterm.sqlite'));
  live.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO app_meta VALUES('copy-wal-fixture','retained');",
  );
  try {
    const original = await hashes(f.source);
    await expect(copyGeneration2Home(f)).resolves.toMatchObject({ state: 'committed' });
    expect(await hashes(f.source)).toEqual(original);
    expect(await readFile(join(f.home, 'vault-v2/master.key'))).toEqual(
      await readFile(join(f.source, 'vault-v2/master.key')),
    );
    expect(await readFile(join(f.home, 'vault-v2', f.ref + '.bin'))).toEqual(
      await readFile(join(f.source, 'vault-v2', f.ref + '.bin')),
    );
    await assertDataMigrationReady(f.home);
    const target = new DatabaseSync(join(f.home, 'data-v2/axterm.sqlite'), { readOnly: true });
    try {
      expect(
        target.prepare("SELECT value FROM app_meta WHERE key='copy-wal-fixture'").get()?.value,
      ).toBe('retained');
      expect(target.prepare('SELECT state,error_code FROM ai_runs WHERE id=?').get(f.run)).toEqual({
        state: 'failed',
        error_code: 'RUNTIME_INTERRUPTED',
      });
      expect(
        target.prepare('SELECT state FROM ai_approvals WHERE id=?').get(f.approval)?.state,
      ).toBe('expired');
      expect(target.prepare('SELECT state FROM ai_tool_calls WHERE id=?').get(f.call)?.state).toBe(
        'failed',
      );
      expect(
        target.prepare('SELECT state,error_code FROM transfer_history WHERE id=?').get(f.transfer),
      ).toEqual({ state: 'failed', error_code: 'RUNTIME_INTERRUPTED' });
      expect(
        JSON.parse(String(target.prepare('SELECT payload FROM ai_providers').get()?.payload))
          .engineId,
      ).toBe('pi');
      expect(
        JSON.parse(
          String(
            target.prepare('SELECT document_json FROM axterm_desktop_preferences').get()
              ?.document_json,
          ),
        ).zoomFactor,
      ).toBe(1.25);
    } finally {
      target.close();
    }
    const again = await copyGeneration2Home({ ...f, action: 'resume' });
    expect(again.state).toBe('committed');
  } finally {
    live.close();
  }
});
for (const point of ['copying', 'prepared', 'published:data-v2', 'published:vault-v2'])
  it(
    'recovers interruption at ' + point + ' and refuses normal startup until committed',
    async () => {
      const f = await fixture(),
        original = await hashes(f.source);
      await expect(
        copyGeneration2Home({
          ...f,
          checkpoint: (at) => {
            if (at === point) throw Error('SIMULATED_PROCESS_INTERRUPTION');
          },
        }),
      ).rejects.toThrow('SIMULATED_PROCESS_INTERRUPTION');
      await expect(assertDataMigrationReady(f.home)).rejects.toThrow('RECOVERY_REQUIRED');
      await expect(copyGeneration2Home(f)).rejects.toThrow('RECOVERY_REQUIRED');
      await expect(
        copyGeneration2Home({ ...f, action: point === 'copying' ? 'retry' : 'resume' }),
      ).resolves.toMatchObject({ state: 'committed' });
      expect(await hashes(f.source)).toEqual(original);
    },
  );
it('copies the genuine generation-2 migration-41 prefix and upgrades only the private target through registered storage', async () => {
  const f = await fixture();
  const source = new DatabaseSync(join(f.source, 'data-v2/axterm.sqlite'));
  try {
    source.exec(
      "ALTER TABLE ai_tool_calls DROP COLUMN review_json; ALTER TABLE ai_tool_calls DROP COLUMN step; ALTER TABLE ai_tool_calls DROP COLUMN approval_source; DELETE FROM app_meta WHERE key='migration:42';",
    );
    expect(
      source.prepare("SELECT value FROM app_meta WHERE key='axterm:schema-generation'").get(),
    ).toEqual({ value: '2' });
  } finally {
    source.close();
  }
  const before = await hashes(f.source);
  await expect(copyGeneration2Home(f)).resolves.toMatchObject({ state: 'committed' });
  expect(await hashes(f.source)).toEqual(before);
  const target = new DatabaseSync(join(f.home, 'data-v2/axterm.sqlite'), { readOnly: true });
  try {
    expect(target.prepare("SELECT value FROM app_meta WHERE key='migration:42'").get()).toEqual({
      value: createHash('sha256')
        .update(legacyMigrations.find((entry) => entry.id === 42)!.sql)
        .digest('hex'),
    });
    expect(
      target
        .prepare('PRAGMA table_info(ai_tool_calls)')
        .all()
        .map((row) => row.name),
    ).toEqual(expect.arrayContaining(['review_json', 'step', 'approval_source']));
    expect(target.prepare('SELECT state,error_code FROM ai_runs WHERE id=?').get(f.run)).toEqual({
      state: 'failed',
      error_code: 'RUNTIME_INTERRUPTED',
    });
    expect(target.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  } finally {
    target.close();
  }
  expect(await readFile(join(f.home, 'vault-v2/master.key'))).toEqual(
    await readFile(join(f.source, 'vault-v2/master.key')),
  );
  expect(await readFile(join(f.home, 'vault-v2', f.ref + '.bin'))).toEqual(
    await readFile(join(f.source, 'vault-v2', f.ref + '.bin')),
  );
});

it('rejects a missing middle migration instead of treating the ledger as a historical prefix', async () => {
  const f = await fixture();
  const database = new DatabaseSync(join(f.source, 'data-v2/axterm.sqlite'));
  try {
    database.exec("DELETE FROM app_meta WHERE key='migration:38'");
  } finally {
    database.close();
  }
  const before = await hashes(f.source);
  await expect(copyGeneration2Home(f)).rejects.toThrow('DATA_COPY_UNSUPPORTED_SCHEMA');
  expect(await hashes(f.source)).toEqual(before);
  await expect(readFile(join(f.home, 'data-v2/axterm.sqlite'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('rejects target conflicts and source aliases without merging unrelated files', async () => {
  const f = await fixture();
  await mkdir(join(f.home, 'data-v2'), { recursive: true });
  await writeFile(join(f.home, 'keep.txt'), 'keep');
  await expect(copyGeneration2Home(f)).rejects.toThrow('TARGET_CONFLICT');
  expect(await readFile(join(f.home, 'keep.txt'), 'utf8')).toBe('keep');
  await expect(copyGeneration2Home({ ...f, home: f.source })).rejects.toThrow('ROOT_ALIAS');
});
it('rejects corrupt ciphertext and missing Vault key before publishing any target', async () => {
  for (const broken of ['cipher', 'key']) {
    const f = await fixture();
    if (broken === 'cipher') await writeFile(join(f.source, 'vault-v2', f.ref + '.bin'), 'CORRUPT');
    else await rm(join(f.source, 'vault-v2/master.key'));
    await expect(copyGeneration2Home(f)).rejects.toThrow();
    await expect(readFile(join(f.home, 'data-v2/axterm.sqlite'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }
});
it('rejects symlinked source media and modified source/prepared target on resume', async () => {
  const f = await fixture();
  await symlink(
    join(f.source, 'desktop/window-preferences.json'),
    join(f.source, 'vault-v2/escape'),
  );
  await expect(copyGeneration2Home(f)).rejects.toThrow('INVALID_FILE_TREE');
  await rm(join(f.source, 'vault-v2/escape'));
  await expect(
    copyGeneration2Home({
      ...f,
      action: 'retry',
      checkpoint: (point) => {
        if (point === 'prepared') throw Error('PAUSE');
      },
    }),
  ).rejects.toThrow('PAUSE');
  const journal = JSON.parse(await readFile(join(f.home, 'level3-data-copy.json'), 'utf8'));
  await writeFile(
    join(f.home, '.level3-copy-' + journal.id, 'vault-v2', f.ref + '.bin'),
    'TAMPERED',
  );
  await expect(copyGeneration2Home({ ...f, action: 'resume' })).rejects.toThrow('SOURCE_CHANGED');
});
it('keeps failed copy recoverable on injected ENOSPC and never touches source data', async () => {
  const f = await fixture(),
    original = await hashes(f.source);
  await expect(
    copyGeneration2Home({
      ...f,
      checkpoint: (point) => {
        if (point === 'copied') throw Object.assign(Error('SIMULATED_ENOSPC'), { code: 'ENOSPC' });
      },
    }),
  ).rejects.toThrow('SIMULATED_ENOSPC');
  expect(await hashes(f.source)).toEqual(original);
  await expect(copyGeneration2Home({ ...f, action: 'retry' })).resolves.toMatchObject({
    state: 'committed',
  });
});
it('rejects unsupported generations and missing credential references before publication', async () => {
  for (const broken of ['generation', 'credential']) {
    const f = await fixture(),
      database = new DatabaseSync(join(f.source, 'data-v2/axterm.sqlite'));
    if (broken === 'generation')
      database.exec("UPDATE app_meta SET value='1' WHERE key='axterm:schema-generation'");
    else
      database
        .prepare('UPDATE ai_providers SET payload=?')
        .run(JSON.stringify({ credentialRef: 'cred_' + randomUUID() }));
    database.close();
    await expect(copyGeneration2Home(f)).rejects.toThrow(
      broken === 'generation' ? 'UNSUPPORTED_GENERATION' : 'MISSING_CREDENTIAL',
    );
    await expect(readFile(join(f.home, 'data-v2/axterm.sqlite'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }
});
it('accepts the current empty Vault format and preserves its existing master key', async () => {
  const f = await fixture(),
    database = new DatabaseSync(join(f.source, 'data-v2/axterm.sqlite'));
  database.exec('DELETE FROM ai_providers');
  database.close();
  await rm(join(f.source, 'vault-v2', f.ref + '.bin'));
  await rm(join(f.source, 'vault-v2/metadata.json'));
  await expect(copyGeneration2Home(f)).resolves.toMatchObject({ state: 'committed' });
  expect(await readFile(join(f.home, 'vault-v2/master.key'))).toEqual(
    await readFile(join(f.source, 'vault-v2/master.key')),
  );
});
it('imports retained background IDs and pure workspace metadata without importing old stages', async () => {
  const f = await fixture(),
    id = randomUUID(),
    database = new DatabaseSync(join(f.source, 'data-v2/axterm.sqlite'));
  const visual = terminalVisualSettingsSchema.parse({}),
    tab = randomUUID();
  visual.background = { ...visual.background, kind: 'image', assetId: id };
  const workspace = settingsSchema.shape.workspace.parse({
    restoreLayout: true,
    aiInspectorOpen: false,
    layout: workspaceLayoutSchema.parse({
      section: 'hosts',
      sidebarOpen: true,
      tabs: [{ id: tab, kind: 'local', title: 'Retained', pinned: false, paneIndex: 0, visual }],
      activeTerminalId: tab,
    }),
  });
  database
    .prepare(
      "INSERT INTO app_settings(section,payload,updated_at) VALUES('workspace',?,?) ON CONFLICT(section) DO UPDATE SET payload=excluded.payload",
    )
    .run(JSON.stringify(workspace), new Date().toISOString());
  database.close();
  await mkdir(join(f.source, 'data-v2/terminal-backgrounds'));
  await mkdir(join(f.source, 'data-v2/terminal-stages'));
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0X8AAAAASUVORK5CYII=',
    'base64',
  );
  await writeFile(join(f.source, 'data-v2/terminal-backgrounds', id + '.png'), image);
  await writeFile(join(f.source, 'data-v2/terminal-stages/unfinished'), 'DO_NOT_REPLAY_OR_CLEAN');
  await copyGeneration2Home(f);
  const target = new DatabaseSync(join(f.home, 'data-v2/axterm.sqlite'), { readOnly: true });
  try {
    expect(
      target.prepare('SELECT id,bytes FROM terminal_background_assets WHERE id=?').get(id),
    ).toEqual({ id, bytes: image.length });
    expect(
      JSON.parse(
        String(
          target.prepare("SELECT payload FROM app_settings WHERE section='workspace'").get()
            ?.payload,
        ),
      ),
    ).toEqual(workspace);
  } finally {
    target.close();
  }
  await expect(readFile(join(f.home, 'data-v2/terminal-stages/unfinished'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await readFile(join(f.source, 'data-v2/terminal-stages/unfinished'), 'utf8')).toBe(
    'DO_NOT_REPLAY_OR_CLEAN',
  );
});

it('blocks every Profile during copy and pending recovery, then admits the finite headless Profile', async () => {
  const f = await fixture(),
    options = {
      profile: 'headless',
      home: f.home,
      installAnchor: resolve('apps/cli/package.json'),
      templates: PROFILE_TEMPLATES,
      patchFiles: [],
      args: [],
      requiredServices: ['storageDomain'],
    };
  await expect(
    copyGeneration2Home({
      ...f,
      checkpoint: async (point) => {
        if (point !== 'copying') return;
        await expect(runProfile(options)).rejects.toThrow(/writer lock/);
        throw Error('INTERRUPTED');
      },
    }),
  ).rejects.toThrow('INTERRUPTED');
  await expect(runProfile(options)).rejects.toThrow('RECOVERY_REQUIRED');
  await copyGeneration2Home({ ...f, action: 'retry' });
  const result = await promisify(execFile)(
    process.execPath,
    ['--expose-internals', resolve('apps/cli/lib/index.js'), '--profile', 'headless', '--health'],
    { env: { ...process.env, HOME: f.root, AXTERM_HOME: f.home }, timeout: 10000 },
  );
  expect(JSON.parse(result.stdout)).toMatchObject({ status: 'ok', mode: 'headless' });
});
it('recovers a real killed migration process from its durable prepared journal', async () => {
  const f = await fixture(),
    script = join(f.root, 'crash-copy.mjs'),
    original = await hashes(f.source);
  await writeFile(
    script,
    `import{copyGeneration2Home}from${JSON.stringify(pathToFileURL(resolve('apps/desktop-host/lib/copy.js')).href)};process.on('message',()=>{});await copyGeneration2Home({source:${JSON.stringify(f.source)},home:${JSON.stringify(f.home)},checkpoint:async point=>{if(point==='prepared'){process.send({prepared:true});await new Promise(()=>{});}}});`,
  );
  const child = fork(script, [], {
    execArgv: ['--expose-internals'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, HOME: f.root, AXTERM_HOME: f.home },
  });
  const closed = once(child, 'close');
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(Error('COPY_CHILD_TIMEOUT')), 10000);
      child.once('message', () => {
        clearTimeout(timer);
        done();
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(Error('COPY_CHILD_EXIT_' + code));
      });
    });
    child.kill('SIGKILL');
    await closed;
    await expect(copyGeneration2Home({ ...f, action: 'resume' })).resolves.toMatchObject({
      state: 'committed',
    });
    expect(await hashes(f.source)).toEqual(original);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await closed;
    }
  }
}, 15000);
it('interrupts copied batch targets/steps and clears an in-flight sync preview through their owners', async () => {
  const f = await fixture(),
    id = crypto.randomUUID(),
    sync = crypto.randomUUID(),
    now = new Date().toISOString();
  const database = new DatabaseSync(join(f.source, 'data-v2/axterm.sqlite'));
  const payload = {
    concurrency: 1,
    completedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    canceledCount: 0,
    targets: [
      {
        bookmarkId: crypto.randomUUID(),
        title: 'Fixture',
        state: 'running',
        steps: [
          { stepId: crypto.randomUUID(), name: 'Never replay', state: 'running', exitCode: null },
        ],
      },
    ],
  };
  database
    .prepare(
      'INSERT INTO batch_operations(id,name,state,target_count,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    )
    .run(id, 'Batch', 'running', 1, JSON.stringify(payload), now, now);
  database
    .prepare(
      'INSERT INTO sync_profiles(id,provider,format,name,endpoint_url,remote_id,selected_categories,state,pending_preview_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      sync,
      'custom',
      'axterm-sync-v1',
      'Sync',
      'https://fixture.invalid',
      'fixture',
      '["bookmarks"]',
      'checking',
      crypto.randomUUID(),
      now,
      now,
    );
  database.close();
  const before = await hashes(f.source);
  await copyGeneration2Home(f);
  expect(await hashes(f.source)).toEqual(before);
  const target = new DatabaseSync(join(f.home, 'data-v2/axterm.sqlite'), { readOnly: true });
  try {
    const batch = target.prepare('SELECT state,payload FROM batch_operations WHERE id=?').get(id)!;
    expect(batch.state).toBe('interrupted');
    const converted = JSON.parse(String(batch.payload));
    expect(converted.targets[0].state).toBe('failed');
    expect(converted.targets[0].steps[0].state).toBe('canceled');
    expect(
      target
        .prepare('SELECT state,last_error_code,pending_preview_id FROM sync_profiles WHERE id=?')
        .get(sync),
    ).toEqual({
      state: 'failed',
      last_error_code: 'RUNTIME_INTERRUPTED',
      pending_preview_id: null,
    });
  } finally {
    target.close();
  }
});
it('rejects a modified committed migration checksum without publishing or repairing source', async () => {
  const f = await fixture(),
    database = new DatabaseSync(join(f.source, 'data-v2/axterm.sqlite'));
  database.prepare("UPDATE app_meta SET value=? WHERE key='migration:42'").run('0'.repeat(64));
  database.close();
  const original = await hashes(f.source);
  await expect(copyGeneration2Home(f)).rejects.toThrow('UNSUPPORTED_SCHEMA');
  expect(await hashes(f.source)).toEqual(original);
});
it('rejects missing custom image/theme references in otherwise valid retained workspace metadata', async () => {
  for (const missing of ['BACKGROUND', 'THEME']) {
    const f = await fixture(),
      visual = terminalVisualSettingsSchema.parse({}),
      tab = randomUUID();
    if (missing === 'BACKGROUND')
      visual.background = { ...visual.background, kind: 'image', assetId: randomUUID() };
    else visual.themeId = randomUUID();
    const workspace = settingsSchema.shape.workspace.parse({
      restoreLayout: true,
      aiInspectorOpen: false,
      layout: workspaceLayoutSchema.parse({
        section: 'hosts',
        sidebarOpen: true,
        tabs: [{ id: tab, kind: 'local', title: 'Retained', pinned: false, paneIndex: 0, visual }],
        activeTerminalId: tab,
      }),
    });
    const database = new DatabaseSync(join(f.source, 'data-v2/axterm.sqlite'));
    database
      .prepare(
        "INSERT INTO app_settings(section,payload,updated_at) VALUES('workspace',?,?) ON CONFLICT(section) DO UPDATE SET payload=excluded.payload",
      )
      .run(JSON.stringify(workspace), new Date().toISOString());
    database.close();
    await expect(copyGeneration2Home(f)).rejects.toThrow('MISSING_' + missing);
    await expect(readFile(join(f.home, 'data-v2/axterm.sqlite'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }
});
