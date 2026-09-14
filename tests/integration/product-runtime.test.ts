import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootstrapResponseSchema,
  DEFAULT_TERMINAL_BEHAVIOR,
  problemSchema,
  terminalProfileSchema,
  terminalSessionSchema,
} from '../../packages/contracts/src/index';
import { createRuntimeClient } from '../../packages/client/src/api-client';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';

const runtimes: Awaited<ReturnType<typeof startRuntime>>[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function launch(dataDirectory?: string) {
  const runtime = await startRuntime({
    generation: randomUUID(),
    appVersion: '0.10.0',
    mode: 'headless',
    ...(dataDirectory ? { dataDirectory } : {}),
  });
  runtimes.push(runtime);
  return runtime;
}

async function login(runtime: Awaited<ReturnType<typeof launch>>) {
  const response = await fetch(`${runtime.baseUrl}/api/v1/auth/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrapToken: runtime.bootstrap().bootstrapToken }),
  });
  return bootstrapResponseSchema.parse(await response.json()).sessionToken;
}

describe('Phase 1-9 Runtime integration', () => {
  it('persists CRUD resources across Runtime generations and enforces ETags', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-runtime-product-'));
    directories.push(directory);
    let runtime = await launch(directory);
    let client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    const group = await client.createHostGroup({ name: '生产环境', sortOrder: 0 });
    const host = await client.createHost({
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
    });
    const updated = await client.updateHost(host, {
      favorite: false,
      connectionOptions: {
        compression: false,
        reconnectPolicy: { mode: 'automatic', delayMs: 1_000, maxAttempts: 3 },
      },
    });
    expect(updated.connectionOptions).toEqual({
      connectionTimeoutMs: 45_000,
      keepaliveIntervalMs: 5_000,
      keepaliveCountMax: 8,
      compression: false,
      algorithms: { kex: [], cipher: [], serverHostKey: [], hmac: [] },
      reconnectPolicy: { mode: 'automatic', delayMs: 1_000, maxAttempts: 3 },
    });
    await expect(
      client.createHost({
        name: 'invalid SSH options',
        hostname: 'invalid.example.test',
        username: 'fixture',
        connectionOptions: { connectionTimeoutMs: 999 },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(client.updateHost(host, { name: 'stale' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      status: 412,
    });
    const terminalProfile = await client.createTerminalProfile({
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
    client.dispose();
    await runtime.close();

    runtime = await launch(directory);
    client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    expect(await client.hostGroups()).toEqual([group]);
    expect(await client.hosts()).toEqual([updated]);
    expect(await client.terminalProfiles()).toEqual([terminalProfile]);
    client.dispose();
  });

  it('runs a real node-pty shell over binary WebSocket and releases it', async () => {
    const runtime = await launch();
    const token = await login(runtime);
    const headers = {
      Authorization: `Bearer ${token}`,
      'X-Runtime-Generation': runtime.metadata.generation,
      'Content-Type': 'application/json',
    };
    const response = await fetch(`${runtime.baseUrl}/api/v1/terminals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'local', cols: 80, rows: 24 }),
    });
    expect(response.status).toBe(201);
    const terminal = terminalSessionSchema.parse(await response.json());
    const url = new URL(`/api/v1/terminals/${terminal.id}/stream`, runtime.baseUrl);
    url.protocol = 'ws:';
    const socket = new WebSocket(
      url,
      ['terminal.v1', `terminal-client.${randomUUID()}`, `auth.${token}`],
      {
        origin: runtime.baseUrl,
      },
    );
    const output = await new Promise<string>((resolve, reject) => {
      let received = '';
      const timer = setTimeout(() => reject(new Error(`PTY output timed out: ${received}`)), 5_000);
      socket.on('open', () => {
        socket.send(Buffer.from("printf '\\nAXTERM_PTY_OK\\n'\n"), { binary: true });
        socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
      });
      socket.on('message', (data, binary) => {
        if (!binary) return;
        received += Buffer.from(data as Buffer).toString('utf8');
        if (received.includes('AXTERM_PTY_OK')) {
          clearTimeout(timer);
          resolve(received);
        }
      });
      socket.on('error', reject);
    });
    expect(output).toContain('AXTERM_PTY_OK');
    socket.close();
    expect(
      (
        await fetch(`${runtime.baseUrl}/api/v1/terminals/${terminal.id}`, {
          method: 'DELETE',
          headers,
        })
      ).status,
    ).toBe(204);
    const diagnostics = await (
      await fetch(`${runtime.baseUrl}/api/v1/diagnostics/runtime`, { headers })
    ).json();
    expect(diagnostics.resources.terminals).toBe(0);
  });

  it.skipIf(process.platform === 'win32')(
    'applies a saved profile to the real PTY and returns the xterm appearance snapshot',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'axterm-terminal-profile-'));
      directories.push(directory);
      const runtime = await launch();
      const token = await login(runtime);
      const headers = {
        Authorization: `Bearer ${token}`,
        'X-Runtime-Generation': runtime.metadata.generation,
        'Content-Type': 'application/json',
      };
      const profileResponse = await fetch(`${runtime.baseUrl}/api/v1/terminal-profiles`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Profile fixture',
          shell: '/bin/sh',
          shellArgs: [
            '-c',
            'printf "PROFILE=%s|%s|%s|%s\\n" "$PROFILE_MARKER" "$LANG" "$TERM" "$PWD"; sleep 1',
          ],
          cwd: directory,
          loginShell: false,
          env: { PROFILE_MARKER: 'active' },
          term: 'screen-256color',
          lang: 'C.UTF-8',
          fontFamily: 'Iosevka, monospace',
          fontSize: 18,
          lineHeight: 1.3,
          cursorStyle: 'bar',
          cursorBlink: true,
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
        }),
      });
      expect(profileResponse.status).toBe(201);
      const profile = terminalProfileSchema.parse(await profileResponse.json());
      const patchResponse = await fetch(
        `${runtime.baseUrl}/api/v1/terminal-profiles/${profile.id}`,
        {
          method: 'PATCH',
          headers: { ...headers, 'If-Match': `"v${profile.version}"` },
          body: JSON.stringify({ fontSize: 19 }),
        },
      );
      expect(patchResponse.status).toBe(200);
      const updatedProfile = terminalProfileSchema.parse(await patchResponse.json());
      expect(updatedProfile).toMatchObject({
        shell: '/bin/sh',
        shellArgs: profile.shellArgs,
        cwd: directory,
        env: { PROFILE_MARKER: 'active' },
        fontSize: 19,
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
      });
      const terminalResponse = await fetch(`${runtime.baseUrl}/api/v1/terminals`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          kind: 'local',
          profileId: updatedProfile.id,
          cols: 100,
          rows: 30,
        }),
      });
      expect(terminalResponse.status).toBe(201);
      const terminal = terminalSessionSchema.parse(await terminalResponse.json());
      expect(terminal).toMatchObject({
        profileId: updatedProfile.id,
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

      const url = new URL(`/api/v1/terminals/${terminal.id}/stream`, runtime.baseUrl);
      url.protocol = 'ws:';
      const socket = new WebSocket(
        url,
        ['terminal.v1', `terminal-client.${randomUUID()}`, `auth.${token}`],
        { origin: runtime.baseUrl },
      );
      const output = await new Promise<string>((resolve, reject) => {
        let received = '';
        const timer = setTimeout(
          () => reject(new Error(`Profile output timed out: ${received}`)),
          5_000,
        );
        socket.on('message', (data, binary) => {
          if (!binary) return;
          received += Buffer.from(data as Buffer).toString('utf8');
          if (received.includes('PROFILE=active|C.UTF-8|screen-256color|')) {
            clearTimeout(timer);
            resolve(received);
          }
        });
        socket.on('error', reject);
      });
      expect(output).toContain(`PROFILE=active|C.UTF-8|screen-256color|${directory}`);
      socket.close();
      await fetch(`${runtime.baseUrl}/api/v1/terminals/${terminal.id}`, {
        method: 'DELETE',
        headers,
      });
    },
  );

  it('replays persistent SSE events and explicitly resets an invalid cursor', async () => {
    const runtime = await launch();
    const token = await login(runtime);
    const headers = {
      Authorization: `Bearer ${token}`,
      'X-Runtime-Generation': runtime.metadata.generation,
    };
    const created = await fetch(`${runtime.baseUrl}/api/v1/host-groups`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'events', sortOrder: 0 }),
    });
    expect(created.status).toBe(201);
    const replay = await fetch(`${runtime.baseUrl}/api/v1/events/domain?after=0`, { headers });
    const first = await readSseEvent(replay);
    expect(first).toMatchObject({ event: 'host-group.created', id: '1' });
    await replay.body?.cancel();

    const invalid = await fetch(`${runtime.baseUrl}/api/v1/events/domain?after=999999`, {
      headers,
    });
    const reset = await readSseEvent(invalid);
    expect(reset.event).toBe('cursor.invalid');
    expect(JSON.parse(reset.data)).toMatchObject({ code: 'EVENT_CURSOR_INVALID', latest: 1 });
    await invalid.body?.cancel();
  });

  it('returns typed errors without reflecting malformed input', async () => {
    const runtime = await launch();
    const token = await login(runtime);
    const response = await fetch(`${runtime.baseUrl}/api/v1/hosts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Runtime-Generation': runtime.metadata.generation,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'secret-marker', port: -1 }),
    });
    expect(response.status).toBe(400);
    const value = problemSchema.parse(await response.json());
    expect(value.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(value)).not.toContain('secret-marker');
  });
});

async function readSseEvent(response: Response) {
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n\n')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true }).replace(/\r/g, '');
  }
  reader.releaseLock();
  const block = text.slice(0, text.indexOf('\n\n'));
  const lines = Object.fromEntries(
    block.split('\n').map((line) => {
      const separator = line.indexOf(':');
      return [line.slice(0, separator), line.slice(separator + 1).trim()];
    }),
  );
  return { event: lines.event, id: lines.id, data: lines.data ?? '' };
}
