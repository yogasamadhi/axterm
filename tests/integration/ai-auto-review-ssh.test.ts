import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type * as Ssh2 from 'ssh2';
import { afterEach, expect, it, vi } from 'vitest';
import { createRuntimeClient } from '../../packages/client/src/api-client';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';
import { piSseCommand, piSseText, piSseEnd } from '../fixtures/pi-sse';

const shell = process.platform === 'win32' ? process.env.AXTERM_TEST_POSIX_SHELL : '/bin/sh';
const { Server } = createRequire(resolve('packages/runtime/package.json'))('ssh2') as typeof Ssh2;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
it.skipIf(!shell || !existsSync(shell))(
  'reviews and resumes the native Pi loop over real SSH exec streams in an isolated directory',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-auto-ssh-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    const remote = join(root, 'remote');
    await mkdir(remote);
    const remoteCwd =
      process.platform === 'win32'
        ? remote
            .replace(/^([A-Za-z]):/u, (_, drive: string) => `/${drive.toLowerCase()}`)
            .replaceAll('\\', '/')
        : remote;
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const wire: string[] = [];
    const ssh = new Server(
      { hostKeys: [privateKey.export({ type: 'sec1', format: 'pem' })] },
      (peer) => {
        peer.on('error', () => {});
        peer.on('authentication', (auth) =>
          auth.method === 'password' &&
          auth.username === 'fixture' &&
          auth.password === 'fixture-only'
            ? auth.accept()
            : auth.reject(['password']),
        );
        peer.on('ready', () =>
          peer.on('session', (accept) => {
            const session = accept();
            session.on('pty', (acceptPty) => acceptPty?.());
            session.on('env', (acceptEnv) => acceptEnv?.());
            session.on('shell', (acceptShell) => {
              const stream = acceptShell();
              const timer = setTimeout(
                () => stream.write(`\x1b]7;file://${encodeURI(remoteCwd)}\x07`),
                20,
              );
              stream.on('data', () => {});
              stream.once('close', () => clearTimeout(timer));
            });
            session.on('exec', (acceptExec, _reject, info) => {
              wire.push(info.command);
              const stream = acceptExec();
              const child = execFile(
                shell!,
                ['-c', info.command],
                { cwd: remote, timeout: 3000, maxBuffer: 128 * 1024, windowsHide: true },
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
    const sshAddress = ssh.address();
    if (!sshAddress || typeof sshAddress === 'string') throw new Error('No SSH listener');
    cleanup.push(() => new Promise<void>((done) => ssh.close(() => done())));
    const commands = ['pwd', 'whoami', 'hostname', 'echo ssh-safe>marker', 'rm marker'];
    let turns = 0;
    const modelServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        const reviewing = String(JSON.parse(body).messages[0]?.content).startsWith(
          'You review one command',
        );
        const command = commands[turns];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          reviewing
            ? piSseText(
                'openai-chat',
                JSON.stringify({
                  outcome: 'allow',
                  risk_level: 'medium',
                  user_authorization: 'high',
                  rationale: 'Create the requested remote marker.',
                }),
              ) + piSseEnd('openai-chat')
            : command
              ? piSseCommand(command).replaceAll('call_workspace', `call_ssh_${++turns}`)
              : piSseText('openai-chat', 'Remote task finished') + piSseEnd('openai-chat'),
        );
      });
    });
    modelServer.listen(0, '127.0.0.1');
    await once(modelServer, 'listening');
    const modelAddress = modelServer.address();
    if (!modelAddress || typeof modelAddress === 'string') throw new Error('No model listener');
    cleanup.push(async () => {
      const closed = once(modelServer, 'close');
      modelServer.close();
      modelServer.closeAllConnections();
      await closed;
    });
    const host = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ secret: 'SSH_MODEL_KEY_CANARY' }));
    });
    host.listen(0, '127.0.0.1');
    await once(host, 'listening');
    const hostAddress = host.address();
    if (!hostAddress || typeof hostAddress === 'string') throw new Error('No host listener');
    cleanup.push(async () => {
      const closed = once(host, 'close');
      host.close();
      host.closeAllConnections();
      await closed;
    });
    const runtime = await startRuntime({
      generation: randomUUID(),
      appVersion: '0.10.0',
      mode: 'headless',
      hostCapabilityUrl: `http://127.0.0.1:${hostAddress.port}`,
      hostCapabilityToken: randomUUID(),
    });
    cleanup.push(() => runtime.close());
    const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    cleanup.push(async () => client.dispose());
    const connection = await client.createQuickConnection(
      { hostname: '127.0.0.1', port: sshAddress.port, username: 'fixture', authType: 'password' },
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
      expect((await client.connections()).find((item) => item.id === connection.id)?.state).toBe(
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
        commandDirectory: remoteCwd,
        execution: 'ssh',
      }),
    );
    const provider = await client.createAiProvider({
      name: 'fixture',
      baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
      credentialRef: 'fixture-model',
      enabled: true,
    });
    const model = await client.createAiModel({
      providerId: provider.id,
      name: 'fixture',
      model: 'fixture-model',
      capabilities: ['chat', 'tools'],
    });
    const run = await client.startAi({
      modelId: model.id,
      terminalId: terminal.id,
      mode: 'work',
      useCase: 'chat',
      prompt:
        'Inspect the remote host, create marker with ssh-safe, then delete marker and finish.',
    });
    await vi.waitFor(async () =>
      expect((await client.aiRun(run.id)).state).toBe('waiting_approval'),
    );
    expect(
      (await client.aiToolCalls(run.id)).filter((call) => call.state === 'succeeded'),
    ).toHaveLength(4);
    await access(join(remote, 'marker'));
    await expect(access(join(root, '.axterm', 'marker'))).rejects.toMatchObject({ code: 'ENOENT' });
    const approval = (await client.aiApprovals()).find((item) => item.runId === run.id)!;
    await client.decideApproval(approval.id, 'approve_once', approval.argsHash);
    await vi.waitFor(async () =>
      expect(await client.aiRun(run.id)).toMatchObject({
        state: 'succeeded',
        result: 'Remote task finished',
      }),
    );
    await expect(access(join(remote, 'marker'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await client.aiToolCalls(run.id)).map((call) => call.approvalSource)).toEqual([
      'automatic',
      'automatic',
      'automatic',
      'automatic',
      'user',
    ]);
    expect(wire.slice(1)).toHaveLength(5);
    expect(wire.slice(1).every((command) => command.startsWith(`cd -- '${remoteCwd}' && (`))).toBe(
      true,
    );
  },
);
