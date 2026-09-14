import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, chromium } from '@playwright/test';
import { assertElectermBaseline, electermRoot, readJson, repositoryRoot } from './baseline.mjs';
import { withInteractionTrace } from './interaction-trace.mjs';

const desktopRequire = createRequire(resolve(repositoryRoot, 'apps/desktop/package.json'));
const { Server: ParitySshServer, utils: paritySshUtils } = desktopRequire('ssh2');

function option(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function resolveLaunch(target, userData) {
  if (target === 'axterm') {
    return {
      executablePath: desktopRequire('electron'),
      args: [resolve(repositoryRoot, 'apps/desktop'), `--user-data-dir=${userData}`],
      cwd: repositoryRoot,
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    };
  }
  if (target === 'electerm') {
    assertElectermBaseline();
    const workApp = resolve(electermRoot, 'work/app');
    if (!existsSync(workApp))
      throw new Error(
        'Pinned Electerm work/app is absent. Run bun run parity:prepare:electerm first.',
      );
    const require = createRequire(resolve(electermRoot, 'package.json'));
    const preload = resolve(repositoryRoot, 'scripts/parity/electerm-reference-preload.cjs');
    return {
      executablePath: require('electron'),
      // Electerm's own development script launches the entry file explicitly.
      // Passing the directory makes Electron 42 exit before app.whenReady().
      args: [resolve(workApp, 'app.js'), `--user-data-dir=${userData}`, '--disable-gpu'],
      cwd: electermRoot,
      // Electerm's single-instance transport is keyed only by the application
      // name and lives below app.getPath('temp'). Isolate it so a developer's
      // running Electerm process cannot consume or terminate parity captures.
      env: {
        ...process.env,
        AXTERM_ELECTERM_PARITY: '1',
        NODE_TEST: 'yes',
        HOME: userData,
        USERPROFILE: userData,
        XDG_CONFIG_HOME: resolve(userData, 'config'),
        XDG_DATA_HOME: resolve(userData, 'data'),
        XDG_CACHE_HOME: resolve(userData, 'cache'),
        TMPDIR: userData,
        NODE_OPTIONS: `--require=${preload}`,
      },
    };
  }
  throw new Error(`Unknown capture target: ${target}`);
}

async function waitForAxtermTerminals(page) {
  await page.waitForFunction(
    () =>
      [...globalThis.document.querySelectorAll('.terminal-host')].every(
        (terminal) => terminal.getAttribute('data-connection-state') === 'connected',
      ),
    null,
    { timeout: 60_000 },
  );
}

async function waitForElectermTerminals(page) {
  await page.waitForFunction(() => globalThis.store?.currentTab?.status === 'success', null, {
    timeout: 60_000,
  });
}

async function openElectermContextMenu(page, selector) {
  const trigger = page.locator(selector).first();
  const menu = page.locator('.ant-dropdown:not(.ant-dropdown-hidden)').first();
  await trigger.waitFor({ state: 'visible', timeout: 10_000 });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await trigger.click({ button: 'right', position: { x: 30, y: 20 } });
    try {
      await menu.waitFor({ state: 'visible', timeout: 2_000 });
      return;
    } catch {
      // Electerm's own E2E helper retries this Ant Dropdown race.
    }
  }
  throw new Error(`Electerm context menu did not open for ${selector}`);
}

async function settleTargetLayout(page) {
  await page.evaluate(async () => {
    await globalThis.document.fonts?.ready;
    // xterm's fit add-on caches cell metrics. Re-run the target's normal resize
    // path after webfonts settle so a stable fallback-font fit is not accepted.
    if (typeof globalThis.store?.triggerResize === 'function') globalThis.store.triggerResize();
    else globalThis.dispatchEvent(new globalThis.Event('resize'));
    await new Promise((resolveFrame) =>
      globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolveFrame)),
    );
  });
  await page.waitForTimeout(250);
}

async function suppressElectermUpgrade(page) {
  await page.evaluate(() => {
    if (globalThis.et) globalThis.et.disableUpgradeCheck = true;
    if (globalThis.store?.config) globalThis.store.config.checkUpdateOnStart = false;
    if (globalThis.store) {
      globalThis.store.onCheckUpdate = () => {};
      globalThis.store.upgradeInfo = {};
    }
    let style = globalThis.document.getElementById('axterm-parity-hide-upgrade');
    if (!style) {
      style = globalThis.document.createElement('style');
      style.id = 'axterm-parity-hide-upgrade';
      style.textContent = '.upgrade-panel{display:none!important}';
      globalThis.document.head.append(style);
    }
  });
}

