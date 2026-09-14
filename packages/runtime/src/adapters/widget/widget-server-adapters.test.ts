import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Client as FtpClient } from 'basic-ftp';
import { Client as SshClient, type SFTPWrapper } from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import { ElectermLocalFtpServer } from './electerm-local-ftp-server';
import { NodeLocalSshServer } from './node-local-ssh-server';

const roots: string[] = [];
const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(stops.splice(0).map((stop) => stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local server Widget adapters', () => {
  it('starts repeated ephemeral SSH servers with parseable host keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ssh-widget-keys-'));
    roots.push(root);
    for (let index = 0; index < 128; index += 1) {
      const server = await new NodeLocalSshServer().start({
        rootPath: root,
        host: '127.0.0.1',
        port: 0,
        username: 'tester',
        password: 'widget-password',
      });
      await server.stop();
    }
  });

  it('runs an authenticated FTP server with a bounded passive range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-widget-'));
    const outside = await mkdtemp(join(tmpdir(), 'axterm-ftp-widget-outside-'));
    roots.push(root);
    roots.push(outside);
    await writeFile(join(root, 'ftp.txt'), 'ftp-widget');
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await symlink(outside, join(root, 'escape'));
    const server = await new ElectermLocalFtpServer().start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: false,
      username: 'ftpuser',
      password: 'widget-password',
      passivePortStart: 50_320,
      passivePortEnd: 50_327,
    });
    stops.push(server.stop);
    const denied = new FtpClient(5_000);
    await expect(
      denied.access({
        host: '127.0.0.1',
        port: server.port,
        user: 'ftpuser',
        password: 'wrong-password',
      }),
    ).rejects.toThrow();
    denied.close();

    const client = new FtpClient(5_000);
    await client.access({
      host: '127.0.0.1',
      port: server.port,
      user: 'ftpuser',
      password: 'widget-password',
    });
    expect((await client.list()).map(({ name }) => name)).toContain('ftp.txt');
    await expect(client.cd('escape')).rejects.toThrow();
    await client.uploadFrom(Readable.from(Buffer.from('uploaded')), 'uploaded.txt');
    client.close();
    expect(await readFile(join(root, 'uploaded.txt'), 'utf8')).toBe('uploaded');
  });

  it('runs password SSH exec and SFTP inside the granted root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ssh-widget-'));
    const outside = await mkdtemp(join(tmpdir(), 'axterm-ssh-widget-outside-'));
    roots.push(root);
    roots.push(outside);
    await writeFile(join(root, 'ssh.txt'), 'ssh-widget');
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await symlink(outside, join(root, 'escape'));
    const server = await new NodeLocalSshServer().start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      username: 'tester',
      password: 'widget-password',
    });
    stops.push(server.stop);
    await expect(connectSsh(server.port, 'tester', 'wrong-password')).rejects.toThrow();

    const client = await connectSsh(server.port, 'tester', 'widget-password');
    const output = await execSsh(client, 'pwd');
    expect(output.trim()).toBe(await realpath(root));
    const sftp = await openSftp(client);
    expect((await listSftp(sftp, '/')).map(({ filename }) => filename)).toContain('ssh.txt');
    await expect(listSftp(sftp, '/escape')).rejects.toThrow();
    await writeSftp(sftp, '/uploaded.txt', 'uploaded-over-sftp');
    expect(await readFile(join(root, 'uploaded.txt'), 'utf8')).toBe('uploaded-over-sftp');
    sftp.end();
    client.end();
  });
});

function connectSsh(port: number, username: string, password: string): Promise<SshClient> {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    const timer = setTimeout(() => {
      client.end();
      reject(new Error('SSH connection timed out'));
    }, 5_000);
    client.once('ready', () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    client.connect({
      host: '127.0.0.1',
      port,
      username,
      password,
      readyTimeout: 4_000,
      hostVerifier: () => true,
    });
  });
}

function execSsh(client: SshClient, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.once('error', reject);
      stream.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  });
}

function openSftp(client: SshClient): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) =>
    client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp))),
  );
}

function listSftp(sftp: SFTPWrapper, path: string) {
  return new Promise<Parameters<Parameters<SFTPWrapper['readdir']>[1]>[1]>((resolve, reject) =>
    sftp.readdir(path, (error, entries) => (error ? reject(error) : resolve(entries))),
  );
}

function writeSftp(sftp: SFTPWrapper, path: string, value: string): Promise<void> {
  return new Promise((resolve, reject) =>
    sftp.writeFile(path, value, (error) => (error ? reject(error) : resolve())),
  );
}
