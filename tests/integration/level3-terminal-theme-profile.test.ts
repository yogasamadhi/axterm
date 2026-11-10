import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import Registry from '@axterm/infra-typert-registry';
import {
  installConnection,
  type ConnectionWebSocket,
} from '../../packages/infra/connection/src/client/index.ts';
import * as Gateway from '../../packages/infra/gateway/src/client/index.ts';
import * as Terminals from '../../packages/plugins/terminals/src/client/index.ts';
import * as Configuration from '../../packages/plugins/configuration/src/client/index.ts';
import { TerminalKeyBarCommands } from '../../packages/plugins/terminals/src/client/keybar/commands.ts';
import { TerminalThemeCommands } from '../../packages/plugins/terminals/src/client/themes/commands.ts';
import { DEFAULT_TERMINAL_BACKGROUND } from '@axterm/plugin-api/terminals';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';
import type {} from '../../packages/infra/web-startup/src/index.ts';
it('owns theme CRUD and global appearance through generated Remote, observing receipts and retrying only immutable original intents', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-theme-profile-'));
  let app: Awaited<ReturnType<typeof runProfile>> | undefined,
    client: Context | undefined,
    commands: TerminalThemeCommands | undefined,
    keybar: TerminalKeyBarCommands | undefined;
  try {
    app = await runProfile({
      profile: 'web',
      home,
      installAnchor: resolve('apps/cli/package.json'),
      templates: PROFILE_TEMPLATES,
      patchFiles: [],
      args: [],
      requiredServices: ['webStartup', 'terminalController', 'terminalFacts', 'configuration'],
      prepare(ctx) {
        ctx.provide('webAssets', {
          index: resolve('apps/web/dist/index.html'),
          authenticationPage: resolve('apps/web/dist/auth.html'),
        });
      },
    });
    const origin = new URL(app.ctx.webStartup.url).origin,
      token = (await readFile(app.ctx.webStartup.tokenFile!, 'utf8')).trim();
    const auth = await fetch(origin + '/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(auth.status).toBe(200);
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
    client = new Context();
    await client.plugin(Registry);
    installConnection(client, {
      interactions: 'answer',
      transport: {
        streamBaseUrl: origin + '/',
        fetch: (input, init) =>
          fetch(new URL(input, origin + '/'), {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
          }),
        createWebSocket: (url) =>
          new WebSocket(url, { headers: { cookie, origin } }) as unknown as ConnectionWebSocket,
      },
    });
    await client.plugin(Gateway);
    await client.plugin(Configuration);
    await client.plugin(Terminals);
    const facts = client.terminalFactsModel,
      configuration = client.configurationActions;
    await vi.waitFor(() => {
      expect(facts.getSnapshot().status).toBe('ready');
      expect(configuration.getSnapshot().status).toBe('ready');
    });
    const initial = facts.getSnapshot();
    if (initial.status !== 'ready') throw Error('Not ready');
    const theme = initial.baseline.themes[0]!,
      generation = initial.baseline.generation;
    const draft = { name: 'Immutable theme', terminal: { ...theme.terminal }, ui: { ...theme.ui } };
    let lost = true;
    const clone = vi.fn(
      async (...args: Parameters<Terminals.TerminalFactsModel['cloneTerminalTheme']>) => {
        const receipt = await facts.cloneTerminalTheme(...args);
        if (lost) {
          lost = false;
          throw Error('controlled lost response');
        }
        return receipt;
      },
    );
    commands = new TerminalThemeCommands(
      {
        getSnapshot: facts.getSnapshot,
        subscribe: facts.subscribe,
        createTerminalTheme: facts.createTerminalTheme.bind(facts),
        updateTerminalTheme: facts.updateTerminalTheme.bind(facts),
        deleteTerminalTheme: facts.deleteTerminalTheme.bind(facts),
        cloneTerminalTheme: clone,
      },
      configuration,
    );
    const saved = commands.save(draft);
    draft.name = 'Edited while request pending';
    await saved;
    expect(commands.getSnapshot()).toMatchObject({ uncertain: false, failed: false, completed: 1 });
    const savedId = commands.getSnapshot().result!.id!;
    let current = facts.getSnapshot();
    if (current.status !== 'ready') throw Error('Not ready');
    const stored = current.baseline.themes.find((theme) => theme.id === savedId)!;
    expect(stored.name).toBe('Immutable theme');
    await commands.save({ ...draft, name: 'Updated theme' }, stored);
    current = facts.getSnapshot();
    if (current.status !== 'ready') throw Error('Not ready');
    const updated = current.baseline.themes.find((theme) => theme.id === savedId)!;
    expect(updated.version).toBe(2);
    expect(updated.name).toBe('Updated theme');
    const beforeClone = current.baseline.themes.length;
    await commands.clone(updated);
    expect(commands.getSnapshot().uncertain).toBe(true);
    expect(() => commands!.save(draft)).toThrow('BUSY');
    await commands.retry();
    expect(commands.getSnapshot().uncertain).toBe(false);
    expect(clone.mock.calls[1]).toEqual(clone.mock.calls[0]);
    current = facts.getSnapshot();
    if (current.status !== 'ready') throw Error('Not ready');
    expect(current.baseline.themes).toHaveLength(beforeClone + 1);
    const clonedId = commands.getSnapshot().result!.id!,
      cloned = current.baseline.themes.find((theme) => theme.id === clonedId)!;
    await commands.apply({
      themeId: savedId,
      background: { ...DEFAULT_TERMINAL_BACKGROUND, kind: 'text', text: 'Accepted global' },
    });
    const settings = configuration.getSnapshot();
    if (settings.status !== 'ready') throw Error('Not ready');
    expect(settings.baseline.settings.terminal.visual.background.text).toBe('Accepted global');
    const stale = randomUUID(),
      input = { name: 'Must not write', terminal: theme.terminal, ui: theme.ui };
    const refused = await Promise.all([
      client.remote.terminals.createTerminalTheme(randomUUID(), input, stale),
      client.remote.terminals.cloneTerminalTheme(randomUUID(), cloned.id, undefined, stale),
      client.remote.terminals.updateTerminalTheme(
        randomUUID(),
        cloned.id,
        { name: 'Must not update' },
        '"v1"',
        stale,
      ),
      client.remote.terminals.deleteTerminalTheme(randomUUID(), cloned.id, '"v1"', stale),
    ]);
    for (const result of refused)
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'terminals/failure', details: { reason: 'stale' } },
      });
    expect(
      await client.remote.configuration.setTerminalVisual(
        randomUUID(),
        settings.baseline.settings.terminal.visual,
        `"v${settings.baseline.settings.version}"`,
        stale,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'configuration/failure', details: { reason: 'conflict' } },
    });
    const preferenceState = configuration.getSnapshot();
    if (preferenceState.status !== 'ready') throw Error('Not ready');
    const beforePreference = preferenceState.baseline.settings.version;
    let losePreference = true;
    const setButtons = vi.fn(
      async (
        ...args: Parameters<NonNullable<typeof configuration.setTerminalShortcutBarButtons>>
      ) => {
        const receipt = await configuration.setTerminalShortcutBarButtons!(...args);
        if (losePreference) {
          losePreference = false;
          throw Error('controlled lost preference response');
        }
        return receipt;
      },
    );
    keybar = new TerminalKeyBarCommands({
      getSnapshot: configuration.getSnapshot,
      subscribe: configuration.subscribe,
      setTerminalShortcutBarButtons: setButtons,
    });
    const buttons = [{ id: 'custom-a', label: 'Shift+A', data: 'A', custom: true }];
    const saving = keybar.save(buttons);
    buttons[0]!.data = 'must not replace the original intent';
    await expect(saving).rejects.toThrow('OUTCOME_UNCERTAIN');
    expect(keybar.getSnapshot()).toEqual({ busy: false, uncertain: true });
    expect(() => keybar!.save(buttons)).toThrow('BUSY');
    await keybar.retry();
    expect(setButtons.mock.calls[1]).toEqual(setButtons.mock.calls[0]);
    const acceptedPreference = configuration.getSnapshot();
    if (acceptedPreference.status !== 'ready') throw Error('Not ready');
    expect(acceptedPreference.baseline.settings.version).toBe(beforePreference + 1);
    expect(acceptedPreference.baseline.settings.terminal.shortcutBarButtons).toEqual([
      { id: 'custom-a', label: 'Shift+A', data: 'A', custom: true },
    ]);
    expect(
      await client.remote.configuration.setTerminalShortcutBarButtons(
        randomUUID(),
        [],
        `"v${acceptedPreference.baseline.settings.version}"`,
        stale,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'configuration/failure', details: { reason: 'conflict' } },
    });
    expect(generation).toBe(initial.baseline.generation);
    await commands.remove(cloned);
    current = facts.getSnapshot();
    if (current.status !== 'ready') throw Error('Not ready');
    expect(current.baseline.themes.some((theme) => theme.id === cloned.id)).toBe(false);
  } finally {
    await keybar?.close();
    await commands?.close().catch(() => {});
    await client?.fiber.dispose().catch(() => {});
    await app?.shutdown.shutdown(0);
    await rm(home, { recursive: true, force: true });
  }
}, 15000);
