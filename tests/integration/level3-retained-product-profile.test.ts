import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConnectionHandle } from '../../packages/infra/connection/src/client/index.ts';
import * as Terminals from '../../packages/plugins/terminals/src/client/index.ts';
import { DEFAULT_TERMINAL_BEHAVIOR } from '@axterm/plugin-api/terminals';
import { remoteProfile, remoteValue } from '../fixtures/level3-remote-profile.ts';
const profiles: Awaited<ReturnType<typeof remoteProfile>>[] = [],
  homes: string[] = [];
afterEach(async () => {
  for (const f of profiles.splice(0).reverse()) await f.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function launch(home?: string) {
  if (!home) {
    home = await mkdtemp(join(tmpdir(), 'axterm-product-profile-'));
    homes.push(home);
  }
  const f = await remoteProfile(home, { terminals: true });
  profiles.push(f);
  await f.client.plugin(Terminals);
  await vi.waitFor(() => expect(f.client.terminalFactsModel.getSnapshot().status).toBe('ready'));
  return { ...f, home };
}
it('retains the original CRUD values and profile clipboard policy across actual authenticated Profile generations', async () => {
  let f = await launch();
  const home = f.home;
  const createdGroup = await remoteValue(
    f.client.remote.catalog.createHostGroup(randomUUID(), { name: '生产环境', sortOrder: 0 }),
  );
  const group = (await remoteValue(f.client.remote.catalog.listHostGroups())).find(
    (row) => row.id === createdGroup.ids[0],
  )!;
  const createdHost = await remoteValue(
    f.client.remote.catalog.createHost(randomUUID(), {
      name: 'gateway',
      hostname: '127.0.0.1',
      port: 2222,
      username: 'fixture',
      groupId: group.id,
      authType: 'password',
      credentialRef: null,
      passphraseCredentialRef: null,
      jumpHostId: null,
      favorite: true,
      connectionOptions: {
        connectionTimeoutMs: 45_000,
        keepaliveIntervalMs: 5_000,
        keepaliveCountMax: 8,
        compression: true,
        reconnectPolicy: { mode: 'manual', delayMs: 3_000, maxAttempts: 10 },
      },
    }),
  );
  const host = await remoteValue(f.client.remote.catalog.getHost(createdHost.ids[0]!));
  await remoteValue(
    f.client.remote.catalog.updateHost(
      randomUUID(),
      host.id,
      {
        favorite: false,
        connectionOptions: {
          compression: false,
          reconnectPolicy: { mode: 'automatic', delayMs: 1_000, maxAttempts: 3 },
        },
      },
      '"v' + host.version + '"',
    ),
  );
  const updated = await remoteValue(f.client.remote.catalog.getHost(host.id));
  expect(updated.connectionOptions).toEqual({
    connectionTimeoutMs: 45_000,
    keepaliveIntervalMs: 5_000,
    keepaliveCountMax: 8,
    compression: false,
    algorithms: { kex: [], cipher: [], serverHostKey: [], hmac: [] },
    reconnectPolicy: { mode: 'automatic', delayMs: 1_000, maxAttempts: 3 },
  });
  await expect(
    remoteValue(
      f.client.remote.catalog.createHost(randomUUID(), {
        name: 'invalid SSH options',
        hostname: 'invalid.example.test',
        username: 'fixture',
        connectionOptions: { connectionTimeoutMs: 999 },
      }),
    ),
  ).rejects.toMatchObject({ code: 'catalog/failure', details: { reason: 'invalid-input' } });
  await expect(
    remoteValue(
      f.client.remote.catalog.updateHost(
        randomUUID(),
        host.id,
        { name: 'stale' },
        '"v' + host.version + '"',
      ),
    ),
  ).rejects.toMatchObject({ code: 'catalog/failure', details: { reason: 'precondition-failed' } });
  const facts = f.client.terminalFactsModel;
  const createdProfile = await facts.createTerminalProfile(randomUUID(), {
    name: 'Persisted renderer profile',
    scrollback: 8_000,
    rendererPreference: 'webgl',
    unicodeVersion: '11',
    ligaturesEnabled: false,
    imageSequencesEnabled: true,
    wordSeparator: ' /',
    backspaceMode: '^H',
    shiftEnterMode: '\\r',
    encoding: 'gbk',
    displayRaw: true,
    logTimestamps: true,
  });
  const terminalProfile = await remoteValue(
    f.client.remote.terminals.getTerminalProfile(createdProfile.ids[0]!),
  );
  expect(terminalProfile).toMatchObject({
    osc52Enabled: true,
    osc52ReadPolicy: 'deny',
    osc52WritePolicy: 'allow',
  });
  const restricted = await facts.createTerminalProfile(randomUUID(), {
    name: 'Restricted clipboard',
    osc52Enabled: false,
    osc52ReadPolicy: 'deny',
    osc52WritePolicy: 'deny',
  });
  const restrictedProfile = await remoteValue(
    f.client.remote.terminals.getTerminalProfile(restricted.ids[0]!),
  );
  await facts.updateTerminalProfile(
    randomUUID(),
    restrictedProfile.id,
    { fontSize: 19 },
    '"v' + restrictedProfile.version + '"',
  );
  const updatedRestrictedProfile = await remoteValue(
    f.client.remote.terminals.getTerminalProfile(restrictedProfile.id),
  );
  expect(updatedRestrictedProfile).toMatchObject({
    fontSize: 19,
    osc52Enabled: false,
    osc52ReadPolicy: 'deny',
    osc52WritePolicy: 'deny',
  });
  const previousGeneration = f.application.ctx.runtimeIdentity.generation;
  await f.close();
  f = await launch(home);
  expect(f.application.ctx.runtimeIdentity.generation).not.toBe(previousGeneration);
  expect(await remoteValue(f.client.remote.catalog.listHostGroups())).toEqual([group]);
  expect(await remoteValue(f.client.remote.catalog.listHosts())).toEqual([updated]);
  expect(await remoteValue(f.client.remote.terminals.listTerminalProfiles())).toEqual([
    terminalProfile,
    updatedRestrictedProfile,
  ]);
});
it.skipIf(process.platform === 'win32')(
  'retains the original saved PTY environment and complete xterm appearance and behavior through generated Remote',
  async () => {
    const f = await launch(),
      cwd = await realpath(f.home);
    const input = {
      name: 'Profile fixture',
      shell: '/bin/sh',
      shellArgs: [
        '-c',
        'printf "PROFILE=%s|%s|%s|%s\\n" "$PROFILE_MARKER" "$LANG" "$TERM" "$PWD"; sleep 1',
      ],
      cwd,
      loginShell: false,
      env: { PROFILE_MARKER: 'active' },
      term: 'screen-256color',
      lang: 'C.UTF-8',
      fontFamily: 'Iosevka, monospace',
      fontSize: 18,
      lineHeight: 1.3,
      cursorStyle: 'bar' as const,
      cursorBlink: true,
      scrollback: 12_000,
      rendererPreference: 'webgl' as const,
      unicodeVersion: '11' as const,
      ligaturesEnabled: false,
      imageSequencesEnabled: true,
      wordSeparator: ' /',
      backspaceMode: '^H' as const,
      shiftEnterMode: '\\r' as const,
      encoding: 'gbk' as const,
      displayRaw: false,
      logTimestamps: true,
      pasteProtection: false,
      osc52Enabled: true,
      osc52ReadPolicy: 'allow' as const,
      osc52WritePolicy: 'deny' as const,
    };
    const receipt = await f.client.terminalFactsModel.createTerminalProfile(randomUUID(), input);
    const profile = await remoteValue(
      f.client.remote.terminals.getTerminalProfile(receipt.ids[0]!),
    );
    await f.client.terminalFactsModel.updateTerminalProfile(
      randomUUID(),
      profile.id,
      { fontSize: 19 },
      '"v' + profile.version + '"',
    );
    const updated = await remoteValue(f.client.remote.terminals.getTerminalProfile(profile.id));
    expect(updated).toMatchObject({ ...input, fontSize: 19 });
    const terminal = await f.client.terminalsModel.create({
      kind: 'local',
      profileId: updated.id,
      cols: 100,
      rows: 30,
    });
    expect(terminal).toMatchObject({
      profileId: updated.id,
      appearance: {
        fontFamily: 'Iosevka, monospace',
        fontSize: 19,
        lineHeight: 1.3,
        cursorStyle: 'bar',
        cursorBlink: true,
      },
      behavior: {
        ...DEFAULT_TERMINAL_BEHAVIOR,
        scrollback: 12_000,
        rendererPreference: 'webgl',
        unicodeVersion: '11',
        ligaturesEnabled: false,
        imageSequencesEnabled: true,
        wordSeparator: ' /',
        backspaceMode: '^H',
        shiftEnterMode: '\\r',
        encoding: 'gbk',
        displayRaw: false,
        logTimestamps: true,
        pasteProtection: false,
        osc52Enabled: true,
        osc52ReadPolicy: 'allow',
        osc52WritePolicy: 'deny',
      },
    });
    let output = '';
    const decoder = new TextDecoder();
    const stream = new Terminals.TerminalStream(
      f.client.get('connection') as unknown as ConnectionHandle,
      {
        terminalId: terminal.id,
        writer: {
          write(bytes, done) {
            output = (
              output + (typeof bytes === 'string' ? bytes : decoder.decode(bytes, { stream: true }))
            ).slice(-16384);
            done();
          },
        },
      },
    );
    try {
      await vi.waitFor(() =>
        expect(output).toContain(`PROFILE=active|C.UTF-8|screen-256color|${cwd}`),
      );
    } finally {
      stream.dispose();
      await f.client.terminalsModel.close(terminal.id);
    }
    expect(f.application.ctx.terminals.resourceCount()).toBe(0);
  },
);
it('retains sanitized malformed Host input through actual Remote with no partial persistent mutation', async () => {
  const f = await launch();
  const error: unknown = await remoteValue(
    f.client.remote.catalog.createHost(randomUUID(), {
      name: 'secret-marker',
      hostname: 'invalid.example',
      username: 'fixture',
      port: -1,
    }),
  ).catch((error: unknown) => error);
  expect(error).toMatchObject({
    code: 'catalog/failure',
    details: { reason: 'invalid-input', diagnostic: { code: 'VALIDATION_ERROR' } },
  });
  expect(JSON.stringify(error)).not.toContain('secret-marker');
  expect(await remoteValue(f.client.remote.catalog.listHosts())).toEqual([]);
});