function seedAxtermBookmarkTree(userData) {
  const database = new DatabaseSync(resolve(userData, 'data', 'axterm.sqlite'));
  database.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
  try {
    const now = new Date().toISOString();
    const group = database.prepare(`
      INSERT INTO bookmark_groups(
        id, parent_id, name, color, description, position, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const groups = [
      ['10000000-0000-4000-8000-000000000001', null, 'default', '#0088cc', '', 0],
      [
        '10000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000001',
        'Production',
        '#0088cc',
        '',
        0,
      ],
      [
        '10000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000002',
        'Region East',
        '#0088cc',
        '',
        0,
      ],
      [
        '10000000-0000-4000-8000-000000000004',
        '10000000-0000-4000-8000-000000000001',
        'Archive',
        '#0088cc',
        '',
        1,
      ],
    ];
    for (const values of groups) group.run(...values, now, now);

    const host = database.prepare(`
      INSERT INTO hosts(
        id, group_id, name, hostname, port, username, auth_type, credential_ref,
        passphrase_credential_ref, jump_host_id, favorite, created_at, updated_at, version
      ) VALUES (?, NULL, ?, ?, 22, ?, 'agent', NULL, NULL, NULL, 0, ?, ?, 1)
    `);
    const bookmark = database.prepare(`
      INSERT INTO bookmarks(
        id, group_id, protocol, host_id, title, color, description, position,
        profile_id, connection_profile_id, created_at, updated_at, version
      ) VALUES (?, ?, 'ssh', ?, ?, ?, ?, 0, NULL, NULL, ?, ?, 1)
    `);
    const entries = [
      {
        id: '20000000-0000-4000-8000-000000000001',
        groupId: '10000000-0000-4000-8000-000000000003',
        name: 'Production API',
        hostname: 'prod-api.example.test',
        username: 'ops',
        color: '#22aa66',
        description: 'Primary operations target',
      },
      {
        id: '20000000-0000-4000-8000-000000000002',
        groupId: '10000000-0000-4000-8000-000000000004',
        name: 'Archive Mirror',
        hostname: 'archive.example.test',
        username: 'backup',
        color: '#aa66cc',
        description: 'Read-only archive mirror',
      },
    ];
    for (const entry of entries) {
      host.run(entry.id, entry.name, entry.hostname, entry.username, now, now);
      bookmark.run(
        entry.id,
        entry.groupId,
        entry.id,
        entry.name,
        entry.color,
        entry.description,
        now,
        now,
      );
    }
    database.exec(`
      UPDATE app_meta SET value=CAST(CAST(value AS INTEGER) + 1 AS TEXT)
      WHERE key='bookmark-tree:revision';
      COMMIT;
    `);
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

async function prepareAxtermBookmarkTree(page, userData) {
  seedAxtermBookmarkTree(userData);
  await page.reload();
  await page.locator('[data-testid="runtime-state"][data-state="ready"]').waitFor();
  await page.locator('.terminal-host[data-connection-state="connected"]').waitFor();
  await page.locator('[data-activity-item="bookmarks"]').click();
  const production = page.getByRole('treeitem', { name: 'Production', exact: true });
  const defaultGroup = page.getByRole('treeitem', { name: 'default', exact: true });
  if ((await defaultGroup.getAttribute('aria-expanded')) !== 'true')
    await defaultGroup.locator('.bookmark-row-main').click();
  if ((await production.getAttribute('aria-expanded')) !== 'true')
    await production.locator('.bookmark-row-main').click();
  const region = page.getByRole('treeitem', { name: 'Region East', exact: true });
  if ((await region.getAttribute('aria-expanded')) !== 'true')
    await region.locator('.bookmark-row-main').click();
  const archive = page.getByRole('treeitem', { name: 'Archive', exact: true });
  if ((await archive.getAttribute('aria-expanded')) !== 'true')
    await archive.locator('.bookmark-row-main').click();
  await page.locator('[data-bookmark-title="Production API"]').waitFor();
  await page.locator('[data-bookmark-title="Archive Mirror"]').waitFor();
  await page.locator('.terminal-host').click({ position: { x: 20, y: 20 } });
}

async function prepareElectermBookmarkTree(page) {
  await page.evaluate(() => {
    const bookmarks = [
      {
        id: 'prod-api',
        title: 'Production API',
        host: 'prod-api.example.test',
        username: 'ops',
        port: 22,
        type: 'ssh',
        color: '#22aa66',
        description: 'Primary operations target',
        term: 'xterm-256color',
      },
      {
        id: 'archive-mirror',
        title: 'Archive Mirror',
        host: 'archive.example.test',
        username: 'backup',
        port: 22,
        type: 'ssh',
        color: '#aa66cc',
        description: 'Read-only archive mirror',
        term: 'xterm-256color',
      },
    ];
    const bookmarkGroups = [
      {
        id: 'default',
        title: 'default',
        bookmarkIds: [],
        bookmarkGroupIds: ['production', 'archive'],
        color: '#0088cc',
      },
      {
        id: 'production',
        title: 'Production',
        bookmarkIds: [],
        bookmarkGroupIds: ['region-east'],
        level: 2,
        color: '#0088cc',
      },
      {
        id: 'region-east',
        title: 'Region East',
        bookmarkIds: ['prod-api'],
        bookmarkGroupIds: [],
        level: 3,
        color: '#0088cc',
      },
      {
        id: 'archive',
        title: 'Archive',
        bookmarkIds: ['archive-mirror'],
        bookmarkGroupIds: [],
        level: 2,
        color: '#0088cc',
      },
    ];
    globalThis.store.setItems('bookmarks', bookmarks);
    globalThis.store.setItems('bookmarkGroups', bookmarkGroups);
    globalThis.store.bookmarksMap = new Map(bookmarks.map((bookmark) => [bookmark.id, bookmark]));
    globalThis.store.expandedKeys = bookmarkGroups.map((group) => group.id);
    globalThis.store.pinned = true;
    globalThis.store.setOpenedSideBar('bookmarks');
  });
  await page.locator('.sidebar-panel-bookmarks .tree-item[data-item-id="prod-api"]').waitFor();
  await page
    .locator('.sidebar-panel-bookmarks .tree-item[data-item-id="archive-mirror"]')
    .waitFor();
  await settleTargetLayout(page);
}

function seedAxtermConnectionHistory(userData) {
  const database = new DatabaseSync(resolve(userData, 'data', 'axterm.sqlite'));
  database.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;');
  try {
    const insert = database.prepare(`
      INSERT INTO recent_connections(
        id, target_key, host_id, name, hostname, port, username, auth_type, jump_host_id,
        connection_timeout_ms, keepalive_interval_ms, keepalive_count_max, compression,
        reconnect_mode, reconnect_delay_ms, reconnect_max_attempts, connection_count,
        last_connected_at, created_at, updated_at, version
      ) VALUES (?, ?, NULL, ?, ?, 22, ?, 'agent', NULL, 50000, 10000, 10, 1,
        'manual', 3000, 10, ?, ?, ?, ?, 1)
    `);
    const now = Date.now();
    const rows = [
      {
        id: '00000000-0000-4000-8000-000000000041',
        name: 'Production API',
        hostname: 'prod-api.example.test',
        username: 'ops',
        count: 8,
        age: 2 * 60_000,
      },
      {
        id: '00000000-0000-4000-8000-000000000042',
        name: 'Staging Worker',
        hostname: 'staging-worker.example.test',
        username: 'deploy',
        count: 3,
        age: 18 * 60_000,
      },
      {
        id: '00000000-0000-4000-8000-000000000043',
        name: 'Archive Mirror',
        hostname: 'archive.example.test',
        username: 'backup',
        count: 1,
        age: 2 * 60 * 60_000,
      },
    ];
    for (const row of rows) {
      const lastConnectedAt = new Date(now - row.age).toISOString();
      const createdAt = new Date(now - row.age - 86_400_000).toISOString();
      insert.run(
        row.id,
        JSON.stringify([row.hostname, 22, row.username]),
        row.name,
        row.hostname,
        row.username,
        row.count,
        lastConnectedAt,
        createdAt,
        lastConnectedAt,
      );
    }
    database.exec(`
      UPDATE app_meta SET value=CAST(CAST(value AS INTEGER) + 1 AS TEXT)
      WHERE key='connection-history:revision';
      COMMIT;
    `);
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

function seedAxtermAiAgent(userData) {
  const database = new DatabaseSync(resolve(userData, 'data', 'axterm.sqlite'));
  database.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
  try {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const providerId = '81000000-0000-4000-8000-000000000001';
    const modelId = '81000000-0000-4000-8000-000000000002';
    const conversationId = '81000000-0000-4000-8000-000000000003';
    const runId = '81000000-0000-4000-8000-000000000004';
    const readCallId = '81000000-0000-4000-8000-000000000005';
    const execCallId = '81000000-0000-4000-8000-000000000006';
    database
      .prepare(
        'INSERT INTO ai_providers(id, name, payload, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1)',
      )
      .run(
        providerId,
        'OpenAI Compatible',
        JSON.stringify({
          name: 'OpenAI Compatible',
          baseUrl: 'https://api.openai.com/v1/',
          apiPath: '/chat/completions',
          protocol: 'openai-chat',
          auth: 'bearer',
          role: 'Terminal expert. Explain commands and effects clearly.',
          proxy: null,
          timeoutMs: 60_000,
          credentialRef: 'parity-local-ai-credential',
          enabled: true,
        }),
        now,
        now,
      );
    database
      .prepare(
        'INSERT INTO ai_models(id, name, payload, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1)',
      )
      .run(
        modelId,
        'gpt-4.1-mini',
        JSON.stringify({
          name: 'gpt-4.1-mini',
          providerId,
          model: 'gpt-4.1-mini',
          capabilities: ['chat', 'tools'],
        }),
        now,
        now,
      );
    database
      .prepare(
        'INSERT INTO ai_conversations(id, name, payload, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1)',
      )
      .run(
        conversationId,
        'Investigate deployment health',
        JSON.stringify({ name: 'Investigate deployment health', modelId, useCase: 'diagnose' }),
        now,
        now,
      );
    database
      .prepare(
        `INSERT INTO ai_runs(
           id, conversation_id, state, use_case, request, result, error_code,
           created_at, updated_at, version
         ) VALUES (?, ?, 'waiting_approval', 'diagnose', ?, NULL, NULL, ?, ?, 1)`,
      )
      .run(runId, conversationId, JSON.stringify({ prompt: 'Check deployment health' }), now, now);
    database
      .prepare(
        `INSERT INTO ai_messages(
           id, conversation_id, run_id, role, content, attachments_json, state,
           created_at, updated_at, version
         ) VALUES (?, ?, ?, 'user', ?, '[]', 'complete', ?, ?, 1)`,
      )
      .run(
        '81000000-0000-4000-8000-000000000007',
        conversationId,
        runId,
        'Check deployment health and propose a safe diagnostic command.',
        now,
        now,
      );
    const insertCall = database.prepare(
      `INSERT INTO ai_tool_calls(
         id, run_id, tool_name, risk, args_hash, args_json, target, state,
         result_metadata, created_at, updated_at, version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    insertCall.run(
      readCallId,
      runId,
      'terminal.getRecentOutput',
      'read_only',
      'read-output-parity-hash',
      '{}',
      'local-terminal',
      'succeeded',
      JSON.stringify({ output: 'service status: degraded' }),
      now,
      now,
    );
    insertCall.run(
      execCallId,
      runId,
      'terminal.exec',
      'mutating',
      'exact-command-parity-hash',
      JSON.stringify({ command: 'systemctl status api.service' }),
      'local-terminal',
      'waiting_approval',
      null,
      now,
      now,
    );
    database
      .prepare(
        `INSERT INTO ai_approvals(
           id, run_id, tool_call_id, args_hash, target, state, expires_at, decided_at,
           created_at, updated_at, version
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, 1)`,
      )
      .run(
        '81000000-0000-4000-8000-000000000008',
        runId,
        execCallId,
        'exact-command-parity-hash',
        'local-terminal',
        expiresAt,
        now,
        now,
      );
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

function seedAxtermCanceledAiChat(userData) {
  seedAxtermAiAgent(userData);
  const database = new DatabaseSync(resolve(userData, 'data', 'axterm.sqlite'));
  database.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
  try {
    const updatedAt = new Date().toISOString();
    const conversationId = '81000000-0000-4000-8000-000000000003';
    const runId = '81000000-0000-4000-8000-000000000004';
    database
      .prepare(
        `UPDATE ai_conversations
            SET name=?, payload=?, updated_at=?, version=version+1
          WHERE id=?`,
      )
      .run(
        'Explain interrupted deployment output',
        JSON.stringify({
          name: 'Explain interrupted deployment output',
          modelId: '81000000-0000-4000-8000-000000000002',
          useCase: 'explainOutput',
        }),
        updatedAt,
        conversationId,
      );
    database
      .prepare(
        `UPDATE ai_runs
            SET state='canceled', use_case='explainOutput', result=?, error_code='REQUEST_CANCELED',
                updated_at=?, version=version+1
          WHERE id=?`,
      )
      .run('The stream was canceled before any command was executed.', updatedAt, runId);
    database.prepare('DELETE FROM ai_approvals WHERE run_id=?').run(runId);
    database.prepare('DELETE FROM ai_tool_calls WHERE run_id=?').run(runId);
    database
      .prepare(
        `UPDATE ai_messages
            SET content=?, updated_at=?, version=version+1
          WHERE run_id=? AND role='user'`,
      )
      .run(
        'Explain the interrupted deployment output and suggest a safe next step.',
        updatedAt,
        runId,
      );
    database
      .prepare(
        `INSERT INTO ai_messages(
           id, conversation_id, run_id, role, content, attachments_json, state, error_code,
           created_at, updated_at, version
         ) VALUES (?, ?, ?, 'assistant', ?, '[]', 'canceled', 'REQUEST_CANCELED', ?, ?, 1)`,
      )
      .run(
        '82000000-0000-4000-8000-000000000006',
        conversationId,
        runId,
        'The stream was canceled before any command was executed.',
        updatedAt,
        updatedAt,
      );
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

async function prepareAxtermConnectionHistory(page, userData) {
  seedAxtermConnectionHistory(userData);
  await page.locator('[data-activity-item="bookmarks"]').click();
  const sidebar = page.locator('.workspace-sidebar');
  await sidebar.getByRole('tab', { name: '历史' }).click();
  await sidebar.locator('.connection-history-row').nth(2).waitFor();
}

async function prepareElectermConnectionHistory(page) {
  await page.evaluate(() => {
    const now = Date.now();
    const history = [
      {
        id: 'production-history',
        time: now - 2 * 60_000,
        count: 8,
        tab: {
          title: 'Production API',
          host: 'prod-api.example.test',
          username: 'ops',
          port: 22,
          type: 'ssh',
          color: '#22aa66',
        },
      },
      {
        id: 'staging-history',
        time: now - 18 * 60_000,
        count: 3,
        tab: {
          title: 'Staging Worker',
          host: 'staging-worker.example.test',
          username: 'deploy',
          port: 22,
          type: 'ssh',
        },
      },
      {
        id: 'archive-history',
        time: now - 2 * 60 * 60_000,
        count: 1,
        tab: {
          title: 'Archive Mirror',
          host: 'archive.example.test',
          username: 'backup',
          port: 22,
          type: 'ssh',
          color: '#aa66cc',
        },
      },
    ];
    globalThis.store.storeAssign({ history, sidebarPanelTab: 'history', pinned: true });
    globalThis.store.setOpenedSideBar('bookmarks');
  });
  await page.locator('.sidebar-panel-history .item-list-unit').nth(2).waitFor();
  await settleTargetLayout(page);
}

function seedAxtermCommandHistory(userData) {
  const database = new DatabaseSync(resolve(userData, 'data', 'axterm.sqlite'));
  database.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;');
  try {
    const insert = database.prepare(`
      INSERT INTO command_history(
        id, command_text, use_count, last_used_at, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
    `);
    const now = Date.now();
    const rows = [
      {
        id: '00000000-0000-4000-8000-000000000051',
        command: 'git status',
        count: 8,
        age: 24 * 60_000,
      },
      {
        id: '00000000-0000-4000-8000-000000000052',
        command: 'bun run check',
        count: 3,
        age: 8 * 60_000,
      },
      {
        id: '00000000-0000-4000-8000-000000000053',
        command: 'ssh ops@prod-api.example.test',
        count: 1,
        age: 2 * 60_000,
      },
    ];
    for (const row of rows) {
      const lastUsedAt = new Date(now - row.age).toISOString();
      const createdAt = new Date(now - row.age - 86_400_000).toISOString();
      insert.run(row.id, row.command, row.count, lastUsedAt, createdAt, lastUsedAt);
    }
    database.exec(`
      UPDATE app_settings
      SET payload=json_set(payload, '$.commandHistoryEnabled', json('true')),
          version=version+1,
          updated_at=CURRENT_TIMESTAMP
      WHERE section='privacy';
      UPDATE app_meta SET value=CAST(CAST(value AS INTEGER) + 1 AS TEXT)
      WHERE key='command-history:revision';
      COMMIT;
    `);
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

async function prepareAxtermCommandHistory(page, userData) {
  seedAxtermCommandHistory(userData);
  await page.reload();
  await page.locator('[data-testid="runtime-state"][data-state="ready"]').waitFor();
  await page.locator('.terminal-host[data-connection-state="connected"]').waitFor();
}

async function prepareElectermCommandHistory(page) {
  await page.evaluate(() => {
    const now = Date.now();
    globalThis.store.storeAssign({
      terminalCommandHistory: [
        {
          id: 'command-git-status',
          cmd: 'git status',
          count: 8,
          lastUseTime: new Date(now - 24 * 60_000).toISOString(),
        },
        {
          id: 'command-bun-check',
          cmd: 'bun run check',
          count: 3,
          lastUseTime: new Date(now - 8 * 60_000).toISOString(),
        },
        {
          id: 'command-ssh-production',
          cmd: 'ssh ops@prod-api.example.test',
          count: 1,
          lastUseTime: new Date(now - 2 * 60_000).toISOString(),
        },
      ],
    });
  });
  await settleTargetLayout(page);
}

function seedAxtermConnectionProfiles(userData) {
  const database = new DatabaseSync(resolve(userData, 'data', 'axterm.sqlite'));
  database.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;');
  try {
    const now = new Date().toISOString();
    database
      .prepare(
        `
        INSERT INTO connection_profiles(id, name, payload, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, 1)
      `,
      )
      .run(
        '00000000-0000-4000-8000-000000000061',
        'Production Identity',
        JSON.stringify({
          isDefault: true,
          ssh: {
            username: 'deploy',
            passwordCredentialRef: null,
            privateKeyCredentialRef: null,
            passphraseCredentialRef: null,
            certificateCredentialRef: null,
          },
          telnet: { username: null, passwordCredentialRef: null },
          vnc: { username: null, passwordCredentialRef: null },
          rdp: { username: null, passwordCredentialRef: null },
          ftp: { username: null, passwordCredentialRef: null },
        }),
        now,
        now,
      );
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

async function prepareAxtermConnectionProfiles(page, userData) {
  seedAxtermConnectionProfiles(userData);
  await page.locator('[data-activity-item="setting"]').click();
  await page.getByRole('tab', { name: /Profiles|配置文件/u }).click();
  const panel = page.locator('.connection-profile-panel');
  await panel.waitFor();
  await panel.getByText('Production Identity', { exact: true }).click();
  await panel.getByRole('tab', { name: 'SSH' }).waitFor();
  await settleTargetLayout(page);
}

async function prepareAxtermSshConfigImport(page, userData, session) {
  if (!session.app) throw new Error('Axterm SSH Config capture requires Electron control');
  const fixtureDirectory = resolve(userData, 'parity-fixtures');
  const configPath = resolve(fixtureDirectory, 'config');
  await mkdir(fixtureDirectory, { recursive: true });
  await writeFile(
    configPath,
    [
      'Host production-api',
      '  HostName prod-api.example.test',
      '  User deploy',
      '  Port 22',
      '  Compression yes',
      '  ServerAliveInterval 30',
      '',
    ].join('\n'),
  );
  await session.app.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [selectedPath] });
  }, configPath);
  const hostsButton = page.locator('[data-activity-item="bookmarks"]');
  await hostsButton.click();
  const sidebar = page.locator('.workspace-sidebar');
  if (!(await sidebar.isVisible())) await hostsButton.click();
  await sidebar.getByRole('button', { name: '书签排序' }).click();
  await sidebar.getByRole('menuitem', { name: /导入 SSH Config/ }).click();
  const dialog = page.getByRole('dialog', { name: 'SSH Config 导入' });
  await dialog.waitFor();
  await dialog.locator('.ssh-config-item-content').filter({ hasText: 'production-api' }).waitFor();
  await hostsButton.evaluate((button) => button.click());
  await sidebar.waitFor({ state: 'hidden' });
  await settleTargetLayout(page);
}

async function prepareElectermConnectionProfiles(page) {
  await page.evaluate(() => {
    const profile = {
      id: 'PROFILE0',
      name: 'Production Identity',
      isDefault: true,
      username: 'deploy',
      password: '',
      privateKey: '',
      passphrase: '',
    };
    globalThis.store.storeAssign({
      profiles: [profile],
      settingTab: 'profiles',
      settingItem: profile,
      showModal: 1,
      innerWidth: globalThis.innerWidth,
    });
    globalThis.store.setSettingItem(profile);
  });
  await page.locator('.setting-tabs-profile .setting-row-left').waitFor();
  await page
    .locator('.setting-tabs-profile .item-list-unit')
    .getByText('Production Identity', { exact: true })
    .waitFor();
  await settleTargetLayout(page);
}

async function prepareElectermSshConfigImport(page) {
  await page.evaluate(() => {
    globalThis.localStorage.setItem('ssh-config-loaded', 'yes');
    globalThis.store.storeAssign({
      sshConfigs: [
        {
          title: 'production-api',
          host: 'prod-api.example.test',
          port: 22,
          username: 'deploy',
          term: 'xterm-256color',
          compression: true,
          serverAliveInterval: 30,
        },
      ],
      showSshConfigModal: true,
    });
  });
  await page.locator('.ssh-config-item').waitFor();
  await page
    .locator('.ssh-config-item-content')
    .getByText(/production-api/)
    .waitFor();
  await settleTargetLayout(page);
}

async function prepareAxtermSshNetwork(page, userData) {
  seedAxtermBookmarkTree(userData);
  await page.reload();
  await page.locator('[data-testid="runtime-state"][data-state="ready"]').waitFor();
  await page.locator('.terminal-host[data-connection-state="connected"]').waitFor();
  const hostsButton = page.locator('[data-activity-item="bookmarks"]');
  await hostsButton.click();
  const sidebar = page.locator('.workspace-sidebar');
  if (!(await sidebar.isVisible())) await hostsButton.click();
  await sidebar.getByRole('button', { name: '管理' }).click();
  await page.getByRole('button', { name: '添加主机' }).click();
  const form = page.getByRole('dialog', { name: '添加 SSH 主机' });
  await form.waitFor();
  await form.locator('#ssh-bookmark-tab-settings').click();
  await form.locator('.host-protocol-form[data-active-tab="settings"]').waitFor();
  await form.locator('.host-protocol-form').evaluate((element) => {
    element.scrollTop = 0;
  });
  await settleTargetLayout(page);
}

async function prepareElectermSshNetwork(page) {
  await waitForElectermTerminals(page);
  await page.evaluate(() => {
    globalThis.et.openBookmarkWithAIMode = false;
    globalThis.store.setItems('bookmarks', []);
    globalThis.store.setItems('bookmarkGroups', [
      {
        id: 'default',
        title: 'default',
        bookmarkIds: [],
        bookmarkGroupIds: [],
        color: '#0088cc',
      },
    ]);
    globalThis.store.bookmarksMap = new Map();
    globalThis.store.expandedKeys = ['default'];
    globalThis.store.profiles = [];
    globalThis.store.onNewSsh();
  });
  const form = page.locator('.setting-tabs-bookmarks .form-wrap');
  await form.waitFor();
  await page.addStyleTag({
    content: '.ant-notification,.notification-container{display:none!important}',
  });
  await form
    .locator('.ant-tabs-tab')
    .filter({ hasText: /^Settings$/iu })
    .click();
  await form
    .locator('.ant-tabs-tab-active')
    .filter({ hasText: /^Settings$/iu })
    .waitFor();
  await form.evaluate((element) => {
    element.scrollTop = 0;
  });
  await settleTargetLayout(page);
}

async function prepareAxtermSshAuthentication(page, userData) {
  await prepareAxtermSshNetwork(page, userData);
  const form = page.getByRole('dialog', { name: '添加 SSH 主机' });
  await form.locator('#ssh-bookmark-tab-auth').click();
  await form.getByRole('button', { name: 'PrivateKey/Certificate', exact: true }).click();
  const privateKey = form.getByLabel('私钥', { exact: true });
  await privateKey.waitFor({ state: 'visible' });
  await privateKey.focus();
  await settleTargetLayout(page);
}

async function prepareElectermSshAuthentication(page) {
  await prepareElectermSshNetwork(page);
  const form = page.locator('.setting-tabs-bookmarks .form-wrap');
  await form
    .locator('.ant-tabs-tab')
    .filter({ hasText: /^Auth$/iu })
    .click();
  await form
    .locator('.ant-radio-button-wrapper')
    .filter({ hasText: /^PrivateKey\/Certificate$/iu })
    .click();
  const privateKey = form.locator('textarea:visible').first();
  await privateKey.waitFor({ state: 'visible' });
  await privateKey.focus();
  await settleTargetLayout(page);
}

async function prepareAxtermSshTunnels(page, userData) {
  await prepareAxtermBookmarkTree(page, userData);
  const row = page.locator('[data-bookmark-title="Production API"]');
  await row.hover();
  await row.locator('.bookmark-row-actions button').last().click();
  await page.getByRole('menuitem', { name: '编辑' }).click();
  const form = page.getByRole('dialog', { name: '编辑 SSH 主机' });
  await form.waitFor();
  await form.locator('#ssh-bookmark-tab-tunnels').click();
  await form.locator('.host-protocol-form[data-active-tab="tunnels"]').waitFor();
  await form.locator('.host-protocol-form').evaluate((element) => {
    element.scrollTop = 0;
  });
  await settleTargetLayout(page);
}

async function prepareElectermSshTunnels(page) {
  await prepareElectermBookmarkTree(page);
  await page.evaluate(() => {
    const item = JSON.parse(JSON.stringify(globalThis.store.bookmarks[0]));
    globalThis.store.openBookmarkEdit(item);
  });
  const form = page.locator('.setting-tabs-bookmarks .form-wrap');
  await form.waitFor();
  await page.addStyleTag({
    content: '.ant-notification,.notification-container{display:none!important}',
  });
  await form
    .locator('.ant-tabs-tab')
    .filter({ hasText: /^Ssh tunnel$/iu })
    .click();
  await form
    .locator('.ant-tabs-tab-active')
    .filter({ hasText: /^Ssh tunnel$/iu })
    .waitFor();
  await form.evaluate((element) => {
    element.scrollTop = 0;
  });
  await settleTargetLayout(page);
}

async function prepareAxtermLocalization(page, language) {
  const settingsButton = page.locator('[data-activity-item="setting"]');
  await settingsButton.click();
  await page.locator('[data-settings-category="common"]').click();
  const languageSelect = page.getByTestId('application-language');
  await languageSelect.selectOption(language);
  const direction = language === 'ar' ? 'rtl' : 'ltr';
  await page.waitForFunction(
    ({ expectedLanguage, expectedDirection }) =>
      globalThis.document.documentElement.lang === expectedLanguage &&
      globalThis.document.documentElement.dir === expectedDirection,
    { expectedLanguage: language, expectedDirection: direction },
  );
  await page.locator('.settings-category-layout').getAttribute('class', { timeout: 10_000 });
  await languageSelect.waitFor({ state: 'visible' });
  await languageSelect.evaluate((element) =>
    element.closest('.language-settings-panel')?.scrollIntoView({ block: 'center' }),
  );
  await settleTargetLayout(page);
}

async function prepareElectermLocalization(page, language) {
  const upstreamLanguage = language === 'ar' ? 'ar_ar' : 'en_us';
  await waitForElectermTerminals(page);
  await page.evaluate((nextLanguage) => {
    globalThis.store.updateConfig({ language: nextLanguage });
    globalThis.store.openSetting();
  }, upstreamLanguage);
  await page.locator('.setting-tabs-setting .form-wrap').waitFor({ state: 'visible' });
  await page.waitForFunction(
    (expectedLanguage) => globalThis.store?.config?.language === expectedLanguage,
    upstreamLanguage,
  );
  const selectedLanguageName = language === 'ar' ? 'العربية' : 'English';
  const languageSelect = page
    .locator('.setting-tabs-setting .ant-select')
    .filter({ hasText: selectedLanguageName })
    .last();
  await languageSelect.waitFor({ state: 'visible' });
  await languageSelect.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await settleTargetLayout(page);
}

async function prepareAxtermSettingsNavigation(page) {
  await prepareAxtermLocalization(page, 'en');
  const categories = page.getByRole('complementary', { name: 'Settings items' });
  await categories.locator('[data-settings-category="terminal"]').click();
  await page.locator('.terminal-profile-settings').waitFor({ state: 'visible' });
  await categories.getByLabel('Search settings').focus();
  await settleTargetLayout(page);
}

async function prepareElectermSettingsNavigation(page) {
  await waitForElectermTerminals(page);
  await page.evaluate(() => {
    globalThis.store.updateConfig({ language: 'en_us' });
    globalThis.store.storeAssign({ settingTab: 'setting' });
    globalThis.store.setSettingItem({
      id: 'setting-terminal',
      title: globalThis.translate('terminal'),
    });
    globalThis.store.openSettingModal();
  });
  await page.waitForFunction(() => globalThis.store?.config?.language === 'en_us');
  const form = page.locator('.setting-tabs-setting .form-wrap');
  await form.waitFor({ state: 'visible' });
  const search = page.locator('.setting-tabs-setting .item-list-wrap input').first();
  if (await search.isVisible()) await search.focus();
  await settleTargetLayout(page);
}

async function prepareAxtermQuickCommands(page) {
  await prepareAxtermLocalization(page, 'en');
  await page
    .locator('.app-sidebar nav')
    .getByRole('button', { name: /^(Quick commands|快捷命令)/u })
    .click();
  await page
    .locator('.workspace-sidebar')
    .getByRole('button', { name: /^(Open workspace|打开工作区)$/u })
    .click();
  const workspace = page.getByTestId('quick-command-workspace');
  await workspace.waitFor();
  await workspace
    .locator('.quick-command-toolbar')
    .getByRole('button', { name: /^(New quick command|新建快捷命令)$/u })
    .click();
  const form = workspace.locator('.quick-command-form');
  await form.getByLabel(/^(Name|名称)$/u).fill('Deploy status');
  await form.getByLabel(/^(Step 1 name|步骤 1 名称)$/u).fill('Context');
  await form.getByLabel(/^(Step 1 command|步骤 1 命令)$/u).fill('kubectl config current-context');
  await form.getByLabel(/^(Step 1 command|步骤 1 命令)$/u).focus();
  await settleTargetLayout(page);
}

async function prepareElectermQuickCommands(page) {
  await waitForElectermTerminals(page);
  await page.evaluate(() => {
    globalThis.store.updateConfig({ language: 'en_us' });
    globalThis.store.handleOpenQuickCommandsSetting();
  });
  const form = page.locator('.setting-tabs-quick-commands .form-wrap');
  await form.waitFor({ state: 'visible' });
  await form.locator('input').first().fill('Deploy status');
  const command = form.locator('textarea').first();
  if (await command.isVisible()) {
    await command.fill('kubectl config current-context');
    await command.focus();
  }
  await settleTargetLayout(page);
}

async function prepareAxtermTriggers(page) {
  await prepareAxtermLocalization(page, 'en');
  await page
    .locator('.app-sidebar nav')
    .getByRole('button', { name: /^(Quick commands|快捷命令)/u })
    .click();
  await page
    .locator('.workspace-sidebar')
    .getByRole('button', { name: /^(Open workspace|打开工作区)$/u })
    .click();
  await page.getByRole('button', { name: /Triggers|触发器/u }).click();
  const workspace = page.getByTestId('trigger-workspace');
  await workspace.waitFor();
  await workspace.getByRole('button', { name: /^(New|新建)$/u }).click();
  await workspace.getByLabel(/^(Trigger name|触发器名称)$/u).fill('Pager response');
  await workspace.getByLabel(/^(Match value|匹配内容)$/u).fill('--More--');
  await workspace.getByLabel(/^(Text to send|发送内容)$/u).fill(' ');
  await workspace.getByLabel(/^(Match value|匹配内容)$/u).focus();
  await settleTargetLayout(page);
}

async function prepareElectermTriggers(page) {
  await waitForElectermTerminals(page);
  await page.evaluate(() => {
    globalThis.store.updateConfig({ language: 'en_us' });
    globalThis.store.openTriggers();
  });
  const form = page.locator('.setting-tabs-triggers form').first();
  await form.waitFor({ state: 'visible' });
  await form.locator('#name').fill('Pager response');
  await form.locator('#matchValue').fill('--More--');
  const action = form.locator('#actionValue');
  if (await action.isVisible()) await action.fill(' ');
  await form.locator('#matchValue').focus();
  await settleTargetLayout(page);
}

async function prepareAxtermTerminalInformation(page) {
  await prepareAxtermLocalization(page, 'en');
  // The settings surface deliberately keeps terminal tabs mounted but hidden.
  // Activate the existing tab through its real click handler so this capture
  // records the terminal plus information drawer, matching Electerm's state.
  await page
    .locator('.terminal-tab')
    .first()
    .evaluate((element) => element.click());
  await waitForAxtermTerminals(page);
  await page.locator('.status-information').click();
  await page.getByRole('complementary', { name: /Terminal information|终端信息/u }).waitFor();
  await settleTargetLayout(page);
}

async function prepareElectermTerminalInformation(page) {
  await waitForElectermTerminals(page);
  await page.evaluate(() => {
    globalThis.store.updateConfig({ language: 'en_us' });
    globalThis.store.openInfoPanel();
  });
  await page.locator('.right-side-panel .terminal-info-section').first().waitFor({
    state: 'visible',
    timeout: 30_000,
  });
  await settleTargetLayout(page);
}

async function prepareAxtermWidgets(page, widgetName = /Static File Server|静态文件服务器/u) {
  await prepareAxtermLocalization(page, 'en');
  await page.locator('[data-activity-item="widgets"]').click();
  const workspace = page.locator('.widget-workspace');
  await workspace.waitFor();
  await workspace.getByRole('option', { name: widgetName }).click();
  await workspace.locator('.widget-form').waitFor();
  await settleTargetLayout(page);
}

async function prepareElectermWidgets(page, widgetName = 'Static File Server') {
  await waitForElectermTerminals(page);
  await page.evaluate(() => {
    globalThis.store.updateConfig({ language: 'en_us' });
    globalThis.store.openWidgetsModal();
  });
  const panel = page.locator('.setting-tabs-profile').last();
  await panel.waitFor({ state: 'attached' });
  const widget = panel
    .locator('.item-type-widgets .item-list-unit')
    .filter({ hasText: widgetName })
    .first();
  await widget.waitFor({ state: 'visible', timeout: 30_000 });
  await widget.click();
  await settleTargetLayout(page);
}

async function prepareAxtermDataSync(page) {
  await prepareAxtermLocalization(page, 'en');
  const categories = page.getByRole('complementary', { name: 'Settings items' });
  await categories.locator('[data-settings-category="sync"]').click();
  const panel = page.locator('.data-sync-panel');
  await panel.waitFor({ state: 'visible' });
  await panel.getByRole('tab', { name: 'WebDAV' }).click();
  await panel.getByLabel('Service URL').fill('https://dav.example.test/storage');
  await panel.getByLabel('Remote file name').fill('axterm-desktop.json');
  await panel.getByLabel('Username').fill('operator');
  await panel.getByLabel('Service URL').focus();
  await settleTargetLayout(page);
}

async function prepareElectermDataSync(page) {
  await waitForElectermTerminals(page);
  await page.evaluate(() => {
    globalThis.store.updateConfig({ language: 'en_us' });
    globalThis.store.openSettingSync();
  });
  const workspace = page.locator('.setting-tabs-setting').last();
  await workspace.waitFor({ state: 'attached' });
  await workspace
    .locator('.ant-tabs-tab')
    .filter({ hasText: /^webdav$/iu })
    .click();
  const serverUrl = page.locator('#sync-input-webdav-server-url');
  await serverUrl.waitFor({ state: 'visible' });
  await serverUrl.fill('https://dav.example.test/storage');
  await page.locator('#sync-input-webdav-username').fill('operator');
  await serverUrl.focus();
  await settleTargetLayout(page);
}

async function prepareAxtermAiConfiguration(page) {
  await prepareAxtermLocalization(page, 'en');
  await page.getByRole('button', { name: 'AI Inspector' }).click();
  const form = page.locator('.ai-provider-form');
  await form.waitFor({ state: 'visible' });
  await form.locator('input[name="model"]').fill('gpt-4.1-mini');
  await form.locator('input[name="baseUrl"]').focus();
  await settleTargetLayout(page);
}

async function prepareElectermAiConfiguration(page) {
  await waitForElectermTerminals(page);
  await page.evaluate(() => {
    globalThis.store.updateConfig({ language: 'en_us' });
    globalThis.store.showAIConfigModal = true;
  });
  const modal = page.locator('.ai-config-modal');
  await modal.waitFor({ state: 'visible', timeout: 30_000 });
  const model = modal.locator('input').nth(3);
  if (await model.isVisible()) await model.focus();
  await settleTargetLayout(page);
}

async function prepareAxtermAiChat(page) {
  await prepareAxtermLocalization(page, 'en');
  await page.getByRole('button', { name: 'AI Inspector' }).click();
  const dialog = page.getByRole('dialog', { name: 'AI Config' });
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  const workspace = page.locator('.ai-chat-workspace');
  await workspace.waitFor({ state: 'visible' });
  const prompt = workspace.locator('textarea[name="prompt"]');
  await prompt.fill('Explain the selected terminal output and suggest a safe next step.');
  await prompt.focus();
  await settleTargetLayout(page);
}

async function prepareElectermAiChat(page) {
  await waitForElectermTerminals(page);
  await page.evaluate(() => {
    globalThis.store.updateConfig({
      language: 'en_us',
      nameAI: 'OpenAI Compatible',
      baseURLAI: 'https://api.openai.com/v1',
      apiPathAI: '/chat/completions',
      modelAI: 'gpt-4.1-mini',
      roleAI: 'Terminal expert. Explain commands and effects clearly.',
      authHeaderNameAI: 'Authorization: Bearer',
      languageAI: 'English',
    });
    globalThis.store.handleOpenAIPanel();
    globalThis.store.startNewChat();
  });
  const panel = page.locator('.right-side-panel .ai-chat-container');
  await panel.waitFor({ state: 'visible', timeout: 30_000 });
  const prompt = panel.locator('.ai-chat-textarea');
  await prompt.fill('Explain the selected terminal output and suggest a safe next step.');
  await prompt.focus();
  await settleTargetLayout(page);
}

async function prepareAxtermCanceledAiChat(page, userData) {
  seedAxtermCanceledAiChat(userData);
  const access = await refreshAxtermRuntimeAccess(page);
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 60_000 });
  const response = await globalThis.fetch(new URL('/api/v1/ai/conversations', access.baseUrl), {
    headers: {
      Authorization: `Bearer ${access.sessionToken}`,
      'X-Runtime-Generation': access.generation,
    },
  });
  const body = await response.text();
  if (!response.ok || !body.includes('Explain interrupted deployment output'))
    throw new Error(
      `Canceled AI fixture was not visible through Runtime: ${response.status} ${body}`,
    );
  await prepareAxtermLocalization(page, 'en');
  await page.getByRole('button', { name: 'AI Inspector' }).click();
  const dialog = page.getByRole('dialog', { name: 'AI Config' });
  try {
    await dialog.waitFor({ state: 'visible', timeout: 2_000 });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  } catch {
    // The seeded Provider normally prevents first-use configuration.
  }
  const workspace = page.locator('.ai-chat-workspace');
  await workspace.waitFor({ state: 'visible' });
  try {
    await workspace
      .getByText('The stream was canceled before any command was executed.', { exact: true })
      .waitFor({ timeout: 10_000 });
  } catch (error) {
    throw new Error(
      `Canceled AI chat did not render: ${(await workspace.innerText()).slice(0, 2_000)}`,
      {
        cause: error,
      },
    );
  }
  await workspace.getByText('REQUEST_CANCELED', { exact: true }).waitFor();
  await workspace.locator('.ai-chat-messages').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await settleTargetLayout(page);
}

async function prepareElectermCanceledAiChat(page) {
  await waitForElectermTerminals(page);
  await page.evaluate(() => {
    const sessionId = 'parity-canceled-chat';
    globalThis.store.updateConfig({
      language: 'en_us',
      nameAI: 'OpenAI Compatible',
      baseURLAI: 'https://api.openai.com/v1',
      apiPathAI: '/chat/completions',
      modelAI: 'gpt-4.1-mini',
      roleAI: 'Terminal expert. Explain commands and effects clearly.',
      authHeaderNameAI: 'Authorization: Bearer',
      languageAI: 'English',
    });
    globalThis.store.currentChatSessionId = sessionId;
    globalThis.store.showChatSessions = false;
    globalThis.store.aiChatHistory = [
      {
        id: 'parity-canceled-chat-entry',
        prompt: 'Explain the interrupted deployment output and suggest a safe next step.',
        promptWithAttachments:
          'Explain the interrupted deployment output and suggest a safe next step.',
        response: 'The stream was canceled before any command was executed.',
        isStreaming: false,
        pending: false,
        sessionId: null,
        chatSessionId: sessionId,
        mode: 'chat',
        nameAI: 'OpenAI Compatible',
        modelAI: 'gpt-4.1-mini',
        roleAI: 'Terminal expert. Explain commands and effects clearly.',
        baseURLAI: 'https://api.openai.com/v1',
        apiPathAI: '/chat/completions',
        apiKeyAI: '',
        proxyAI: '',
        languageAI: 'English',
        authHeaderNameAI: 'Authorization: Bearer',
        timestamp: Date.now(),
      },
    ];
    globalThis.store.handleOpenAIPanel();
  });
  const panel = page.locator('.right-side-panel .ai-chat-container');
  await panel.waitFor({ state: 'visible', timeout: 30_000 });
  await panel.getByText('The stream was canceled before any command was executed.').waitFor();
  await panel.locator('.ai-chat-history').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await settleTargetLayout(page);
}

async function prepareAxtermAiAgent(page, userData) {
  seedAxtermAiAgent(userData);
  await page.reload();
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 60_000 });
  await prepareAxtermLocalization(page, 'en');
  await page.getByRole('button', { name: 'AI Inspector' }).click();
  const dialog = page.getByRole('dialog', { name: 'AI Config' });
  try {
    await dialog.waitFor({ state: 'visible', timeout: 2_000 });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  } catch {
    // A warm provider query can avoid the first-use configuration modal.
  }
  const tools = page.locator('.agent-tool-list');
  await tools.waitFor({ state: 'visible', timeout: 30_000 });
  await tools.scrollIntoViewIfNeeded();
  const pending = tools.locator('.agent-tool-card.state-waiting_approval');
  await pending.waitFor({ state: 'visible' });
  const header = pending.locator('.agent-tool-card-header');
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  await settleTargetLayout(page);
}

async function prepareElectermAiAgent(page) {
  await waitForElectermTerminals(page);
  await page.evaluate(() => {
    const now = Date.now();
    const sessionId = 'parity-agent-session';
    globalThis.store.updateConfig({
      language: 'en_us',
      nameAI: 'OpenAI Compatible',
      baseURLAI: 'https://api.openai.com/v1',
      apiPathAI: '/chat/completions',
      modelAI: 'gpt-4.1-mini',
      roleAI: 'Terminal expert. Explain commands and effects clearly.',
      authHeaderNameAI: 'Authorization: Bearer',
      languageAI: 'English',
    });
    globalThis.store.currentChatSessionId = sessionId;
    globalThis.store.showChatSessions = false;
    globalThis.store.aiChatHistory = [
      {
        id: 'parity-agent-entry',
        prompt: 'Check deployment health and propose a safe diagnostic command.',
        promptWithAttachments: 'Check deployment health and propose a safe diagnostic command.',
        response: 'I inspected recent output and prepared the next diagnostic step.',
        isStreaming: false,
        pending: false,
        sessionId: null,
        chatSessionId: sessionId,
        mode: 'agent',
        toolCalls: [
          {
            id: 'parity-read-output',
            name: 'get_terminal_output',
            args: {},
            status: 'completed',
            result: JSON.stringify({ output: 'service status: degraded' }),
          },
          {
            id: 'parity-exec',
            name: 'send_terminal_command',
            args: { command: 'systemctl status api.service' },
            status: 'running',
            result: null,
          },
        ],
        nameAI: 'OpenAI Compatible',
        modelAI: 'gpt-4.1-mini',
        roleAI: 'Terminal expert. Explain commands and effects clearly.',
        baseURLAI: 'https://api.openai.com/v1',
        apiPathAI: '/chat/completions',
        apiKeyAI: '',
        proxyAI: '',
        languageAI: 'English',
        authHeaderNameAI: 'Authorization: Bearer',
        timestamp: now,
      },
    ];
    globalThis.store.handleOpenAIPanel();
  });
  const card = page.locator('.right-side-panel .agent-tool-call-card').last();
  await card.waitFor({ state: 'visible', timeout: 30_000 });
  await card.locator('.agent-tool-header').click();
  await card.scrollIntoViewIfNeeded();
  await settleTargetLayout(page);
}

async function startParityReconnectSshFixture() {
  const hostKey = paritySshUtils.generateKeyPairSync('ed25519').private;
  const parsedHostKey = paritySshUtils.parseKey(hostKey);
  if (parsedHostKey instanceof Error || Array.isArray(parsedHostKey))
    throw new Error('Parity reconnect fixture generated an invalid SSH host key');
  const publicKey = parsedHostKey.getPublicSSH();
  const fingerprint = `SHA256:${createHash('sha256')
    .update(publicKey)
    .digest('base64')
    .replace(/=+$/u, '')}`;
  const connections = new Set();
  const server = new ParitySshServer({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection);
    connection.once('close', () => connections.delete(connection));
    connection.on('authentication', (context) => {
      if (context.method === 'none') context.accept();
      else context.reject(['none']);
    });
    connection.on('ready', () => {
      connection.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptCommand) => {
          const stream = acceptCommand();
          stream.write('/bin/sh\n');
          stream.exit(0);
          stream.end();
        });
        session.on('pty', (acceptPty) => acceptPty?.());
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          stream.write('\r\nPARITY_REMOTE_SESSION_READY\r\n$ ');
          stream.on('data', (chunk) => stream.write(chunk));
        });
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Parity reconnect fixture did not bind');
  let stopPromise;
  return {
    port: address.port,
    algorithm: parsedHostKey.type,
    fingerprint,
    publicKey: publicKey.toString('base64'),
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = new Promise((resolveStop) => server.close(resolveStop));
      for (const connection of connections) connection.end();
      return stopPromise;
    },
  };
}

