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
import { createRuntimeClient } from '../../packages/client/src/api-client';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';
import { piSseCommand, piSseEnd, piSseText } from '../fixtures/pi-sse';

const { Server: SshServer } = createRequire(resolve('packages/runtime/package.json'))(
  'ssh2',
) as typeof Ssh2;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

describe('assistant selected workspace REST and real SSH boundary', () => {
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
    const hostToken = randomUUID();
    const host = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ secret: 'WORKSPACE_API_KEY_CANARY' }));
    });
    host.listen(0, '127.0.0.1');
    await once(host, 'listening');
    const hostAddress = host.address();
    if (!hostAddress || typeof hostAddress === 'string') throw new Error('Missing Vault fixture');
    cleanup.push(async () => {
      host.close();
      host.closeAllConnections();
      await once(host, 'close');
    });
    const runtime = await startRuntime({
      generation: randomUUID(),
      appVersion: '0.10.0',
      mode: 'headless',
      hostCapabilityUrl: `http://127.0.0.1:${hostAddress.port}`,
      hostCapabilityToken: hostToken,
    });
    cleanup.push(() => runtime.close());
    const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    cleanup.push(async () => client.dispose());
    const profile = await client.createTerminalProfile({
      name: 'local workspace',
      cwd: home,
      shell: '/bin/bash',
      loginShell: false,
    });
    const local = await client.createTerminal({
      kind: 'local',
      cols: 80,
      rows: 24,
      profileId: profile.id,
    });
    expect(await client.aiWorkspace(local.id)).toMatchObject({
      workspaceDirectory: home,
      commandDirectory: home,
      execution: 'local',
    });
    const provider = await client.createAiProvider({
      name: 'fixture',
      baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
      credentialRef: 'fixture-vault',
      enabled: true,
    });
    const model = await client.createAiModel({
      providerId: provider.id,
      name: 'fixture',
      model: 'fixture-model',
      capabilities: ['chat', 'tools'],
    });
    const conversation = await client.createAiConversation({
      name: 'chat',
      modelId: model.id,
      terminalId: local.id,
    });
    expect(conversation.useCase).toBe('chat');
    const localRun = await client.startAi({
      modelId: model.id,
      useCase: 'chat',
      prompt: 'hello WORKSPACE_API_KEY_CANARY',
      context: '',
      terminalId: local.id,
      conversationId: conversation.id,
    });
    await vi.waitFor(async () =>
      expect(await client.aiRun(localRun.id)).toMatchObject({
        state: 'succeeded',
        result: 'direct chat ready',
      }),
    );
    expect(requests[0]).toContain(home);
    expect(requests[0]).not.toContain('WORKSPACE_API_KEY_CANARY');
    const connection = await client.createQuickConnection(
      { hostname: '127.0.0.1', port: address.port, username: 'fixture', authType: 'password' },
      'fixture-only',
    );
    await vi.waitFor(async () =>
      expect((await client.interactions())[0]?.kind).toBe('unknownHostKey'),
    );
    await client.respondInteraction((await client.interactions())[0]!.id, {
      accepted: true,
      remember: false,
    });
    await vi.waitFor(async () =>
      expect((await client.connections()).find(({ id }) => id === connection.id)?.state).toBe(
        'ready',
      ),
    );
    const terminal = await client.createTerminal({
      kind: 'ssh',
      connectionId: connection.id,
      cols: 80,
      rows: 24,
    });
    await vi.waitFor(async () =>
      expect(await client.aiWorkspace(terminal.id)).toMatchObject({
        workspaceDirectory: join(home, '.axterm'),
        commandDirectory: remote,
        execution: 'ssh',
        connectionId: connection.id,
      }),
    );
    const probeCount = sshCommands.length;
    expect(sshCommands).toEqual(['printf \'%s\' "${SHELL:-}"']);
    propose = true;
    expect((await client.aiSkills()).map(({ id }) => id)).toEqual([
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
      const guardedRun = await client.startAi({
        ...guarded,
        modelId: model.id,
        prompt: 'guarded request',
        terminalId: terminal.id,
      });
      await vi.waitFor(async () =>
        expect((await client.aiRun(guardedRun.id)).state).toBe('failed'),
      );
      expect(await client.aiToolCalls(guardedRun.id)).toEqual([]);
      expect(JSON.parse(requests.at(-1)!).tools ?? []).toHaveLength(0);
      expect(sshCommands).toHaveLength(probeCount);
    }
    await expect(
      client.startAi({
        modelId: model.id,
        useCase: 'chat',
        prompt: 'direct command',
        terminalId: terminal.id,
        tool: {
          name: 'workspace.exec',
          target: terminal.id,
          args: { command: 'touch approval-marker' },
        },
      }),
    ).rejects.toMatchObject({ status: 412 });
    const remoteChat = await client.createAiConversation({
      name: 'remote chat',
      modelId: model.id,
      terminalId: terminal.id,
    });
    const remoteRun = await client.startAi({
      modelId: model.id,
      mode: 'work',
      useCase: 'chat',
      prompt: 'show current directory',
      context: '',
      terminalId: terminal.id,
      conversationId: remoteChat.id,
    });
    await vi.waitFor(async () =>
      expect((await client.aiRun(remoteRun.id)).state).toBe('waiting_approval'),
    );
    expect(sshCommands).toHaveLength(probeCount);
    await expect(readFile(join(remote, 'approval-marker'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const approval = (await client.aiApprovals()).find((item) => item.runId === remoteRun.id)!;
    const call = (await client.aiToolCalls(remoteRun.id))[0]!;
    expect(call).toMatchObject({
      toolName: 'workspace.exec',
      target: terminal.id,
      args: { workspace: { connectionId: connection.id, commandDirectory: remote } },
    });
    await client.decideApproval(approval.id, 'approve_once', approval.argsHash);
    await vi.waitFor(async () =>
      expect((await client.aiRun(remoteRun.id)).state).toBe('succeeded'),
    );
    expect(sshCommands).toHaveLength(probeCount + 1);
    expect(await readFile(join(remote, 'approval-marker'), 'utf8')).toBe('approved');
    await expect(readFile(join(home, '.axterm', 'approval-marker'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await client.aiConversation(remoteChat.id)).messages.at(-1)?.content).toContain(remote);
    propose = false;
    const followup = await client.startAi({
      modelId: model.id,
      useCase: 'chat',
      prompt: 'explain the result',
      context: '',
      terminalId: terminal.id,
      conversationId: remoteChat.id,
      includeConversationHistory: true,
    });
    await vi.waitFor(async () => expect((await client.aiRun(followup.id)).state).toBe('succeeded'));
    expect(requests.at(-1)).toContain('approved');
    expect(requests.join('')).not.toContain('WORKSPACE_API_KEY_CANARY');
    await client.closeConnection(connection.id);
    await expect(client.aiWorkspace(terminal.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});
