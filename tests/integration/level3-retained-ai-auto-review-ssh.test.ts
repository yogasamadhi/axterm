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
import { aiRemoteProfile } from '../fixtures/level3-ai-remote-profile.ts';
import * as Terminals from '../../packages/plugins/terminals/src/client/index.ts';
import * as Connections from '../../packages/plugins/connections/src/client/index.ts';
import { piSseCommand, piSseText, piSseEnd } from '../fixtures/pi-sse.ts';

const shell = process.platform === 'win32' ? process.env.AXTERM_TEST_POSIX_SHELL : '/bin/sh';
const { Server } = createRequire(resolve('packages/plugins/connections/package.json'))(
  'ssh2',
) as typeof Ssh2;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
it.skipIf(!shell || !existsSync(shell))(
  'executes the native Pi loop directly over real SSH exec streams in an isolated directory',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-auto-ssh-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    const remote = join(root, 'remote');
    await mkdir(remote);
    const remoteNext = join(remote, 'next remote dir');
    await mkdir(remoteNext);
    const remotePath = (directory: string) =>
      process.platform === 'win32'
        ? directory
            .replace(/^([A-Za-z]):/u, (_, drive: string) => `/${drive.toLowerCase()}`)
            .replaceAll('\\', '/')
        : directory;
    const remoteCwd = remotePath(remote);
    const nextCwd = remotePath(remoteNext);
    let setRemoteDirectory: ((directory: string) => void) | undefined;
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
              setRemoteDirectory = (directory) => {
                stream.write(`\x1b]7;file://${encodeURI(directory)}\x07`);
              };
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
                  if (wire.length === 2) setRemoteDirectory?.(nextCwd);
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
    const f = await aiRemoteProfile(root);
    cleanup.push(f.close);
    await f.client.plugin(Terminals);
    await f.client.plugin(Connections);
    await vi.waitFor(() => {
      expect(f.client.terminalsModel.getSnapshot().status).toBe('ready');
      expect(f.client.connectionsModel.getSnapshot().status).toBe('ready');
    });
    const connections = () => {
      const state = f.client.connectionsModel.getSnapshot();
      if (state.status !== 'ready') throw Error('Connections baseline unavailable');
      return state.baseline;
    };
    const connection = await f.client.connectionsModel.createConnection(randomUUID(), {
      target: {
        hostname: '127.0.0.1',
        port: sshAddress.port,
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
      expect(connections().connections.find((item) => item.id === connection.id)?.state).toBe(
        'ready',
      ),
    );
    const terminal = await f.client.terminalsModel.create({
      kind: 'ssh',
      connectionId: connection.id,
      cols: 80,
      rows: 24,
    });
    await vi.waitFor(async () =>
      expect(await f.model.workspace(terminal.id)).toMatchObject({
        commandDirectory: remoteCwd,
        execution: 'ssh',
      }),
    );
    const selected = await f.selection(
      `http://127.0.0.1:${modelAddress.port}/v1`,
      'openai-chat',
      'SSH_MODEL_KEY_CANARY',
      'Terminal expert',
      ['chat', 'tools'],
    );
    const modelId = selected.modelId;
    const localWorkspace = (await f.model.workspace(terminal.id)).workspaceDirectory;
    const run = await f.model.startRun(randomUUID(), {
      modelId: modelId,
      terminalId: terminal.id,
      mode: 'work',
      useCase: 'chat',
      prompt:
        'Inspect the remote host, create marker with ssh-safe, then delete marker and finish.',
    });
    await expect(access(join(root, 'data-v2', 'ai-remote', 'marker'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await vi.waitFor(async () =>
      expect(await f.model.getRun(run.id)).toMatchObject({
        state: 'succeeded',
        result: 'Remote task finished',
      }),
    );
    await expect(access(join(remote, 'marker'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(remoteNext, 'marker'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.model.workspace(terminal.id)).toMatchObject({
      workspaceDirectory: localWorkspace,
      commandDirectory: nextCwd,
    });
    expect((await f.model.getTools(run.id, { limit: 50 })).approvals).toEqual([]);
    expect(
      (await f.model.getTools(run.id, { limit: 50 })).tools.every(
        (call) => call.state === 'succeeded' && call.review === undefined,
      ),
    ).toBe(true);
    expect(
      (await f.model.getTools(run.id, { limit: 50 })).tools.map((call) => call.approvalSource),
    ).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(wire.slice(1)).toHaveLength(5);
    expect(wire[1]!.startsWith(`cd -- '${remoteCwd}' && (`)).toBe(true);
    expect(wire.slice(2).every((command) => command.startsWith(`cd -- '${nextCwd}' && (`))).toBe(
      true,
    );
    const calls = (await f.model.getTools(run.id, { limit: 50 })).tools;
    expect(
      calls.map((call) => (call.args.workspace as { commandDirectory: string }).commandDirectory),
    ).toEqual([remoteCwd, nextCwd, nextCwd, nextCwd, nextCwd]);
  },
);