function seedAxtermReconnectSession(userData, fixture) {
  const database = new DatabaseSync(resolve(userData, 'data', 'axterm.sqlite'));
  database.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
  try {
    const now = new Date().toISOString();
    const id = '71000000-0000-4000-8000-000000000001';
    database
      .prepare(
        `INSERT INTO hosts(
          id, group_id, name, hostname, port, username, auth_type, credential_ref,
          passphrase_credential_ref, jump_host_id, favorite, reconnect_mode,
          reconnect_delay_ms, reconnect_max_attempts, ssh_agent, created_at, updated_at, version
        ) VALUES (?, NULL, ?, '127.0.0.1', ?, 'operator', 'agent', NULL, NULL, NULL, 0,
          'automatic', 60000, 3, ?, ?, ?, 1)`,
      )
      .run(
        id,
        'Resilient Remote Session',
        fixture.port,
        JSON.stringify({ enabled: false, path: null }),
        now,
        now,
      );
    database
      .prepare(
        `INSERT INTO known_host_keys(
          id, host, port, algorithm, fingerprint, public_key, first_seen_at,
          last_seen_at, created_at, updated_at, version
        ) VALUES (?, '127.0.0.1', ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        '71000000-0000-4000-8000-000000000002',
        fixture.port,
        fixture.algorithm,
        fixture.fingerprint,
        fixture.publicKey,
        now,
        now,
        now,
        now,
      );
    database
      .prepare(
        `INSERT INTO bookmarks(
          id, group_id, protocol, host_id, title, color, description, position,
          profile_id, connection_profile_id, created_at, updated_at, version
        ) VALUES (?, NULL, 'ssh', ?, ?, '#0088cc', ?, 0, NULL, NULL, ?, ?, 1)`,
      )
      .run(id, id, 'Resilient Remote Session', 'Network interruption evidence', now, now);
    database.exec(`
      UPDATE app_settings
      SET payload=json_set(payload, '$.language', 'en'), version=version+1,
          updated_at=CURRENT_TIMESTAMP
      WHERE section='appearance';
      UPDATE app_meta SET value=CAST(CAST(value AS INTEGER) + 1 AS TEXT)
      WHERE key='bookmark-tree:revision';
      COMMIT;
    `);
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

async function prepareAxtermResilience(page, userData) {
  const fixture = await startParityReconnectSshFixture();
  let stopping;
  try {
    seedAxtermReconnectSession(userData, fixture);
    await page.reload();
    await page.locator('[data-testid="runtime-state"][data-state="ready"]').waitFor();
    await page.locator('.terminal-host[data-connection-state="connected"]').first().waitFor();
    await page.locator('[data-activity-item="bookmarks"]').click();
    const sidebar = page.locator('.workspace-sidebar');
    if (!(await sidebar.isVisible()))
      await page.locator('[data-activity-item="bookmarks"]').click();
    await sidebar
      .locator('[data-bookmark-title="Resilient Remote Session"] .bookmark-row-main')
      .click();
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    await layer
      .locator('.terminal-host[data-connection-state="connected"]')
      .waitFor({ timeout: 30_000 });
    await layer.locator('.xterm-rows').getByText('PARITY_REMOTE_SESSION_READY').waitFor();
    await sidebar.getByRole('button', { name: /Collapse sidebar/iu }).click();
    await sidebar.waitFor({ state: 'hidden' });
    stopping = fixture.stop();
    const reconnect = layer.locator('.terminal-reconnect-overlay');
    await reconnect.waitFor({ state: 'visible', timeout: 15_000 });
    await reconnect.getByText(/Automatic reconnect: [1-9][0-9]?s/iu).waitFor();
    await stopping;
    await settleTargetLayout(page);
  } finally {
    await (stopping ?? fixture.stop()).catch(() => {});
  }
}

async function prepareElectermResilience(page) {
  const fixture = await startParityReconnectSshFixture();
  let stopping;
  try {
    await waitForElectermTerminals(page);
    await page.evaluate(() => {
      globalThis.store.updateConfig({ language: 'en_us', autoReconnectTerminal: true });
    });
    await page.locator('.btns .anticon-plus-circle').click();
    await page.locator('#ssh-form_host').fill('127.0.0.1');
    await page.locator('#ssh-form_username').fill('operator');
    await page.locator('#ssh-form_port').fill(String(fixture.port));
    await page.locator('.setting-wrap .ant-btn-primary:visible').first().click();
    const trust = page.locator('.custom-modal-wrap button:has-text("Trust and Save")').first();
    try {
      await trust.waitFor({ state: 'visible', timeout: 5_000 });
      await trust.click();
    } catch {
      // NODE_TEST may pre-approve the temporary fixture key.
    }
    await waitForElectermTerminals(page);
    await page
      .locator('.session-current .xterm-rows')
      .getByText('PARITY_REMOTE_SESSION_READY')
      .waitFor();
    stopping = fixture.stop();
    await page.waitForFunction(() => globalThis.store?.currentTab?.status !== 'success');
    await page.evaluate(() => {
      const terminal = globalThis.refs.get(`term-${globalThis.store.activeTabId}`);
      if (!terminal?.scheduleAutoReconnect)
        throw new Error('Electerm reconnect controller is unavailable');
      terminal.scheduleAutoReconnect(60_000);
    });
    await page.locator('.session-current .terminal-reconnect-overlay').waitFor();
    const notifications = page.locator('.ant-notification-notice');
    for (let index = (await notifications.count()) - 1; index >= 0; index -= 1) {
      const notification = notifications.nth(index);
      const close = notification.locator('.ant-notification-notice-close');
      if (await close.isVisible()) await close.click();
    }
    const messages = page.locator('.ant-message-notice');
    if (await messages.count())
      await messages
        .last()
        .waitFor({ state: 'hidden', timeout: 10_000 })
        .catch(() => {});
    await stopping;
    await settleTargetLayout(page);
  } finally {
    await (stopping ?? fixture.stop()).catch(() => {});
  }
}

async function prepareAxtermPlatformCertification(page) {
  await prepareAxtermLocalization(page, 'en');
  const diagnostics = page.locator('.diagnostic-grid');
  await diagnostics.waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Export diagnostics' }).focus();
  await settleTargetLayout(page);
}

async function prepareElectermPlatformCertification(page) {
  await prepareElectermLocalization(page, 'en');
  const form = page.locator('.setting-tabs-setting .form-wrap');
  await form.waitFor({ state: 'visible' });
  const language = form.locator('.ant-select').first();
  if (await language.isVisible()) await language.focus();
  await settleTargetLayout(page);
}

async function prepareAxtermAccessibilityCertification(page) {
  await prepareAxtermLocalization(page, 'en');
  const group = page.locator('.electerm-behavior-settings .monitor-settings-group').last();
  await group.scrollIntoViewIfNeeded();
  const toggle = group.locator('input[type="checkbox"]');
  await toggle.focus();
  await settleTargetLayout(page);
}

async function prepareElectermAccessibilityCertification(page) {
  await prepareElectermLocalization(page, 'en');
  const form = page.locator('.setting-tabs-setting .form-wrap');
  const label = form.getByText(/screen reader/iu).last();
  await label.scrollIntoViewIfNeeded();
  const switchControl = label.locator('xpath=ancestor::*[self::label or self::div][1]');
  if (await switchControl.isVisible()) await switchControl.focus();
  await settleTargetLayout(page);
}

async function prepareAxtermShortcutSettings(page) {
  await prepareAxtermLocalization(page, 'en');
  const categories = page.getByRole('complementary', { name: 'Settings items' });
  await categories.locator('[data-settings-category="shortcuts"]').click();
  const panel = page.locator('.shortcut-settings-panel');
  await panel.waitFor({ state: 'visible' });
  await panel.locator('[data-shortcut-action]').first().waitFor();
  await categories.getByLabel('Search settings').focus();
  await settleTargetLayout(page);
}

async function prepareElectermShortcutSettings(page) {
  await waitForElectermTerminals(page);
  await page.evaluate(() => {
    globalThis.store.updateConfig({ language: 'en_us' });
    globalThis.store.storeAssign({ settingTab: 'setting' });
    globalThis.store.setSettingItem({
      id: 'setting-shortcuts',
      title: globalThis.translate('settingShortcuts'),
    });
    globalThis.store.openSettingModal();
  });
  await page.waitForFunction(() => globalThis.store?.config?.language === 'en_us');
  await page.locator('.setting-tabs-setting .ant-table').waitFor({ state: 'visible' });
  const search = page.locator('.setting-tabs-setting .item-list-wrap input').first();
  if (await search.isVisible()) await search.focus();
  await settleTargetLayout(page);
}

async function prepareAxtermTerminalThemes(page) {
  await prepareAxtermLocalization(page, 'en');
  await page.getByRole('tab', { name: /UI Themes|UI主题/iu }).click();
  const workspace = page.locator('.terminal-theme-workspace');
  await workspace.waitFor({ state: 'visible' });
  await workspace.locator('.terminal-theme-list-item.new').click();
  await workspace.getByLabel(/Theme name|主题名称/iu).focus();
  await settleTargetLayout(page);
}

async function prepareElectermTerminalThemes(page) {
  await prepareElectermSettingsNavigation(page);
  await page
    .locator('.setting-tabs .ant-tabs-tab')
    .filter({ hasText: /UI Themes/iu })
    .click();
  const workspace = page.locator('.setting-tabs-terminal-themes');
  await workspace.locator('.setting-row-right').waitFor({ state: 'visible' });
  const name = workspace.locator('input').first();
  if (await name.isVisible()) await name.focus();
  await settleTargetLayout(page);
}

function requireSshFixturePort() {
  const port = Number(process.env.AXTERM_SSH_FIXTURE_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535)
    throw new Error(
      'Phase 16 parity captures require AXTERM_SSH_FIXTURE_PORT. Run scripts/parity/capture-phase16.sh.',
    );
  return port;
}

async function ensurePhase16LocalFixtures(userData, includeLargeFile = false) {
  const root = resolve(userData, 'parity-files');
  await mkdir(resolve(root, 'assets'), { recursive: true });
  await writeFile(
    resolve(root, 'README.md'),
    '# Axterm parity workspace\n\nDual-pane SFTP evidence.\n',
  );
  await writeFile(resolve(root, 'deploy.sh'), '#!/bin/sh\nprintf "deploy ready\\n"\n');
  await writeFile(resolve(root, 'release-notes.txt'), 'Phase 16\nfiles, transfers, editor\n');
  await writeFile(resolve(root, 'assets', 'manifest.json'), '{"ready":true}\n');
  const largeFile = resolve(root, 'parity-large.bin');
  if (includeLargeFile) {
    const handle = await open(largeFile, 'w');
    try {
      await handle.truncate(128 * 1024 * 1024);
    } finally {
      await handle.close();
    }
  }
  return { root, largeFile };
}

async function prepareAxtermLiveSftp(page, userData, session, includeLargeFile = false) {
  const port = requireSshFixturePort();
  const fixtures = await ensurePhase16LocalFixtures(userData, includeLargeFile);
  if (!session.app) throw new Error('Axterm Electron application handle is unavailable');
  await session.app.evaluate(({ dialog }, paths) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: async (...args) => {
        const options = args.find(
          (argument) => argument && typeof argument === 'object' && 'properties' in argument,
        );
        const directory = options?.properties?.includes('openDirectory');
        return { canceled: false, filePaths: [directory ? paths.root : paths.largeFile] };
      },
    });
  }, fixtures);

  await page.locator('[data-activity-item="bookmarks"]').click();
  const sidebar = page.locator('.workspace-sidebar');
  if (!(await sidebar.isVisible())) await page.locator('[data-activity-item="bookmarks"]').click();
  await sidebar.getByRole('button', { name: '管理' }).click();
  await page.getByRole('button', { name: '添加主机' }).click();
  const form = page.getByRole('dialog', { name: '添加 SSH 主机' });
  await form.getByLabel('显示名称').fill('Phase 16 SFTP');
  await form.getByLabel('主机地址').fill('127.0.0.1');
  await form.getByLabel('端口').fill(String(port));
  await form.getByLabel('用户名').fill('fixture');
  await form.getByLabel('认证方式').selectOption('password');
  await form.getByLabel('密码', { exact: true }).fill('axterm-fixture-password');
  await form.getByRole('button', { name: '保存并连接' }).click();
  const hostKeyDialog = page.getByRole('dialog', { name: /首次连接此主机/ });
  await hostKeyDialog.waitFor({ state: 'visible', timeout: 30_000 });
  await hostKeyDialog.getByLabel('保存并记住此主机密钥').check();
  await hostKeyDialog.getByRole('button', { name: '信任并连接', exact: true }).click();
  const terminalLayer = page.locator('.terminal-session-layer:not([hidden])');
  const terminal = terminalLayer.locator('.terminal-host');
  await terminal.waitFor({ state: 'visible' });
  await terminal.waitFor({ state: 'attached' });
  await page.waitForFunction(
    () =>
      globalThis.document
        .querySelector('.terminal-session-layer:not([hidden]) .terminal-host')
        ?.getAttribute('data-connection-state') === 'connected',
    null,
    { timeout: 60_000 },
  );
  const terminalInput = terminalLayer.locator('.xterm-helper-textarea');
  await terminalInput.pressSequentially(
    "mkdir -p /tmp/axterm-parity-files/assets && cd /tmp/axterm-parity-files && rm -f parity-large.bin && printf '# Remote parity notes\\nalpha beta alpha\\n' > parity-notes.txt && printf 'production=true\\nregion=west\\n' > deploy.env && touch audit.log release.tar.gz && printf '\\nPHASE16_REMOTE_READY\\n'",
  );
  await terminalInput.press('Enter');
  await page.waitForFunction(
    () =>
      globalThis.document
        .querySelector('.terminal-session-layer:not([hidden]) .xterm-rows')
        ?.textContent?.includes('PHASE16_REMOTE_READY'),
    null,
    { timeout: 30_000 },
  );

  await page.locator('.app-sidebar nav').getByRole('button', { name: /^文件/ }).click();
  await page
    .locator('.workspace-sidebar .explorer-hosts')
    .getByRole('button', { name: /Phase 16 SFTP/u })
    .click();
  const localPane = page.getByRole('region', { name: '本地文件' });
  const remotePane = page.getByRole('region', { name: '远端文件' });
  await localPane.getByRole('button', { name: '选择目录' }).click();
  await localPane.getByText('README.md', { exact: true }).waitFor();
  await remotePane.getByRole('button', { name: '当前终端目录' }).click();
  await remotePane.getByText('parity-notes.txt', { exact: true }).waitFor({ timeout: 30_000 });
  await sidebar.getByRole('button', { name: /收起侧栏|Collapse sidebar/iu }).click();
  return { ...fixtures, localPane, remotePane };
}

async function prepareElectermLiveSftp(page, userData, includeLargeFile = false) {
  const port = requireSshFixturePort();
  const fixtures = await ensurePhase16LocalFixtures(userData, includeLargeFile);
  await page.locator('.btns .anticon-plus-circle').click();
  await page.locator('#ssh-form_host').fill('127.0.0.1');
  await page.locator('#ssh-form_username').fill('fixture');
  await page.locator('#ssh-form_password').fill('axterm-fixture-password');
  await page.locator('#ssh-form_port').fill(String(port));
  await page.locator('.setting-wrap .ant-btn-primary:visible').first().click();
  const trust = page.locator('.custom-modal-wrap button:has-text("Trust and Save")').first();
  try {
    await trust.waitFor({ state: 'visible', timeout: 5_000 });
    await trust.click();
  } catch {
    // NODE_TEST can pre-approve fixture keys in some upstream builds.
  }
  await waitForElectermTerminals(page);
  const terminalInput = page.locator('.session-current .xterm-helper-textarea');
  await terminalInput.pressSequentially(
    "mkdir -p /tmp/axterm-parity-files/assets && cd /tmp/axterm-parity-files && rm -f parity-large.bin && printf '# Remote parity notes\\nalpha beta alpha\\n' > parity-notes.txt && printf 'production=true\\nregion=west\\n' > deploy.env && touch audit.log release.tar.gz && printf '\\nPHASE16_REMOTE_READY\\n'",
  );
  await terminalInput.press('Enter');
  await page.waitForFunction(
    () =>
      globalThis.document
        .querySelector('.session-current .xterm-rows')
        ?.textContent?.includes('PHASE16_REMOTE_READY'),
    null,
    { timeout: 30_000 },
  );
  await page.locator('.session-current .term-sftp-tabs .type-tab').nth(1).click();
  const localPath = page.locator('.session-current .sftp-local-section .sftp-title input');
  const remotePath = page.locator('.session-current .sftp-remote-section .sftp-title input');
  await remotePath.waitFor({ state: 'visible', timeout: 30_000 });
  await localPath.fill(fixtures.root);
  await localPath.press('Enter');
  await remotePath.fill('/tmp/axterm-parity-files');
  await remotePath.press('Enter');
  await page
    .locator('.session-current .file-list.local .sftp-item[title="README.md"]')
    .waitFor({ timeout: 30_000 });
  await page
    .locator('.session-current .file-list.remote .sftp-item[title="parity-notes.txt"]')
    .waitFor({ timeout: 30_000 });
  await settleTargetLayout(page);
  return fixtures;
}

const protocolCaptureConfig = {
  ftp: {
    dialog: '添加 FTP/FTPS 书签',
    title: 'Production FTP',
    field: 'hostname',
    value: 'ftp.example.test',
  },
  telnet: {
    dialog: '添加 Telnet 书签',
    title: 'Legacy Console',
    field: 'hostname',
    value: 'telnet.example.test',
  },
  serial: {
    dialog: '添加串口书签',
    title: 'Rack Console',
    field: 'path',
    value: '/dev/ttyUSB0',
  },
  rdp: {
    dialog: '添加 RDP 书签',
    title: 'Windows Desktop',
    field: 'hostname',
    value: 'desktop.example.test',
  },
  vnc: {
    dialog: '添加 VNC 书签',
    title: 'Linux Visual',
    field: 'hostname',
    value: 'vnc.example.test',
  },
  spice: {
    dialog: '添加 SPICE 书签',
    title: 'SPICE Console',
    field: 'hostname',
    value: 'spice.example.test',
  },
  web: {
    dialog: '添加 Web 书签',
    title: 'Operations Portal',
    field: 'url',
    value: 'https://console.example.test/dashboard',
  },
};

async function prepareAxtermProtocolBookmark(page, protocol) {
  const config = protocolCaptureConfig[protocol];
  if (!config) throw new Error(`Unsupported protocol capture: ${protocol}`);
  await page.locator('[data-activity-item="newBookmark"]').click();
  const shell = page.locator('.host-bookmark-modal');
  await shell.waitFor();
  await shell.locator(`[data-bookmark-protocol="${protocol}"]`).click();
  const dialog = page.getByRole('dialog', { name: config.dialog });
  await dialog.waitFor();
  await dialog.locator('input[name="name"]').fill(config.title);
  const target = dialog.locator(`input[name="${config.field}"]`);
  await target.fill(config.value);
  if (protocol === 'ftp')
    await dialog.locator('select[name="security"]').selectOption('explicit-tls');
  if (protocol === 'rdp') {
    await dialog.locator('input[name="domain"]').fill('OPERATIONS');
    await dialog.locator('input[name="desktopWidth"]').fill('1440');
    await dialog.locator('input[name="desktopHeight"]').fill('900');
  }
  if (protocol === 'vnc') {
    await dialog.locator('input[name="qualityLevel"]').fill('8');
    await dialog.locator('input[name="compressionLevel"]').fill('6');
  }
  await target.focus();
  await settleTargetLayout(page);
}

async function prepareElectermProtocolBookmark(page, protocol) {
  const config = protocolCaptureConfig[protocol];
  if (!config) throw new Error(`Unsupported protocol capture: ${protocol}`);
  await waitForElectermTerminals(page);
  await page.evaluate(() => {
    globalThis.et.openBookmarkWithAIMode = false;
    // Protocol references must start from Electerm's real empty bookmark tree.
    // Earlier SSH/SFTP fixture captures intentionally populate this process-wide
    // store, which otherwise leaks dozens of unrelated rows into these images.
    globalThis.store.setItems('bookmarks', []);
    globalThis.store.setItems('bookmarkGroups', [
      {
        id: 'default',
        title: 'default',
        bookmarkIds: [],
        bookmarkGroupIds: [],
        color: '#0088cc',
      },
    ]);
    globalThis.store.bookmarksMap = new Map();
    globalThis.store.expandedKeys = ['default'];
    globalThis.store.profiles = [];
    globalThis.store.onNewSsh();
  });
  const form = page.locator('.setting-tabs-bookmarks .form-wrap');
  await form.waitFor();
  await page.addStyleTag({
    content: '.ant-notification,.notification-container{display:none!important}',
  });
  await form
    .locator('.ant-radio-button-wrapper')
    .filter({ hasText: new RegExp(`^${protocol}$`, 'iu') })
    .click();
  const title = form.locator(`#${protocol}-form_title`);
  const targetField =
    protocol === 'serial' ? 'path' : config.field === 'hostname' ? 'host' : config.field;
  const target = form.locator(`#${protocol}-form_${targetField}`);
  await target.waitFor({ state: 'visible' });
  await title.fill(config.title);
  await target.fill(config.value);
  if (protocol === 'ftp') await form.locator('#ftp-form_secure').click();
  if (protocol === 'rdp') await form.locator('#rdp-form_domain').fill('OPERATIONS');
  if (protocol === 'vnc') {
    await form.locator('#vnc-form_qualityLevel').fill('8');
    await form.locator('#vnc-form_compressionLevel').fill('6');
  }
  await target.focus();
  await form.evaluate((element) => {
    element.scrollTop = 0;
  });
  await settleTargetLayout(page);
}

async function refreshAxtermRuntimeAccess(page) {
  let resolveAccess;
  let rejectAccess;
  const access = new Promise((resolveValue, rejectValue) => {
    resolveAccess = resolveValue;
    rejectAccess = rejectValue;
  });
  const timer = setTimeout(
    () => rejectAccess(new Error('Timed out while observing Runtime authentication')),
    10_000,
  );
  const observe = async (request) => {
    if (!request.url().includes('/api/v1/')) return;
    const headers = await request.allHeaders();
    const authorization = headers.authorization;
    const generation = headers['x-runtime-generation'];
    if (!authorization?.startsWith('Bearer ') || !generation) return;
    resolveAccess({
      baseUrl: new URL(request.url()).origin,
      sessionToken: authorization.slice('Bearer '.length),
      generation,
    });
  };
  page.on('request', observe);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    return await access;
  } finally {
    clearTimeout(timer);
    page.off('request', observe);
  }
}

async function prepareAxtermTerminalTransfer(page) {
  const access = await refreshAxtermRuntimeAccess(page);
  await page.locator('[data-testid="runtime-state"][data-state="ready"]').waitFor();
  await waitForAxtermTerminals(page);
  const terminalTestId = await page
    .locator('.terminal-surface.active .terminal-host')
    .getAttribute('data-testid');
  const terminalId = terminalTestId?.startsWith('terminal-')
    ? terminalTestId.slice('terminal-'.length)
    : undefined;
  if (!terminalId) throw new Error('Active terminal id is unavailable for transfer capture');

  // The local shell acts as the XMODEM peer: it emits the protocol's CRC
  // request only after the real import grant and transfer session are ready.
  await page.locator('.terminal-host').first().click();
  await page.keyboard.type("sleep 2; printf '\\103'");
  await page.keyboard.press('Enter');

  // Keep the generation token in the Node-side driver. It must not become an
  // evaluate argument or enter Renderer state / the recorded DOM snapshots.
  const headers = {
    Authorization: `Bearer ${access.sessionToken}`,
    'X-Runtime-Generation': access.generation,
  };
  const payload = Buffer.alloc(256 * 1024, 0x41);
  const grantResponse = await globalThis.fetch(
    new URL('/api/v1/file-grants/import', access.baseUrl),
    {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/octet-stream',
        'X-Axterm-File-Name': encodeURIComponent('parity-transfer.bin'),
        'X-Axterm-File-Size': String(payload.byteLength),
      },
      body: payload,
    },
  );
  if (!grantResponse.ok) throw new Error('Unable to create transfer file grant');
  const grant = await grantResponse.json();
  const startResponse = await globalThis.fetch(
    new URL(`/api/v1/terminals/${terminalId}/transfer/actions`, access.baseUrl),
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'start',
        protocol: 'xmodem',
        direction: 'upload',
        grantId: grant.grantId,
      }),
    },
  );
  if (!startResponse.ok) throw new Error('Unable to start XMODEM transfer capture');

  await page.locator('.terminal-transfer-indicator').waitFor({ timeout: 10_000 });
  await page
    .locator('.terminal-surface[data-terminal-transfer="transferring"]')
    .waitFor({ timeout: 8_000 });
  await settleTargetLayout(page);
}

