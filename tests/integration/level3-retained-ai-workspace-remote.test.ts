import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type * as Ssh2 from 'ssh2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiRemoteProfile } from '../fixtures/level3-ai-remote-profile.ts';
import * as Terminals from '../../packages/plugins/terminals/src/client/index.ts';
import * as Connections from '../../packages/plugins/connections/src/client/index.ts';
import { piSseCommand, piSseEnd, piSseText } from '../fixtures/pi-sse.ts';

const { Server: SshServer } = createRequire(resolve('packages/plugins/connections/package.json'))(
  'ssh2',
) as typeof Ssh2;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

describe('assistant selected workspace authenticated Remote and real SSH boundary', () => {
  it('chats directly, proposes a bound SSH command, requires approval and keeps local files separate', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'axterm-ai-workspace-http-')));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const home = join(root, 'local-home');
    const remote = join(root, "remote space's directory");
    await mkdir(home);
    await mkdir(remote);
    vi.stubEnv('HOME', home);
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const sshCommands: string[] = [];
    const ssh = new SshServer(
      { hostKeys: [privateKey.export({ type: 'sec1', format: 'pem' })] },
      (peer) => {
        peer.on('error', () => {});
        peer.on('authentication', (auth) => {
          if (
            auth.method === 'password' &&
            auth.username === 'fixture' &&
            auth.password === 'fixture-only'
          )
            auth.accept();
          else auth.reject(['password']);
        });
        peer.on('ready', () =>
          peer.on('session', (accept) => {
            const session = accept();
            session.on('pty', (acceptPty) => acceptPty?.());
            session.on('env', (acceptEnv) => acceptEnv?.());
            session.on('shell', (acceptShell) => {
              const stream = acceptShell();
              const timer = setTimeout(
                () => stream.write(`\x1b]7;file://${encodeURI(remote)}\x07`),
                50,
              );
              stream.on('data', () => {});
              stream.once('close', () => clearTimeout(timer));
            });
            session.on('exec', (acceptExec, _reject, info) => {
              sshCommands.push(info.command);
              const stream = acceptExec();
              const child = execFile(
                '/bin/sh',
                ['-c', info.command],
                {
                  cwd: remote,
                  timeout: 3000,
                  maxBuffer: 128 * 1024,
                  env: { ...process.env, AI_KEY_FIXTURE: 'WORKSPACE_API_KEY_CANARY' },
                },
                (error, stdout, stderr) => {
                  stream.write(stdout);
                  stream.stderr.write(stderr);
                  stream.exit(error ? 1 : 0);
                  stream.end();
                },
              );
              stream.once('close', () => child.kill());
            });
          }),
        );
      },
    );
    ssh.listen(0, '127.0.0.1');
    await once(ssh, 'listening');
    const address = ssh.address();
    if (!address || typeof address === 'string') throw new Error('Missing SSH listener');
    cleanup.push(() => new Promise<void>((done) => ssh.close(() => done())));
    const requests: string[] = [];
    let propose = false;
    const modelServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        requests.push(body);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          propose &&
            !JSON.parse(body).messages.some((message: { role: string }) => message.role === 'tool')
            ? piSseCommand(
                'pwd; printf approved > approval-marker; cat approval-marker; printf "$AI_KEY_FIXTURE"',
              )
            : piSseText(
                'openai-chat',
                propose
                  ? String(
                      JSON.parse(body).messages.find(
                        (message: { role: string }) => message.role === 'tool',
                      )?.content ?? 'direct chat ready',
                    )
                  : 'direct chat ready',
              ) + piSseEnd('openai-chat'),
        );
      });
    });
    modelServer.listen(0, '127.0.0.1');
    await once(modelServer, 'listening');
    const modelAddress = modelServer.address();
    if (!modelAddress || typeof modelAddress === 'string')
      throw new Error('Missing model listener');
    cleanup.push(async () => {
      modelServer.close();
      modelServer.closeAllConnections();
      await once(modelServer, 'close');
    });
    const f = await aiRemoteProfile(home);
    cleanup.push(f.close);
    await f.client.plugin(Terminals);
    await f.client.plugin(Connections);
    await vi.waitFor(() => {
      expect(f.client.terminalsModel.getSnapshot().status).toBe('ready');
      expect(f.client.terminalFactsModel.getSnapshot().status).toBe('ready');
      expect(f.client.connectionsModel.getSnapshot().status).toBe('ready');
    });
    const connections = () => {
      const state = f.client.connectionsModel.getSnapshot();
      if (state.status !== 'ready') throw Error('Connections baseline unavailable');
      return state.baseline;
    };
    const profile = await f.client.terminalFactsModel.createTerminalProfile(randomUUID(), {
      name: 'local workspace',
      cwd: home,
      shell: '/bin/bash',
      loginShell: false,
    });
    const local = await f.client.terminalsModel.create({
      kind: 'local',
      cols: 80,
      rows: 24,
      profileId: profile.ids[0]!,
    });
    expect(await f.model.workspace(local.id)).toMatchObject({
      workspaceDirectory: home,
      commandDirectory: home,
      execution: 'local',
    });
    const selected = await f.selection(
      `http://127.0.0.1:${modelAddress.port}/v1`,
      'openai-chat',
      'WORKSPACE_API_KEY_CANARY',
      'Terminal expert',
      ['chat', 'tools'],
    );
    const modelId = selected.modelId;
    const conversation = await f.model.createConversation(randomUUID(), {
      name: 'chat',
      modelId: modelId,
      terminalId: local.id,
    });
    expect((await f.model.getConversation(conversation.ids[0]!)).useCase).toBe('chat');
    const localRun = await f.model.startRun(randomUUID(), {
      modelId: modelId,
      useCase: 'chat',
      prompt: 'hello WORKSPACE_API_KEY_CANARY',
      context: '',
      terminalId: local.id,
      conversationId: conversation.ids[0]!,
    });
    await vi.waitFor(async () =>
      expect(await f.model.getRun(localRun.id)).toMatchObject({
        state: 'succeeded',
        result: 'direct chat ready',
      }),
    );
    expect(requests[0]).toContain(home);
    expect(requests[0]).not.toContain('WORKSPACE_API_KEY_CANARY');
    const connection = await f.client.connectionsModel.createConnection(randomUUID(), {
      target: {
        hostname: '127.0.0.1',
        port: address.port,
        username: 'fixture',
        authType: 'password',
      },
      temporarySecret: 'fixture-only',
    });
    await vi.waitFor(async () =>
      expect(connections().interactions[0]?.kind).toBe('unknownHostKey'),
    );
    await f.client.connectionsModel.respondInteraction(connections().interactions[0]!.id, {
      accepted: true,
      remember: false,
    });
    await vi.waitFor(async () =>
      expect(connections().connections.find(({ id }) => id === connection.id)?.state).toBe('ready'),
    );
    const terminal = await f.client.terminalsModel.create({
      kind: 'ssh',
      connectionId: connection.id,
      cols: 80,
      rows: 24,
    });
    await vi.waitFor(async () =>
      expect(await f.model.workspace(terminal.id)).toMatchObject({
        workspaceDirectory: join(home, 'data-v2', 'ai-remote'),
        commandDirectory: remote,
        execution: 'ssh',
        connectionId: connection.id,
      }),
    );
    const probeCount = sshCommands.length;
    expect(sshCommands).toEqual(['printf \'%s\' "${SHELL:-}"']);
    propose = true;
    expect((await f.model.skills()).map(({ id }) => id)).toEqual([
      'diagnose',
      'explain-command',
      'explain-output',
      'generate-command',
    ]);
    // A hostile provider cannot turn chat or a reply-only skill into execution.
    for (const guarded of [
      { useCase: 'chat' as const },
      { useCase: 'chat' as const, mode: 'chat' as const },
      { useCase: 'explainCommand' as const, mode: 'work' as const },
      { useCase: 'explainOutput' as const, mode: 'work' as const },
      { useCase: 'generateCommand' as const, mode: 'work' as const },
    ]) {
      const guardedRun = await f.model.startRun(randomUUID(), {
        ...guarded,
        modelId: modelId,
        prompt: 'guarded request',
        terminalId: terminal.id,
      });
      await vi.waitFor(async () =>
        expect((await f.model.getRun(guardedRun.id)).state).toBe('failed'),
      );
      expect((await f.model.getTools(guardedRun.id, { limit: 50 })).tools).toEqual([]);
      // ADR091 adds a separately approved plugin-management tool in chat; it
      // never grants workspace execution or applies its automatic-review exception.
      const advertised = (JSON.parse(requests.at(-1)!).tools ?? []).map(
        (tool: { function: { name: string } }) => tool.function.name,
      );
      expect(advertised).toEqual(guarded.useCase === 'chat' ? ['plugin_manager'] : []);
      expect(advertised).not.toContain('workspace_exec');
      expect(sshCommands).toHaveLength(probeCount);
    }
    await expect(
      f.model.startRun(randomUUID(), {
        modelId: modelId,
        useCase: 'chat',
        prompt: 'direct command',
        terminalId: terminal.id,
        tool: {
          name: 'workspace.exec',
          target: terminal.id,
          args: { command: 'touch approval-marker' },
        },
      }),
    ).rejects.toMatchObject({ code: 'ai/failure', details: { reason: 'precondition' } });
    const remoteChat = await f.model.createConversation(randomUUID(), {
      name: 'remote chat',
      modelId: modelId,
      terminalId: terminal.id,
    });
    const remoteRun = await f.model.startRun(randomUUID(), {
      modelId: modelId,
      mode: 'work',
      useCase: 'chat',
      prompt: 'show current directory',
      context: '',
      terminalId: terminal.id,
      conversationId: remoteChat.ids[0]!,
    });
    await vi.waitFor(async () =>
      expect((await f.model.getRun(remoteRun.id)).state).toBe('waiting_approval'),
    );
    expect(sshCommands).toHaveLength(probeCount);
    await expect(readFile(join(remote, 'approval-marker'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const approval = (await f.model.getTools(remoteRun.id, { limit: 50 })).approvals.find(
      (item) => item.runId === remoteRun.id,
    )!;
    const call = (await f.model.getTools(remoteRun.id, { limit: 50 })).tools[0]!;
    expect(call).toMatchObject({
      toolName: 'workspace.exec',
      target: terminal.id,
      args: { workspace: { connectionId: connection.id, commandDirectory: remote } },
    });
    await f.model.decideApproval(randomUUID(), approval.id, {
      decision: 'approve_once',
      argsHash: approval.argsHash,
    });
    await vi.waitFor(async () =>
      expect((await f.model.getRun(remoteRun.id)).state).toBe('succeeded'),
    );
    expect(sshCommands).toHaveLength(probeCount + 1);
    expect(await readFile(join(remote, 'approval-marker'), 'utf8')).toBe('approved');
    await expect(
      readFile(join(home, 'data-v2', 'ai-remote', 'approval-marker')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      (await f.model.getMessages(remoteChat.ids[0]!, { limit: 50 })).messages.at(-1)?.content,
    ).toContain(remote);
    propose = false;
    const followup = await f.model.startRun(randomUUID(), {
      modelId: modelId,
      useCase: 'chat',
      prompt: 'explain the result',
      context: '',
      terminalId: terminal.id,
      conversationId: remoteChat.ids[0]!,
      includeConversationHistory: true,
    });
    await vi.waitFor(async () =>
      expect((await f.model.getRun(followup.id)).state).toBe('succeeded'),
    );
    expect(requests.at(-1)).toContain('approved');
    expect(requests.join('')).not.toContain('WORKSPACE_API_KEY_CANARY');
    await f.client.connectionsModel.closeConnection(connection.id);
    await expect(f.model.workspace(terminal.id)).rejects.toMatchObject({
      code: 'ai/failure',
      details: { reason: 'precondition' },
    });
  });
});