async function prepareElectermTerminalTransfer(page, userData) {
  await waitForElectermTerminals(page);
  const source = resolve(userData, 'parity-transfer.bin');
  await writeFile(source, Buffer.alloc(256 * 1024, 0x41));
  await page.locator('.term-wrap').click();
  await page.keyboard.type("sleep 2; printf '\\103'");
  await page.keyboard.press('Enter');
  await page.evaluate(async (path) => {
    globalThis._apiControlSelectFile = [path];
    const terminal = globalThis.refs.get(`term-${globalThis.store.activeTabId}`);
    if (!terminal?.xmodemClient) throw new Error('Electerm XMODEM client is unavailable');
    await terminal.xmodemClient.initiateSend();
  }, source);
  await page.waitForFunction(() => {
    const terminal = globalThis.refs.get(`term-${globalThis.store.activeTabId}`);
    return !!terminal?.xmodemClient?.currentTransfer;
  });
  await settleTargetLayout(page);
}

async function prepareScenario(target, scenario, page, userData, session) {
  if (target === 'axterm') {
    await page.locator('[data-testid="runtime-state"][data-state="ready"]').waitFor();
    await page.locator('.terminal-host[data-connection-state="connected"]').waitFor();
    await settleTargetLayout(page);
    if (scenario.id === 'shell.chrome-empty') {
      const first = page.locator('.terminal-tab').first();
      await first.click({ button: 'right' });
      await page.locator('.tab-context-menu').getByRole('button', { name: '关闭全部标签' }).click();
      await page.locator('.terminal-tab').first().waitFor({ state: 'detached' });
      await page.locator('.no-session-view').waitFor();
      return;
    }
    if (scenario.id === 'shell.new-session-tabs') {
      for (let index = 0; index < 7; index++) {
        const count = await page.locator('.terminal-tab').count();
        await page
          .getByTitle(/新建本地终端|New local terminal/iu)
          .first()
          .click();
        await page.locator('.terminal-tab').nth(count).waitFor();
      }
      const first = page.locator('.terminal-tab').first();
      await first.click({ button: 'right' });
      await page.locator('.tab-context-menu').getByRole('button', { name: '固定标签' }).click();
      await waitForAxtermTerminals(page);
      return;
    }
    if (scenario.id === 'shell.layouts') {
      await page.getByTitle('布局与工作区').click();
      await page.getByTitle(/四宫格|网格 2x2|grid 2x2/iu).click();
      await page.locator('.terminal-pane').nth(3).waitFor();
      for (let index = 0; index < 3; index++) {
        const count = await page.locator('.terminal-tab').count();
        await page
          .getByTitle(/新建本地终端|New local terminal/iu)
          .first()
          .click();
        await page.locator('.terminal-tab').nth(count).waitFor();
      }
      await page.locator('.empty-pane-landing').nth(2).waitFor();
      await waitForAxtermTerminals(page);
      return;
    }
    if (scenario.id === 'shell.workspaces') {
      return;
    }
    if (
      scenario.id === 'bookmarks.tree' ||
      scenario.id === 'bookmarks.search' ||
      scenario.id === 'bookmarks.drag-target'
    ) {
      await prepareAxtermBookmarkTree(page, userData);
      if (scenario.id === 'bookmarks.search') {
        const search = page.getByLabel('搜索书签');
        await search.fill('prod');
        await page.locator('[data-bookmark-title="Archive Mirror"]').waitFor({ state: 'detached' });
        await search.press('ArrowDown');
        await page
          .locator('[data-bookmark-title="Production API"][aria-selected="true"]')
          .waitFor();
      }
      await waitForAxtermTerminals(page);
      return;
    }
    if (scenario.id === 'bookmarks.connection-history') {
      await prepareAxtermConnectionHistory(page, userData);
      await waitForAxtermTerminals(page);
      return;
    }
    if (scenario.id === 'bookmarks.command-history') {
      await prepareAxtermCommandHistory(page, userData);
      await waitForAxtermTerminals(page);
      return;
    }
    if (scenario.id === 'bookmarks.connection-profiles') {
      await prepareAxtermConnectionProfiles(page, userData);
      return;
    }
    if (scenario.id === 'bookmarks.history-profiles') {
      await prepareAxtermConnectionProfiles(page, userData);
      return;
    }
    if (scenario.id === 'bookmarks.ssh-config-import') {
      await prepareAxtermSshConfigImport(page, userData, session);
      return;
    }
    if (scenario.id === 'bookmarks.forms') {
      seedAxtermBookmarkTree(userData);
      await page.reload();
      await page.locator('[data-testid="runtime-state"][data-state="ready"]').waitFor();
      await page.locator('.terminal-host[data-connection-state="connected"]').waitFor();
      const hostsButton = page.locator('[data-activity-item="bookmarks"]');
      await hostsButton.click();
      const sidebar = page.locator('.workspace-sidebar');
      if (!(await sidebar.isVisible())) await hostsButton.click();
      await sidebar.getByRole('button', { name: '管理' }).click();
      await page.getByRole('button', { name: '添加主机' }).click();
      const form = page.getByRole('dialog', { name: '添加 SSH 主机' });
      await form.waitFor();
      await form.getByLabel('主机地址').focus();
      await settleTargetLayout(page);
      return;
    }
    if (scenario.id === 'ssh.network') {
      await prepareAxtermSshNetwork(page, userData);
      return;
    }
    if (scenario.id === 'ssh.authentication') {
      await prepareAxtermSshAuthentication(page, userData);
      return;
    }
    if (scenario.id === 'ssh.tunnels-sftp') {
      await prepareAxtermSshTunnels(page, userData);
      return;
    }
    if (scenario.id === 'files.browse-operate') {
      const { remotePane } = await prepareAxtermLiveSftp(page, userData, session);
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
      const first = remotePane.getByRole('button', { name: 'audit.log', exact: true });
      const second = remotePane.getByRole('button', { name: 'deploy.env', exact: true });
      await first.click();
      await second.click({ modifiers: [modifier] });
      await settleTargetLayout(page);
      return;
    }
    if (scenario.id === 'files.transfers') {
      await prepareAxtermLiveSftp(page, userData, session, true);
      await page.getByRole('button', { name: '上传文件', exact: true }).click();
      const transferButton = page.locator('.status-transfer');
      await page.waitForFunction(
        () =>
          !globalThis.document.querySelector('.status-transfer')?.textContent?.trim().endsWith('0'),
        null,
        { timeout: 30_000 },
      );
      await transferButton.click();
      const center = page.getByRole('complementary', { name: '传输中心' });
      await center.waitFor();
      const pause = center.getByTitle('暂停').first();
      try {
        await pause.waitFor({ state: 'visible', timeout: 2_000 });
        await pause.click();
      } catch {
        // A localhost transfer can finish before the pause control is painted;
        // the completed task and history remain valid product evidence.
      }
      await settleTargetLayout(page);
      return;
    }
    if (scenario.id === 'files.edit-inspect') {
      const { remotePane } = await prepareAxtermLiveSftp(page, userData, session);
      await remotePane.getByRole('button', { name: 'parity-notes.txt', exact: true }).dblclick();
      const editor = page.getByRole('dialog', { name: '远程文本编辑器' });
      await editor.waitFor();
      await editor.getByLabel('在文本中查找').fill('alpha');
      await editor.getByLabel('在文本中查找').press('Enter');
      await settleTargetLayout(page);
      return;
    }
    if (scenario.id.startsWith('protocol.')) {
      const protocol = scenario.id === 'protocol.web-deeplink' ? 'web' : scenario.id.slice(9);
      await prepareAxtermProtocolBookmark(page, protocol);
      return;
    }
    if (scenario.id === 'terminal.transfer-protocols') {
      await prepareAxtermTerminalTransfer(page);
      return;
    }
    if (scenario.id === 'terminal.basic' || scenario.id === 'terminal.productivity') {
      await waitForAxtermTerminals(page);
      return;
    }
    if (scenario.id === 'terminal.addons-settings') {
      const settingsButton = page.locator('[data-activity-item="setting"]');
      await settingsButton.click();
      await page.locator('[data-settings-category="terminal"]').click();
      await page
        .locator('.terminal-profile-settings form')
        .filter({ has: page.getByRole('heading', { name: '终端配置' }) })
        .waitFor();
      await settleTargetLayout(page);
      return;
    }
    if (scenario.id === 'automation.commands-batch') {
      await prepareAxtermQuickCommands(page);
      return;
    }
    if (scenario.id === 'automation.triggers-scripts') {
      await prepareAxtermTriggers(page);
      return;
    }
    if (scenario.id === 'monitor.info-remote') {
      await prepareAxtermTerminalInformation(page);
      return;
    }
    if (scenario.id === 'widgets.lifecycle') {
      await prepareAxtermWidgets(page);
      return;
    }
    if (scenario.id === 'mcp.widget') {
      await prepareAxtermWidgets(page, /MCP Server/u);
      return;
    }
    if (scenario.id === 'settings.navigation-map') {
      await prepareAxtermSettingsNavigation(page);
      return;
    }
    if (scenario.id === 'settings.themes') {
      await prepareAxtermTerminalThemes(page);
      return;
    }
    if (scenario.id === 'settings.shortcuts-window') {
      await prepareAxtermShortcutSettings(page);
      return;
    }
    if (scenario.id === 'settings.data-sync-i18n-update') {
      await prepareAxtermDataSync(page);
      return;
    }
    if (scenario.id === 'ai.configuration-adapters') {
      await prepareAxtermAiConfiguration(page);
      return;
    }
    if (scenario.id === 'ai.chat-context') {
      await prepareAxtermAiChat(page);
      return;
    }
    if (scenario.id === 'ai.chat-cancelled') {
      await prepareAxtermCanceledAiChat(page, userData);
      return;
    }
    if (scenario.id === 'ai.generated-assets-agent') {
      await prepareAxtermAiAgent(page, userData);
      return;
    }
    if (scenario.id === 'certification.resilience') {
      await prepareAxtermResilience(page, userData);
      return;
    }
    if (scenario.id === 'certification.platform-upgrade') {
      await prepareAxtermPlatformCertification(page);
      return;
    }
    if (scenario.id === 'certification.visual-accessibility') {
      await prepareAxtermAccessibilityCertification(page);
      return;
    }
    if (scenario.id === 'settings.localization-ltr') {
      await prepareAxtermLocalization(page, 'en');
      return;
    }
    if (scenario.id === 'settings.localization-rtl') {
      await prepareAxtermLocalization(page, 'ar');
      return;
    }
    throw new Error(`Scenario ${scenario.id} has no Axterm capture driver yet.`);
  }
  await page.locator('.tabs').waitFor({ timeout: 60_000 });
  await page.locator('.main-footer').waitFor({ timeout: 60_000 });
  await settleTargetLayout(page);
  if (scenario.id === 'shell.chrome-empty') {
    await waitForElectermTerminals(page);
    await page.evaluate(() => globalThis.store.removeTabs(() => true));
    await page.locator('.tab').first().waitFor({ state: 'detached' });
    await page.locator('.no-sessions').waitFor();
    return;
  }
  if (scenario.id === 'shell.new-session-tabs') {
    await page.evaluate(() => {
      for (let index = 0; index < 7; index++) globalThis.store.addTab();
    });
    await page.locator('.tab').nth(7).waitFor();
    await page.evaluate(() => {
      const first = globalThis.store.tabs[0];
      if (first) globalThis.store.pinTab(first.id, true);
    });
    return;
  }
  if (scenario.id === 'shell.layouts') {
    await page.evaluate(() => {
      for (let index = 0; index < 3; index++) globalThis.store.addTab();
      globalThis.store.setLayout('c2x2');
    });
    await page.locator('.layout-item.v4').waitFor();
    return;
  }
  if (scenario.id === 'shell.workspaces') {
    return;
  }
  if (
    scenario.id === 'bookmarks.tree' ||
    scenario.id === 'bookmarks.search' ||
    scenario.id === 'bookmarks.drag-target'
  ) {
    await waitForElectermTerminals(page);
    await prepareElectermBookmarkTree(page);
    if (scenario.id === 'bookmarks.search') {
      const search = page.locator('.sidebar-panel-bookmarks .ant-input');
      await search.fill('prod');
      await page
        .locator('.sidebar-panel-bookmarks .tree-item[data-item-id="archive-mirror"]')
        .waitFor({ state: 'detached' });
      await search.press('ArrowDown');
      await page
        .locator('.sidebar-panel-bookmarks .tree-item[data-item-id="prod-api"].search-selected')
        .waitFor();
    }
    return;
  }
  if (scenario.id === 'bookmarks.connection-history') {
    await waitForElectermTerminals(page);
    await prepareElectermConnectionHistory(page);
    return;
  }
  if (scenario.id === 'bookmarks.command-history') {
    await waitForElectermTerminals(page);
    await prepareElectermCommandHistory(page);
    return;
  }
  if (scenario.id === 'bookmarks.connection-profiles') {
    await waitForElectermTerminals(page);
    await prepareElectermConnectionProfiles(page);
    return;
  }
  if (scenario.id === 'bookmarks.history-profiles') {
    await waitForElectermTerminals(page);
    await prepareElectermConnectionProfiles(page);
    return;
  }
  if (scenario.id === 'bookmarks.ssh-config-import') {
    await waitForElectermTerminals(page);
    await prepareElectermSshConfigImport(page);
    return;
  }
  if (scenario.id === 'bookmarks.forms') {
    await waitForElectermTerminals(page);
    await page.evaluate(() => {
      globalThis.et.openBookmarkWithAIMode = false;
      globalThis.store.profiles = [];
      globalThis.store.onNewSsh();
    });
    await page.locator('.setting-tabs-bookmarks .form-wrap').waitFor();
    await page.addStyleTag({
      content: '.ant-notification,.notification-container{display:none!important}',
    });
    await settleTargetLayout(page);
    return;
  }
  if (scenario.id === 'ssh.network') {
    await prepareElectermSshNetwork(page);
    return;
  }
  if (scenario.id === 'ssh.authentication') {
    await prepareElectermSshAuthentication(page);
    return;
  }
  if (scenario.id === 'ssh.tunnels-sftp') {
    await prepareElectermSshTunnels(page);
    return;
  }
  if (scenario.id === 'files.browse-operate') {
    await prepareElectermLiveSftp(page, userData);
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    const remote = page.locator('.session-current .file-list.remote');
    const first = remote.locator('.sftp-item[title="audit.log"]');
    const second = remote.locator('.sftp-item[title="deploy.env"]');
    await first.click();
    await second.click({ modifiers: [modifier] });
    await settleTargetLayout(page);
    return;
  }
  if (scenario.id === 'files.transfers') {
    await prepareElectermLiveSftp(page, userData, true);
    const source = page.locator(
      '.session-current .file-list.local .sftp-item[title="parity-large.bin"]',
    );
    await source.click({ button: 'right', position: { x: 20, y: 12 } });
    const upload = page
      .locator(
        '.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item:has(.anticon-cloud-upload)',
      )
      .first();
    await upload.waitFor({ state: 'visible' });
    await upload.click();
    const transferButton = page.locator('.control-icon-wrap[title="File transfers"]');
    await transferButton.waitFor({ state: 'visible', timeout: 30_000 });
    await transferButton.hover();
    await page.locator('.transfer-list-card').waitFor({ state: 'visible', timeout: 10_000 });
    await settleTargetLayout(page);
    return;
  }
  if (scenario.id === 'files.edit-inspect') {
    await prepareElectermLiveSftp(page, userData);
    await page
      .locator('.session-current .file-list.remote .sftp-item[title="parity-notes.txt"]')
      .dblclick();
    const editor = page.locator('.custom-modal-wrap .custom-modal-body textarea');
    await editor.waitFor({ state: 'visible', timeout: 30_000 });
    const search = page.locator(
      '.custom-modal-wrap .custom-modal-body .ant-input-search input.ant-input',
    );
    await search.fill('alpha');
    await settleTargetLayout(page);
    return;
  }
  if (scenario.id === 'terminal.transfer-protocols') {
    await prepareElectermTerminalTransfer(page, userData);
    return;
  }
  if (scenario.id.startsWith('protocol.')) {
    const protocol = scenario.id === 'protocol.web-deeplink' ? 'web' : scenario.id.slice(9);
    await prepareElectermProtocolBookmark(page, protocol);
    return;
  }
  if (scenario.id === 'terminal.basic' || scenario.id === 'terminal.productivity') {
    await waitForElectermTerminals(page);
    return;
  }
  if (scenario.id === 'terminal.addons-settings') {
    await waitForElectermTerminals(page);
    await page.evaluate(() => {
      globalThis.store.settingTab = 'setting';
      globalThis.store.setSettingItem({
        id: 'setting-terminal',
        title: globalThis.translate('terminal'),
      });
      globalThis.store.openSettingModal();
    });
    await page.locator('.setting-tabs-setting .form-wrap').waitFor({ state: 'visible' });
    await settleTargetLayout(page);
    return;
  }
  if (scenario.id === 'automation.commands-batch') {
    await prepareElectermQuickCommands(page);
    return;
  }
  if (scenario.id === 'automation.triggers-scripts') {
    await prepareElectermTriggers(page);
    return;
  }
  if (scenario.id === 'monitor.info-remote') {
    await prepareElectermTerminalInformation(page);
    return;
  }
  if (scenario.id === 'widgets.lifecycle') {
    await prepareElectermWidgets(page);
    return;
  }
  if (scenario.id === 'mcp.widget') {
    await prepareElectermWidgets(page, 'MCP Server');
    return;
  }
  if (scenario.id === 'settings.navigation-map') {
    await prepareElectermSettingsNavigation(page);
    return;
  }
  if (scenario.id === 'settings.themes') {
    await prepareElectermTerminalThemes(page);
    return;
  }
  if (scenario.id === 'settings.shortcuts-window') {
    await prepareElectermShortcutSettings(page);
    return;
  }
  if (scenario.id === 'settings.data-sync-i18n-update') {
    await prepareElectermDataSync(page);
    return;
  }
  if (scenario.id === 'ai.configuration-adapters') {
    await prepareElectermAiConfiguration(page);
    return;
  }
  if (scenario.id === 'ai.chat-context') {
    await prepareElectermAiChat(page);
    return;
  }
  if (scenario.id === 'ai.chat-cancelled') {
    await prepareElectermCanceledAiChat(page);
    return;
  }
  if (scenario.id === 'ai.generated-assets-agent') {
    await prepareElectermAiAgent(page);
    return;
  }
  if (scenario.id === 'certification.resilience') {
    await prepareElectermResilience(page);
    return;
  }
  if (scenario.id === 'certification.platform-upgrade') {
    await prepareElectermPlatformCertification(page);
    return;
  }
  if (scenario.id === 'certification.visual-accessibility') {
    await prepareElectermAccessibilityCertification(page);
    return;
  }
  if (scenario.id === 'settings.localization-ltr') {
    await prepareElectermLocalization(page, 'en');
    return;
  }
  if (scenario.id === 'settings.localization-rtl') {
    await prepareElectermLocalization(page, 'ar');
    return;
  }
  throw new Error(`Scenario ${scenario.id} has no Electerm capture driver yet.`);
}

async function openScenarioTransient(target, scenario, page) {
  if (scenario.id === 'files.browse-operate') {
    if (target === 'axterm') {
      await page
        .getByRole('region', { name: '远端文件' })
        .getByRole('button', { name: 'deploy.env', exact: true })
        .click({ button: 'right', position: { x: 20, y: 12 } });
      await page.getByRole('menu', { name: '远端文件菜单' }).waitFor();
    } else {
      await openElectermContextMenu(
        page,
        '.session-current .file-list.remote .sftp-item[title="deploy.env"]',
      );
    }
    await page.evaluate(
      () =>
        new Promise((resolveFrame) =>
          globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolveFrame)),
        ),
    );
    return;
  }
  if (scenario.id === 'terminal.basic' || scenario.id === 'terminal.transfer-protocols') {
    if (target === 'axterm') {
      await page
        .locator('.terminal-host')
        .first()
        .click({ button: 'right', position: { x: 20, y: 12 } });
      await page.locator('.terminal-context-menu').waitFor();
    } else {
      await openElectermContextMenu(page, '.term-wrap');
    }
    await page.evaluate(
      () =>
        new Promise((resolveFrame) =>
          globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolveFrame)),
        ),
    );
    return;
  }
  if (scenario.id === 'terminal.productivity') {
    if (target === 'axterm') {
      await page
        .locator('.terminal-surface')
        .first()
        .evaluate((element) => {
          const dataTransfer = new globalThis.DataTransfer();
          dataTransfer.items.add(
            new globalThis.File(['PARITY'], 'terminal-parity.txt', { type: 'text/plain' }),
          );
          element.dispatchEvent(
            new globalThis.DragEvent('dragenter', {
              bubbles: true,
              cancelable: true,
              dataTransfer,
            }),
          );
          element.dispatchEvent(
            new globalThis.DragEvent('drop', {
              bubbles: true,
              cancelable: true,
              dataTransfer,
            }),
          );
        });
      await page.locator('.terminal-file-drop-dialog').waitFor();
    } else {
      await page.evaluate(() => {
        const terminal = globalThis.refs.get(`term-${globalThis.store.activeTabId}`);
        if (!terminal) throw new Error('Electerm terminal ref is unavailable');
        terminal.setState({
          dropFileModalVisible: true,
          droppedFiles: [{ path: '/tmp/terminal-parity.txt', isRemote: false }],
        });
      });
      await page.locator('.custom-modal-content').waitFor();
    }
    await page.evaluate(
      () =>
        new Promise((resolveFrame) =>
          globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolveFrame)),
        ),
    );
    return;
  }
  if (scenario.id === 'bookmarks.connection-history') {
    return;
  }
  if (scenario.id === 'bookmarks.command-history') {
    if (target === 'axterm') {
      await page.getByRole('button', { name: '命令历史', exact: true }).click();
      const popover = page.getByLabel('命令历史面板');
      await popover.waitFor();
      await popover.getByText('按使用频次排序').click();
      await popover.locator('.command-history-item-text').first().getByText('git status').waitFor();
    } else {
      await page.locator('.terminal-footer-history .ant-btn').click();
      const popover = page.locator('.cmd-history-popover-content');
      await popover.waitFor();
      await popover.locator('.ant-switch').click();
      await popover.locator('.cmd-history-item-text').first().getByText('git status').waitFor();
    }
    await page.evaluate(
      () =>
        new Promise((resolveFrame) =>
          globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolveFrame)),
        ),
    );
    return;
  }
  if (scenario.id === 'bookmarks.drag-target') {
    const selectors =
      target === 'axterm'
        ? {
            source: '[data-bookmark-title="Archive Mirror"]',
            destination: '[data-bookmark-title="Production API"]',
          }
        : {
            source: '.sidebar-panel-bookmarks .tree-item[data-item-id="archive-mirror"]',
            destination: '.sidebar-panel-bookmarks .tree-item[data-item-id="prod-api"]',
          };
    await page.evaluate(({ source, destination }) => {
      const sourceElement = globalThis.document.querySelector(source);
      const destinationElement = globalThis.document.querySelector(destination);
      if (
        !(sourceElement instanceof globalThis.HTMLElement) ||
        !(destinationElement instanceof globalThis.HTMLElement)
      )
        throw new Error('Bookmark drag parity elements are unavailable');
      const dataTransfer = new globalThis.DataTransfer();
      sourceElement.dispatchEvent(
        new globalThis.DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }),
      );
      globalThis.__axtermParityDrag = dataTransfer;
    }, selectors);
    await page.evaluate(
      () => new Promise((resolveFrame) => globalThis.requestAnimationFrame(resolveFrame)),
    );
    await page.evaluate(({ destination }) => {
      const destinationElement = globalThis.document.querySelector(destination);
      if (!(destinationElement instanceof globalThis.HTMLElement))
        throw new Error('Bookmark drag parity target is unavailable');
      const rectangle = destinationElement.getBoundingClientRect();
      const event = new globalThis.DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: globalThis.__axtermParityDrag,
        clientX: rectangle.left + Math.min(40, rectangle.width / 2),
        clientY: rectangle.top + Math.max(2, rectangle.height * 0.15),
      });
      destinationElement.dispatchEvent(event);
    }, selectors);
    await page
      .locator(target === 'axterm' ? '.bookmark-tree-row.drop-before' : '.tree-item.dnd-before')
      .waitFor();
    return;
  }
  if (scenario.id === 'bookmarks.tree') {
    if (target === 'axterm') {
      await page.locator('[data-bookmark-title="Production API"]').hover();
    } else {
      await page.locator('.sidebar-panel-bookmarks .tree-item[data-item-id="prod-api"]').hover();
    }
    await page.evaluate(
      () =>
        new Promise((resolveFrame) =>
          globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolveFrame)),
        ),
    );
    return;
  }
  if (scenario.id === 'shell.new-session-tabs') {
    if (target === 'axterm') {
      await page
        .locator('.terminal-tab')
        .first()
        .click({ button: 'right', position: { x: 30, y: 20 } });
      await page.locator('.tab-context-menu').waitFor();
    } else {
      await openElectermContextMenu(page, '.tabs .tab');
    }
    await page.evaluate(
      () =>
        new Promise((resolveFrame) =>
          globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolveFrame)),
        ),
    );
    return;
  }
  if (scenario.id !== 'shell.workspaces') return;
  if (target === 'axterm') {
    await page.getByTitle('布局与工作区').click();
    await page.locator('.layout-menu').getByRole('button', { name: '工作区' }).click();
    await page.getByPlaceholder('工作区名称').fill('Parity Workspace');
    await page.locator('.workspace-menu form').getByRole('button', { name: '保存' }).click();
    await page.locator('.workspace-list-menu').getByText('Parity Workspace').waitFor();
  } else {
    await page.evaluate(() => globalThis.store.saveWorkspace('Parity Workspace'));
    await page.locator('.layout-dd-icon').click();
    await page.locator('.layout-workspace-dropdown').waitFor();
    const workspaceTab = page
      .locator('.layout-workspace-dropdown .ant-tabs-tab')
      .filter({ hasText: /Workspace/i });
    await workspaceTab.click();
    await page
      .locator('.workspace-item .workspace-name')
      .getByText('Parity Workspace', { exact: true })
      .first()
      .waitFor();
    await waitForElectermTerminals(page);
  }
  await page.evaluate(
    () =>
      new Promise((resolveFrame) =>
        globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolveFrame)),
      ),
  );
}

const stableLayoutSelector = [
  '#container',
  '.app-shell',
  '.settings-workspace',
  '.settings-category-layout',
  '.settings-category-sidebar',
  '.settings-category-layout > .panel-page',
  '.language-settings-panel',
  '.settings-workspace-tabs',
  '.settings-workspace-tabs button',
  '.setting-tabs',
  '.setting-tabs .ant-tabs-tab',
  '.setting-tabs .ant-tabs-tab-btn',
  '.tabs',
  '.terminal-pane-grid',
  '.layout-wrapper',
  '.no-session-view',
  '.no-sessions',
  '.xterm-rows',
  '.tab-context-menu',
  '.ant-dropdown',
  '.layout-menu',
  '.layout-workspace-dropdown',
  '.bookmark-tree-panel',
  '.bookmark-tree-viewport',
  '.sidebar-panel-bookmarks',
  '.connection-history-panel',
  '.sidebar-panel-history',
  '.command-history-popover',
  '.cmd-history-popover-content',
  '.connection-profile-panel',
  '.ssh-config-import-modal',
  '.ssh-config-import-modal .ssh-import-body',
  '.ssh-config-import-modal .ssh-import-item',
  '.host-bookmark-modal',
  '.host-bookmark-modal > header',
  '.host-bookmark-shell-toolbar button',
  '.host-bookmark-shell-tree button',
  '.host-bookmark-protocols button',
  '.host-protocol-form',
  '.host-form-tabs',
  '.host-form-tabs button',
  '.host-form-field',
  '.host-protocol-form .modal-actions',
  '.terminal-context-menu',
  '.terminal-file-drop-dialog',
  '.terminal-file-drop-dialog > header',
  '.terminal-file-drop-dialog > footer',
  '.terminal-recovery-settings-panel',
  '.ant-modal-content',
  '.ssh-config-list',
  '.ssh-config-item',
  '.setting-wrap',
  '.settings-workspace-tabs',
  '.settings-workspace-tabs button',
  '.setting-tabs',
  '.setting-tabs .ant-tabs-tab',
  '.setting-tabs .ant-tabs-tab-btn',
  '.setting-tabs-profile',
  '.tree-list',
].join(',');

const evidenceGeometrySelectors = [
  '#container',
  '.app-shell',
  '.settings-workspace',
  '.settings-category-layout',
  '.settings-category-sidebar',
  '.settings-category-sidebar > button',
  '.settings-category-layout > .panel-page',
  '.language-settings-panel',
  '.language-settings-panel select',
  '.settings-workspace-tabs',
  '.settings-workspace-tabs button',
  '.settings-workspace-close',
  '.setting-tabs',
  '.setting-tabs .ant-tabs-tab',
  '.setting-tabs .ant-tabs-tab-btn',
  '.tabs',
  '.terminal-pane-grid',
  '.layout-wrapper',
  '.terminal-pane',
  '.layout-item',
  '.pane-tabbar',
  '.pane-tabbar-scroll',
  '.terminal-tab',
  '.tabs .tab',
  '.terminal-pane > header',
  '.no-sessions',
  '.no-session-btns',
  '.no-session-logo',
  '.logo-elem',
  '.morph-shape',
  '.no-session-history',
  '.history-header',
  '.empty-pane-landing',
  '.empty-pane-actions',
  '.empty-pane-actions > button',
  '.empty-pane-brand',
  '.empty-pane-shape',
  '.empty-pane-brand > span',
  '.empty-pane-brand > small',
  '.empty-pane-landing > footer',
  '.empty-pane-sort',
  '.empty-pane-session',
  '.xterm-screen',
  '.xterm-rows',
  '.xterm-rows > div:first-child',
  '.main-footer',
  '.app-statusbar',
  '.tab-context-menu',
  '.ant-dropdown:not(.ant-dropdown-hidden)',
  '.terminal-context-menu',
  '.terminal-file-drop-dialog',
  '.terminal-file-drop-dialog > header',
  '.terminal-file-drop-dialog > footer',
  '.terminal-recovery-settings-panel',
  '.layout-menu',
  '.layout-workspace-dropdown',
  '.bookmark-tree-panel',
  '.bookmark-tree-toolbar',
  '.bookmark-tree-viewport',
  '.bookmark-tree-row',
  '.bookmark-context-menu',
  '.sidebar-panel-bookmarks',
  '.connection-history-panel',
  '.connection-history-toolbar',
  '.connection-history-row',
  '.sidebar-panel-history',
  '.sidebar-panel-history .history-header',
  '.sidebar-panel-history .item-list-unit',
  '.command-history-popover',
  '.command-history-search',
  '.command-history-header',
  '.command-history-list',
  '.command-history-item',
  '.cmd-history-popover-content',
  '.cmd-history-search',
  '.cmd-history-header',
  '.cmd-history-list',
  '.cmd-history-item',
  '.connection-profile-panel',
  '.connection-profile-layout',
  '.connection-profile-list',
  '.connection-profile-editor',
  '.connection-profile-transport',
  '.connection-profile-search',
  '.connection-profile-id',
  '.connection-profile-basics > label',
  '.connection-profile-tabs',
  '.connection-profile-tabs button',
  '.connection-profile-fields > label',
  '.connection-profile-fields input',
  '.connection-profile-fields textarea',
  '.ssh-config-import-modal',
  '.ssh-config-import-modal > header',
  '.ssh-config-import-modal .ssh-import-body',
  '.ssh-config-import-modal .ssh-import-toolbar',
  '.ssh-config-import-modal .ssh-import-metrics',
  '.ssh-config-import-modal .ssh-import-items',
  '.ssh-config-import-modal .ssh-import-item',
  '.host-bookmark-modal',
  '.host-bookmark-modal > header',
  '.host-bookmark-shell-toolbar button',
  '.host-bookmark-shell-tree button',
  '.host-bookmark-protocols button',
  '.host-protocol-form',
  '.host-form-tabs',
  '.host-form-tabs button',
  '.host-form-field',
  '.host-protocol-form .modal-actions',
  '.ant-modal-content',
  '.ant-modal-header',
  '.ant-modal-body',
  '.ssh-config-list',
  '.ssh-config-item',
  '.ssh-config-item-content',
  '.setting-wrap',
  '.setting-tabs-profile',
  '.setting-tabs-profile .setting-row-left',
  '.setting-tabs-profile .setting-row-right',
  '.setting-tabs-profile .ant-form-item',
  '.setting-tabs-profile .ant-tabs-nav',
  '.setting-tabs-profile input',
  '.setting-tabs-bookmarks',
  '.setting-tabs-bookmarks .setting-row-left',
  '.setting-tabs-bookmarks .setting-row-right',
  '.setting-tabs-bookmarks .form-wrap',
  '.setting-tabs-bookmarks .form-title',
  '.setting-tabs-bookmarks .form-title .ant-radio-button-wrapper',
  '.setting-tabs-bookmarks .ant-tabs-nav',
  '.setting-tabs-bookmarks .ant-tabs-tab',
  '.setting-tabs-bookmarks .ant-form-item',
  '.tree-list',
  '.tree-list-header',
  '.item-list-wrap',
  '.tree-list-row',
  '.tree-item',
];

async function collectEvidenceGeometry(page) {
  return page.evaluate((selectors) => {
    const round = (value) => Math.round(value * 100) / 100;
    const result = [];
    for (const selector of selectors) {
      const elements = [...globalThis.document.querySelectorAll(selector)].slice(0, 32);
      for (const [index, element] of elements.entries()) {
        if (result.length >= 160) return result;
        const rectangle = element.getBoundingClientRect();
        if (!rectangle.width || !rectangle.height) continue;
        const style = globalThis.getComputedStyle(element);
        result.push({
          selector,
          index,
          className: typeof element.className === 'string' ? element.className.slice(0, 160) : '',
          bounds: {
            x: round(rectangle.x),
            y: round(rectangle.y),
            width: round(rectangle.width),
            height: round(rectangle.height),
          },
          typography: {
            fontFamily: style.fontFamily.slice(0, 240),
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            color: style.color,
            backgroundColor: style.backgroundColor,
          },
        });
      }
    }
    return result;
  }, evidenceGeometrySelectors);
}

async function collectQualityEvidence(page, target, scenario, hardDefectChecks) {
  if (target !== 'axterm') {
    return { applied: false, passed: true, checks: [] };
  }
  const localizationScenario = scenario.id.startsWith('settings.localization-');
  const expectedDirection = scenario.id.endsWith('-rtl') ? 'rtl' : 'ltr';
  return page.evaluate(
    ({ expectedDirection, hardDefectChecks, localizationScenario }) => {
      const byId = new Map();
      const record = (id, passed, detail) => byId.set(id, { id, passed, detail });
      const visible = (element) => {
        if (!(element instanceof globalThis.HTMLElement)) return false;
        const bounds = element.getBoundingClientRect();
        const style = globalThis.getComputedStyle(element);
        return (
          bounds.width > 0 &&
          bounds.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      };
      const withinViewport = (element) => {
        if (!(element instanceof globalThis.HTMLElement)) return false;
        const bounds = element.getBoundingClientRect();
        return (
          bounds.left >= -1 &&
          bounds.top >= -1 &&
          bounds.right <= globalThis.innerWidth + 1 &&
          bounds.bottom <= globalThis.innerHeight + 1
        );
      };
      const overlaps = (left, right) => {
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        return (
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
        );
      };
      const rgb = (value) => {
        const match = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
        return match
          ? {
              red: Number(match[1]),
              green: Number(match[2]),
              blue: Number(match[3]),
              alpha: match[4] === undefined ? 1 : Number(match[4]),
            }
          : undefined;
      };
      const luminance = ({ red, green, blue }) => {
        const linear = [red, green, blue].map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      };
      const contrast = (foreground, background) => {
        const lighter = Math.max(luminance(foreground), luminance(background));
        const darker = Math.min(luminance(foreground), luminance(background));
        return (lighter + 0.05) / (darker + 0.05);
      };
      const backgroundFor = (element) => {
        let current = element;
        while (current instanceof globalThis.HTMLElement) {
          const color = rgb(globalThis.getComputedStyle(current).backgroundColor);
          if (color && color.alpha >= 0.98) return color;
          current = current.parentElement;
        }
        return { red: 13, green: 17, blue: 19, alpha: 1 };
      };

      if (!localizationScenario) {
        const controls = [
          ...globalThis.document.querySelectorAll(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[role="tab"]:not([aria-disabled="true"]),[role="menuitem"]:not([aria-disabled="true"])',
          ),
        ].filter(visible);
        const overlappingPairs = controls.flatMap((control, index) =>
          controls.slice(index + 1).flatMap((other) => {
            if (control.parentElement !== other.parentElement) return [];
            if (
              control.matches('.tab-add,.tab-add-menu') &&
              other.matches('.tab-add,.tab-add-menu')
            )
              return [];
            if (globalThis.getComputedStyle(control).position === 'absolute') return [];
            if (globalThis.getComputedStyle(other).position === 'absolute') return [];
            return overlaps(control, other) ? [[control, other]] : [];
          }),
        );
        record(
          'overlapping-primary-controls',
          overlappingPairs.length === 0,
          overlappingPairs.length
            ? `visible sibling controls overlap: ${overlappingPairs
                .slice(0, 3)
                .map((pair) =>
                  pair
                    .map(
                      (element) =>
                        element.getAttribute('aria-label') ||
                        element.textContent?.trim().slice(0, 24) ||
                        element.className,
                    )
                    .join(' / '),
                )
                .join(', ')}`
            : `${controls.length} visible controls have disjoint sibling geometry`,
        );

        const clipped = controls.filter((element) => {
          if (element.closest('.app-statusbar')) return false;
          if (element.tagName !== 'BUTTON' && !element.matches('[role="tab"],[role="menuitem"]'))
            return false;
          const style = globalThis.getComputedStyle(element);
          const intentionalEllipsis = style.textOverflow === 'ellipsis';
          return (
            element.scrollHeight > element.clientHeight + 2 ||
            (!intentionalEllipsis && element.scrollWidth > element.clientWidth + 2)
          );
        });
        record(
          'clipped-text-or-actions',
          clipped.length === 0,
          clipped.length
            ? `${clipped.length} visible controls clip content: ${clipped
                .slice(0, 5)
                .map(
                  (element) =>
                    `${element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 30) || element.className} ` +
                    `(${element.clientWidth}x${element.clientHeight}/${element.scrollWidth}x${element.scrollHeight})`,
                )
                .join(', ')}`
            : 'visible controls fit',
        );

        const contrastRatios = controls
          .filter((element) => element.textContent?.trim())
          .slice(0, 80)
          .flatMap((element) => {
            const foreground = rgb(globalThis.getComputedStyle(element).color);
            return foreground
              ? [
                  {
                    ratio: contrast(foreground, backgroundFor(element)),
                    label:
                      element.getAttribute('aria-label') ||
                      element.textContent?.trim().slice(0, 30) ||
                      element.className,
                  },
                ]
              : [];
          });
        const minimumContrast = contrastRatios.length
          ? Math.min(...contrastRatios.map(({ ratio }) => ratio))
          : 21;
        const minimumContrastControl = contrastRatios.find(
          ({ ratio }) => ratio === minimumContrast,
        );
        record(
          'unreadable-content-or-contrast',
          minimumContrast >= 3,
          `minimum primary-control contrast=${minimumContrast.toFixed(2)}:1` +
            (minimumContrastControl ? ` (${minimumContrastControl.label})` : ''),
        );

        const overlays = [
          ...globalThis.document.querySelectorAll(
            '[role="dialog"],[role="menu"],[role="listbox"],.tab-context-menu,.terminal-context-menu,.file-context-menu',
          ),
        ].filter(visible);
        const offViewport = overlays.filter((element) => !withinViewport(element));
        record(
          'off-viewport-menu-or-dialog',
          offViewport.length === 0,
          offViewport.length
            ? `${offViewport.length} visible overlays leave the viewport`
            : `${overlays.length} visible overlays remain inside the viewport`,
        );

        const rootDirection = globalThis.document.documentElement.dir || 'ltr';
        record(
          'broken-ltr-rtl-direction',
          rootDirection === expectedDirection,
          `root=${rootDirection}, expected=${expectedDirection}`,
        );

        const focusTarget = controls.find(
          (element) =>
            element instanceof globalThis.HTMLElement &&
            element.tabIndex >= 0 &&
            globalThis.getComputedStyle(element).pointerEvents !== 'none',
        );
        if (focusTarget instanceof globalThis.HTMLElement)
          focusTarget.focus({ preventScroll: true });
        const focusable =
          focusTarget !== undefined && globalThis.document.activeElement === focusTarget;
        record(
          'broken-keyboard-focus',
          focusable,
          focusable
            ? 'a primary control accepts keyboard focus'
            : 'no primary control accepts focus',
        );

        const main = globalThis.document.querySelector('main');
        record(
          'unreachable-or-nonfunctional-primary-action',
          controls.length > 0 && visible(main),
          `${controls.length} enabled controls are reachable from a visible main surface`,
        );

        const checks = hardDefectChecks.map(
          (id) => byId.get(id) ?? { id, passed: false, detail: 'check was not evaluated' },
        );
        return { applied: true, passed: checks.every((check) => check.passed), checks };
      }

      const tabs = [...globalThis.document.querySelectorAll('.settings-workspace-tabs button')];
      const closes = [...globalThis.document.querySelectorAll('.settings-workspace-close')];
      const categories = [
        ...globalThis.document.querySelectorAll('.settings-category-sidebar > button'),
      ];
      const languageSelect = globalThis.document.querySelector('.language-settings-panel select');
      const languagePanel = globalThis.document.querySelector('.language-settings-panel');
      const categorySidebar = globalThis.document.querySelector('.settings-category-sidebar');
      const contentPanel = globalThis.document.querySelector(
        '.settings-category-layout > .panel-page',
      );
      const chromeControls = [...tabs, ...closes];
      const controlOverlaps = chromeControls.some((control, index) =>
        chromeControls.slice(index + 1).some((other) => overlaps(control, other)),
      );
      const columnsOverlap =
        categorySidebar && contentPanel ? overlaps(categorySidebar, contentPanel) : true;
      record(
        'overlapping-primary-controls',
        !controlOverlaps && !columnsOverlap,
        `${chromeControls.length} chrome controls and settings columns are disjoint`,
      );

      const textControls = [...tabs, ...categories];
      const clipped = textControls.filter(
        (element) => element.scrollWidth > element.clientWidth + 1,
      );
      record(
        'clipped-text-or-actions',
        clipped.length === 0,
        clipped.length ? `${clipped.length} visible labels are clipped` : 'visible labels fit',
      );

      const contrastRatios = [...tabs, ...categories, languageSelect]
        .filter(Boolean)
        .map((element) => {
          const foreground = rgb(globalThis.getComputedStyle(element).color);
          return foreground ? contrast(foreground, backgroundFor(element)) : 0;
        });
      const minimumContrast = Math.min(...contrastRatios);
      const readable = minimumContrast >= 3;
      record(
        'unreadable-content-or-contrast',
        readable,
        `minimum primary-control contrast=${minimumContrast.toFixed(2)}:1`,
      );

      const requiredInViewport = [
        ...tabs,
        ...closes,
        categorySidebar,
        languagePanel,
        languageSelect,
      ].filter(Boolean);
      const offViewport = requiredInViewport.filter(
        (element) => !visible(element) || !withinViewport(element),
      );
      record(
        'off-viewport-menu-or-dialog',
        offViewport.length === 0,
        offViewport.length
          ? `${offViewport.length} required controls are outside the viewport`
          : 'settings chrome and language control are inside the viewport',
      );

      const rootDirection = globalThis.document.documentElement.dir;
      const contentDirection = languagePanel
        ? globalThis.getComputedStyle(languagePanel).direction
        : '';
      record(
        'broken-ltr-rtl-direction',
        rootDirection === expectedDirection && contentDirection === expectedDirection,
        `root=${rootDirection || 'unset'}, content=${contentDirection || 'unset'}, expected=${expectedDirection}`,
      );

      let focusable = false;
      if (languageSelect instanceof globalThis.HTMLSelectElement && !languageSelect.disabled) {
        languageSelect.focus({ preventScroll: true });
        focusable = globalThis.document.activeElement === languageSelect;
      }
      record(
        'broken-keyboard-focus',
        focusable,
        focusable
          ? 'language selector accepts keyboard focus'
          : 'language selector cannot be focused',
      );

      const selectedLanguage =
        languageSelect instanceof globalThis.HTMLSelectElement ? languageSelect.value : '';
      const expectedLanguage = expectedDirection === 'rtl' ? 'ar' : 'en';
      record(
        'unreachable-or-nonfunctional-primary-action',
        selectedLanguage === expectedLanguage,
        `persisted language=${selectedLanguage || 'unset'}, expected=${expectedLanguage}`,
      );

      const checks = hardDefectChecks.map(
        (id) => byId.get(id) ?? { id, passed: false, detail: 'check was not evaluated' },
      );
      return { applied: true, passed: checks.every((check) => check.passed), checks };
    },
    { expectedDirection, hardDefectChecks, localizationScenario },
  );
}

async function waitForStableLayout(page, timeoutMs = 10_000) {
  await page.evaluate(async () => {
    await globalThis.document.fonts?.ready;
    await new Promise((resolveFrame) =>
      globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolveFrame)),
    );
  });
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const geometry = await page.locator(stableLayoutSelector).evaluateAll((elements) =>
      elements.flatMap((element) => {
        const rectangle = element.getBoundingClientRect();
        if (!rectangle.width || !rectangle.height) return [];
        const round = (value) => Math.round(value * 100) / 100;
        return [
          [
            element.id,
            element.className,
            round(rectangle.x),
            round(rectangle.y),
            round(rectangle.width),
            round(rectangle.height),
            element.scrollWidth,
            element.scrollHeight,
          ],
        ];
      }),
    );
    const current = JSON.stringify(geometry);
    stableSamples = current === previous ? stableSamples + 1 : 0;
    if (stableSamples >= 10) return;
    previous = current;
    await page.waitForTimeout(100);
  }
  throw new Error(`Layout did not stabilize within ${timeoutMs}ms`);
}

async function launchTarget(target, launch) {
  if (target === 'axterm') {
    const app = await electron.launch(launch);
    return {
      app,
      page: await app.firstWindow(),
      close: async () => {
        const gracefulClose = app.close().then(
          () => true,
          () => true,
        );
        const closed = await Promise.race([
          gracefulClose,
          new Promise((resolveClose) => setTimeout(() => resolveClose(false), 5_000)),
        ]);
        if (!closed) {
          app.process().kill('SIGKILL');
          await gracefulClose;
        }
      },
    };
  }

  // Current Playwright cannot drive the Node inspector exposed by Electerm's
  // Electron 42 reliably. CDP still controls the real renderer and avoids any
  // patch to the pinned upstream source.
  const child = spawn(launch.executablePath, [...launch.args, '--remote-debugging-port=0'], {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const endpoint = await waitForCdpEndpoint(child);
    const browser = await chromium.connectOverCDP(endpoint);
    const deadline = Date.now() + 30_000;
    let page;
    while (!page && Date.now() < deadline) {
      page = browser.contexts().flatMap((context) => context.pages())[0];
      if (!page) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!page) throw new Error('Electerm renderer did not create a CDP page');
    return {
      page,
      close: async () => {
        await browser.close().catch(() => {});
        await stopChild(child);
      },
    };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function installBrandWordmarkMasks(page) {
  await page.evaluate(() => {
    for (const shape of globalThis.document.querySelectorAll(
      '.empty-pane-shape, .no-session-logo .morph-shape',
    )) {
      if (shape.querySelector(':scope > [data-parity-brand-mask]')) continue;
      const mask = globalThis.document.createElement('span');
      mask.dataset.parityBrandMask = 'true';
      mask.dataset.parityDynamic = 'true';
      mask.setAttribute('aria-hidden', 'true');
      Object.assign(mask.style, {
        position: 'absolute',
        inset: '22% 12%',
        display: 'block',
        pointerEvents: 'none',
      });
      const element = /** @type {HTMLElement} */ (shape);
      element.style.position = 'relative';
      element.append(mask);
    }
  });
}

async function installTerminalBackdropMask(page, useReferenceBounds = false) {
  await page.evaluate((fixedBounds) => {
    const rows = globalThis.document.querySelector('.xterm-rows');
    if (!(rows instanceof globalThis.HTMLElement)) return;
    const rectangle = fixedBounds
      ? {
          left: 53,
          top: 79,
          width: globalThis.innerWidth - 80,
          height: globalThis.innerHeight - 128,
        }
      : rows.getBoundingClientRect();
    const mask = globalThis.document.createElement('div');
    mask.dataset.parityTerminalBackdrop = 'true';
    Object.assign(mask.style, {
      position: 'fixed',
      left: `${rectangle.left}px`,
      top: `${rectangle.top}px`,
      width: `${rectangle.width}px`,
      height: `${rectangle.height}px`,
      zIndex: '20',
      background: '#ff00ff',
      pointerEvents: 'none',
    });
    globalThis.document.body.append(mask);
  }, useReferenceBounds);
}

async function installTerminalSurfaceBackdrop(page, useReferenceBounds = false) {
  await page.evaluate((fixedBounds) => {
    const rows = globalThis.document.querySelector('.xterm-rows');
    if (!(rows instanceof globalThis.HTMLElement)) return;
    const surface = rows.closest('.term-wrap');
    if (!(surface instanceof globalThis.HTMLElement)) return;
    const rectangle = fixedBounds
      ? {
          left: 53,
          top: 79,
          width: globalThis.innerWidth - 80,
          height: globalThis.innerHeight - 128,
        }
      : rows.getBoundingClientRect();
    const surfaceRectangle = surface.getBoundingClientRect();
    const mask = globalThis.document.createElement('div');
    mask.dataset.parityTerminalBackdrop = 'true';
    Object.assign(mask.style, {
      position: 'absolute',
      left: `${rectangle.left - surfaceRectangle.left}px`,
      top: `${rectangle.top - surfaceRectangle.top}px`,
      width: `${rectangle.width}px`,
      height: `${rectangle.height}px`,
      zIndex: '20',
      background: '#ff00ff',
      pointerEvents: 'none',
    });
    surface.append(mask);
  }, useReferenceBounds);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited.catch(() => {});
  }
}

function waitForCdpEndpoint(child) {
  return new Promise((resolveEndpoint, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Electerm CDP endpoint timed out. ${output.slice(-2_000)}`));
    }, 30_000);
    const onData = (chunk) => {
      output = `${output}${String(chunk)}`.slice(-8_000);
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output);
      if (!match?.[1]) return;
      cleanup();
      resolveEndpoint(match[1]);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Electerm exited before CDP was ready (${String(code)}). ${output}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', onExit);
  });
}

async function main() {
  const target = option('target');
  if (!target) throw new Error('--target must be axterm or electerm');
  const scenarioId = option('scenario', 'shell.chrome-empty');
  const manifest = readJson(resolve(repositoryRoot, 'tests/parity/electerm-scenarios.json'));
  const scenario = manifest.scenarios.find(({ id }) => id === scenarioId);
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);
  if (!scenario.capture) throw new Error(`Scenario ${scenarioId} has no visual surface`);
  const outputRoot = resolve(
    option('output', resolve(repositoryRoot, `tests/parity/screenshots/${target}`)),
  );
  const records = [];
  const tracePaths = [];
  for (const viewport of manifest.viewports) {
    const userData = await mkdtemp(resolve(tmpdir(), `axterm-parity-${target}-${viewport.id}-`));
    const tracePath = resolve(outputRoot, 'traces', `${scenario.id}.${viewport.id}.zip`);
    let session;
    try {
      const launch = await resolveLaunch(target, userData);
      session = await launchTarget(target, launch);
      const { page } = session;
      await withInteractionTrace(page, tracePath, async () => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        // Install deterministic motion rules before opening any transient menu.
        // Each viewport owns a fresh app/profile so tabs, workspaces and popovers
        // cannot leak from a differently sized capture.
        await page.addStyleTag({
          content:
            '*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}',
        });
        await prepareScenario(target, scenario, page, userData, session);
        if (target === 'electerm') {
          await suppressElectermUpgrade(page);
        }
        await installBrandWordmarkMasks(page);
        await waitForStableLayout(page);
        // Open popovers only after the long-lived shell/xterm geometry is stable.
        // Electerm can re-render and close an Ant Dropdown while a new PTY settles.
        await openScenarioTransient(target, scenario, page);
        if (target === 'electerm') {
          await suppressElectermUpgrade(page);
        }
        if (
          scenario.id === 'bookmarks.command-history' ||
          scenario.id === 'bookmarks.ssh-config-import' ||
          scenario.id === 'terminal.basic' ||
          scenario.id === 'terminal.productivity' ||
          scenario.id === 'certification.resilience'
        ) {
          // Playwright's native mask is always painted above page content and
          // would hide the popover where it overlaps xterm. A deterministic
          // in-page backdrop keeps terminal bytes out of evidence while the
          // real product popover remains visible above it.
          if (target === 'electerm' && scenario.id === 'terminal.productivity')
            await installTerminalSurfaceBackdrop(page, true);
          else
            await installTerminalBackdropMask(
              page,
              scenario.id === 'bookmarks.ssh-config-import' ||
                scenario.id === 'terminal.basic' ||
                scenario.id === 'terminal.productivity' ||
                scenario.id === 'certification.resilience',
            );
        }
        const masks = [];
        for (const selector of manifest.visualPolicy.maskSelectors) {
          if (
            (scenario.id === 'bookmarks.command-history' ||
              scenario.id === 'bookmarks.connection-profiles' ||
              scenario.id === 'bookmarks.history-profiles' ||
              scenario.id === 'bookmarks.ssh-config-import' ||
              scenario.id === 'bookmarks.forms' ||
              scenario.id === 'ssh.authentication' ||
              scenario.id === 'ssh.network' ||
              scenario.id === 'ssh.tunnels-sftp' ||
              scenario.id.startsWith('protocol.') ||
              scenario.id === 'terminal.basic' ||
              scenario.id === 'terminal.transfer-protocols' ||
              scenario.id === 'terminal.addons-settings' ||
              scenario.id === 'terminal.productivity' ||
              scenario.id.startsWith('automation.') ||
              scenario.id === 'monitor.info-remote' ||
              scenario.id === 'widgets.lifecycle' ||
              scenario.id === 'mcp.widget' ||
              scenario.id === 'settings.navigation-map' ||
              scenario.id === 'settings.themes' ||
              scenario.id === 'settings.shortcuts-window' ||
              scenario.id === 'settings.data-sync-i18n-update' ||
              scenario.id.startsWith('ai.') ||
              scenario.id.startsWith('certification.') ||
              scenario.id.startsWith('settings.localization-')) &&
            selector.startsWith('.xterm')
          ) {
            continue;
          }
          const locator = page.locator(selector);
          if (
            scenario.id === 'bookmarks.connection-profiles' &&
            selector === "[data-parity-dynamic='true']"
          )
            continue;
          if (scenario.id === 'bookmarks.forms' && selector === "[data-parity-dynamic='true']")
            continue;
          if ((await locator.count()) > 0) masks.push(locator);
        }
        const directory = resolve(outputRoot, viewport.id);
        const path = resolve(directory, `${scenario.id}.png`);
        await mkdir(directory, { recursive: true });
        await page.screenshot({
          path,
          animations: 'disabled',
          caret: 'hide',
          mask: masks,
          scale: 'css',
        });
        const geometry = await collectEvidenceGeometry(page);
        const quality = await collectQualityEvidence(
          page,
          target,
          scenario,
          manifest.visualPolicy.hardDefectChecks,
        );
        if (!quality.passed) {
          const failures = quality.checks
            .filter((check) => !check.passed)
            .map((check) => `${check.id}: ${check.detail}`)
            .join('; ');
          throw new Error(
            `Hard-defect check failed for ${scenario.id}/${viewport.id}: ${failures}`,
          );
        }
        records.push({ scenario: scenario.id, viewport, path, tracePath, geometry, quality });
      });
      tracePaths.push(tracePath);
    } finally {
      await session?.close();
      await rm(userData, { recursive: true, force: true });
    }
  }
  const metadata = {
    target,
    baseline: manifest.baseline,
    visualPolicy: manifest.visualPolicy,
    platform: process.platform,
    arch: process.arch,
    capturedAt: new Date().toISOString(),
    tracePaths,
    records,
  };
  await writeFile(
    resolve(outputRoot, `${scenario.id}.json`),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  console.log(`Captured ${records.length} ${target} screenshots in ${outputRoot}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
