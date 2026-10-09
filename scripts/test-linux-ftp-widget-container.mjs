import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { connect } from 'node:net';
import { EOL, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { clearTimeout, setTimeout } from 'node:timers';
import { NodeLocalFtpServer } from '../packages/runtime/src/adapters/widget/node-local-ftp-server.ts';

if (process.platform !== 'linux')
  throw new Error('The Linux FTP Widget container smoke must run under Linux.');

const expectedArchitecture = process.env.AXTERM_LINUX_FTP_EXPECT_ARCH;
if (expectedArchitecture && process.arch !== expectedArchitecture) {
  throw new Error(
    `Linux FTP Widget container architecture mismatch: expected ${expectedArchitecture}, got ${process.arch}.`,
  );
}

const runtimeRequire = createRequire(new URL('../packages/runtime/package.json', import.meta.url));
const { Client: FtpClient } = runtimeRequire('basic-ftp');
const root = await mkdtemp(join(tmpdir(), 'axterm-linux-ftp-root-'));
const transfer = await mkdtemp(join(tmpdir(), 'axterm-linux-ftp-transfer-'));
const payload = Buffer.concat([Buffer.from([0, 255, 13, 10]), Buffer.alloc(8_192, 0xa5)]);
const client = new FtpClient(10_000);
const denied = new FtpClient(10_000);
let server;

try {
  await writeFile(join(root, 'listed.txt'), 'linux-ftp-listing');
  server = await new NodeLocalFtpServer().start({
    rootPath: root,
    host: '127.0.0.1',
    port: 0,
    anonymous: false,
    username: 'linux-ftp-user',
    password: 'linux-session-only',
    passivePortStart: 50_360,
    passivePortEnd: 50_367,
  });
  await client.access({
    host: '127.0.0.1',
    port: server.port,
    user: 'linux-ftp-user',
    password: 'linux-session-only',
    secure: false,
  });
  const listed = await client.list();
  if (!listed.some((entry) => entry.name === 'listed.txt'))
    throw new Error('FTP list did not contain the seeded file.');

  const largeDirectory = join(root, 'large');
  await mkdir(largeDirectory);
  for (let index = 0; index <= 1_000; index += 1) {
    await writeFile(join(largeDirectory, `entry-${String(index).padStart(4, '0')}.txt`), 'x');
  }
  for (const verb of ['LIST', 'NLST', 'MLSD']) {
    await client.send('PASV');
    await assert.rejects(client.send(`${verb} large`), (error) => error?.code === 550);
    assert.equal((await client.send('NOOP')).code, 200);
  }
  await rename(largeDirectory, join(root, 'moved'));
  await unlink(join(root, 'moved', 'entry-1000.txt'));
  assert.equal((await client.list('moved')).length, 1_000);

  await client.uploadFrom(Readable.from(payload), 'linux-upload.bin');
  if (!(await readFile(join(root, 'linux-upload.bin'))).equals(payload))
    throw new Error('FTP upload bytes differ.');

  const downloaded = join(transfer, 'linux-download.bin');
  await client.downloadTo(downloaded, 'linux-upload.bin');
  if (!(await readFile(downloaded)).equals(payload)) throw new Error('FTP download bytes differ.');

  await assertAsciiRest(server.port, root);

  await client.uploadFrom(Readable.from(Buffer.from('linux-ftp-replacement')), 'rename-stage.txt');
  await client.rename('rename-stage.txt', 'listed.txt');
  if ((await readFile(join(root, 'listed.txt'), 'utf8')) !== 'linux-ftp-replacement')
    throw new Error('FTP rename did not replace the existing regular file.');
  await assert.rejects(lstat(join(root, 'rename-stage.txt')), { code: 'ENOENT' });

  await symlink('listed.txt', join(root, 'file-link'));
  await client.uploadFrom(Readable.from(Buffer.from('must-not-follow-link')), 'link-stage.txt');
  await assert.rejects(
    client.rename('link-stage.txt', 'file-link'),
    (error) => error?.code === 550,
  );
  if ((await readFile(join(root, 'listed.txt'), 'utf8')) !== 'linux-ftp-replacement')
    throw new Error('FTP rename through a symlink changed the original file.');
  if ((await readFile(join(root, 'link-stage.txt'), 'utf8')) !== 'must-not-follow-link')
    throw new Error('FTP rejected rename removed the staged file.');
  await client.remove('link-stage.txt');

  await mkdir(join(root, 'protected-dir'));
  await symlink('protected-dir', join(root, 'dir-link'));
  for (const command of ['DELE file-link', 'RMD dir-link', 'RNFR file-link']) {
    await assert.rejects(client.send(command), (error) => error?.code === 550);
  }
  await assert.rejects(client.send('RNTO renamed-link.txt'), (error) => error?.code === 503);
  if ((await readFile(join(root, 'listed.txt'), 'utf8')) !== 'linux-ftp-replacement')
    throw new Error('FTP mutation through a symlink changed the original file.');
  assert.deepEqual(await readdir(join(root, 'protected-dir')), []);
  assert.deepEqual(await readdir(join(root, 'dir-link')), []);
  assert.equal((await lstat(join(root, 'file-link'))).isSymbolicLink(), true);
  assert.equal((await lstat(join(root, 'dir-link'))).isSymbolicLink(), true);

  let rejected = false;
  try {
    await denied.access({
      host: '127.0.0.1',
      port: server.port,
      user: 'linux-ftp-user',
      password: 'wrong-password',
      secure: false,
    });
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('FTP accepted a wrong password.');

  await assertPendingPassiveAbort(server.port);
  await assertSinglePassivePeer(server.port);
  await assertReadAncestorSwap();

  console.log(`linux-${process.arch}-ftp-rename-overwrite=pass`);
  console.log(`linux-${process.arch}-ftp-symlink-mutation-denial=pass`);
  console.log(`linux-${process.arch}-ftp-read-ancestor-swap-denial=pass`);
  console.log(`linux-${process.arch}-ftp-bounded-list=pass max=1000`);
  console.log(`linux-${process.arch}-ftp-pasv-lifecycle-smoke=pass bytes=${payload.length}`);
} finally {
  client.close();
  denied.close();
  await server?.stop();
  await rm(root, { recursive: true, force: true });
  await rm(transfer, { recursive: true, force: true });
}

async function assertReadAncestorSwap() {
  const granted = await mkdtemp(join(tmpdir(), 'axterm-linux-ftp-read-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'axterm-linux-ftp-read-outside-'));
  const branch = join(granted, 'branch');
  const displaced = join(granted, 'branch-held');
  const client = new FtpClient(10_000);
  const sink = new PassThrough();
  let server;
  try {
    await mkdir(branch);
    await writeFile(join(branch, 'payload.txt'), 'inside');
    await writeFile(join(outside, 'payload.txt'), 'OUTSIDE-SECRET-CONTENTS');
    const handles = [];
    const readOpener = async (path, flags) => {
      await rename(branch, displaced);
      try {
        await symlink(outside, branch);
        const handle = await open(path, flags);
        handles.push(handle);
        return handle;
      } finally {
        await unlink(branch).catch(() => undefined);
        await rename(displaced, branch);
      }
    };
    server = await new NodeLocalFtpServer(undefined, undefined, readOpener).start({
      rootPath: granted,
      host: '127.0.0.1',
      port: 0,
      anonymous: false,
      username: 'linux-ftp-user',
      password: 'linux-session-only',
      passivePortStart: 50_568,
      passivePortEnd: 50_575,
    });
    await client.access({
      host: '127.0.0.1',
      port: server.port,
      user: 'linux-ftp-user',
      password: 'linux-session-only',
      secure: false,
    });
    for (const command of ['SIZE branch/payload.txt', 'MDTM branch/payload.txt']) {
      await assert.rejects(client.send(command), (error) => error?.code === 550);
    }
    const received = [];
    sink.on('data', (bytes) => received.push(bytes));
    await assert.rejects(
      client.downloadTo(sink, 'branch/payload.txt'),
      (error) => error?.code === 550,
    );
    assert.equal(Buffer.concat(received).length, 0);
    assert.equal(handles.length, 3);
    for (const handle of handles) await assert.rejects(handle.stat());
    assert.equal((await client.send('NOOP')).code, 200);
    assert.equal(await readFile(join(branch, 'payload.txt'), 'utf8'), 'inside');
    assert.equal(await readFile(join(outside, 'payload.txt'), 'utf8'), 'OUTSIDE-SECRET-CONTENTS');
  } finally {
    sink.destroy();
    client.close();
    await server?.stop();
    await rm(granted, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

async function assertPendingPassiveAbort(port) {
  const control = await openFtpControl(port);
  const replies = ftpReplyReader(control);
  try {
    await login(replies, control, 'pending-PASV ABOR');
    control.write('PASV\r\n');
    await expectReply(replies, /^227 /u, 'pending PASV reply');
    control.write('RETR listed.txt\r\n');
    await expectReply(replies, /^150 /u, 'pending RETR opening reply');
    control.write('ABOR\r\n');
    await expectReply(replies, /^426 /u, 'pending RETR abort reply');
    await expectReply(replies, /^226 /u, 'pending ABOR completion reply');
    control.write('PASV\r\n');
    await expectReply(replies, /^227 /u, 'released PASV reply');
    control.write('ABOR\r\n');
    await expectReply(replies, /^226 /u, 'idle ABOR completion reply');
    control.write('NOOP\r\n');
    await expectReply(replies, /^200 /u, 'NOOP after pending ABOR');
  } finally {
    replies.close();
    control.destroy();
  }
}

async function assertSinglePassivePeer(port) {
  const control = await openFtpControl(port);
  const replies = ftpReplyReader(control);
  const candidates = [];
  try {
    await login(replies, control, 'same-peer PASV containment');
    control.write('PASV\r\n');
    const passive = await expectReply(replies, /^227 /u, 'same-peer PASV reply');
    const dataPort = passivePort(passive);
    const settled = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = connect(dataPort, '127.0.0.1');
      candidate.on('error', () => undefined);
      candidate.resume();
      settled.push(
        new Promise((resolve) => {
          candidate.once('connect', () => setTimeout(resolve, 25));
          candidate.once('error', resolve);
          candidate.once('close', resolve);
        }),
      );
      candidates.push(candidate);
    }
    await withDeadline(Promise.all(settled), 'same-peer connection settlement');
    if (candidates.filter((candidate) => !candidate.destroyed).length !== 1) {
      throw new Error('PASV retained more than one same-peer data socket.');
    }
    control.write('RETR listed.txt\r\n');
    await expectReply(replies, /^150 /u, 'same-peer RETR opening reply');
    await expectReply(replies, /^226 /u, 'same-peer RETR completion reply');
  } finally {
    for (const candidate of candidates) candidate.destroy();
    replies.close();
    control.destroy();
  }
}

async function assertAsciiRest(port, root) {
  const localBytes = Buffer.from([0x0a, 0x41, 0x0a, 0x42, 0x0d]);
  const nvtBytes = Buffer.from([0x0d, 0x0a, 0x41, 0x0d, 0x0a, 0x42, 0x0d, 0x00]);
  const uploadedBytes = Buffer.concat([
    Buffer.from(EOL),
    Buffer.from([0x41]),
    Buffer.from(EOL),
    Buffer.from([0x42, 0x0d]),
  ]);
  const file = join(root, 'linux-ascii.txt');
  await writeFile(file, localBytes);

  const control = await openFtpControl(port);
  const replies = ftpReplyReader(control);
  try {
    await login(replies, control, 'ASCII REST');
    control.write('TYPE A\r\n');
    await expectReply(replies, /^200 /u, 'ASCII TYPE reply');
    control.write('SIZE linux-ascii.txt\r\n');
    await expectReply(replies, /^213 8$/u, 'ASCII SIZE reply');
    if (!(await retrieve(control, replies, 'ASCII RETR')).equals(nvtBytes)) {
      throw new Error('FTP ASCII RETR did not produce NVT-ASCII bytes.');
    }

    await store(control, replies, 1, nvtBytes.subarray(1));
    if (!(await readFile(file)).equals(uploadedBytes)) {
      throw new Error('FTP ASCII STOR did not resume inside the leading CRLF.');
    }
    if (
      !(await retrieve(control, replies, 'ASCII RETR after leading CRLF restart')).equals(nvtBytes)
    ) {
      throw new Error('FTP ASCII REST STOR split inside the leading CRLF changed the transfer.');
    }

    await store(control, replies, 4, nvtBytes.subarray(4));
    if (!(await readFile(file)).equals(uploadedBytes)) {
      throw new Error('FTP ASCII STOR did not use the Linux newline convention.');
    }
    if (!(await retrieve(control, replies, 'ASCII RETR after CRLF restart')).equals(nvtBytes)) {
      throw new Error('FTP ASCII REST STOR split inside CRLF changed the transfer.');
    }

    await store(control, replies, 7, nvtBytes.subarray(7));
    if (!(await retrieve(control, replies, 'ASCII RETR after CR-NUL restart')).equals(nvtBytes)) {
      throw new Error('FTP ASCII REST STOR split inside CR-NUL changed the transfer.');
    }
    console.log('linux-ftp-nvt-ascii-rest=pass offsets=1,4,7');
  } finally {
    replies.close();
    control.destroy();
  }
}

async function retrieve(control, replies, label) {
  control.write('PASV\r\n');
  const data = connect(
    passivePort(await expectReply(replies, /^227 /u, `${label} PASV`)),
    '127.0.0.1',
  );
  data.on('error', () => undefined);
  const chunks = [];
  data.on('data', (chunk) => chunks.push(chunk));
  await withDeadline(once(data, 'connect'), `${label} data connection`);
  const ended = once(data, 'end');
  control.write('RETR linux-ascii.txt\r\n');
  await expectReply(replies, /^150 /u, `${label} opening reply`);
  await withDeadline(ended, `${label} data end`);
  await expectReply(replies, /^226 /u, `${label} completion reply`);
  return Buffer.concat(chunks);
}

async function store(control, replies, offset, bytes) {
  control.write('PASV\r\n');
  const data = connect(
    passivePort(await expectReply(replies, /^227 /u, 'ASCII STOR PASV')),
    '127.0.0.1',
  );
  data.on('error', () => undefined);
  await withDeadline(once(data, 'connect'), 'ASCII STOR data connection');
  control.write(`REST ${offset}\r\n`);
  await expectReply(replies, /^350 /u, `ASCII REST ${offset}`);
  control.write('STOR linux-ascii.txt\r\n');
  await expectReply(replies, /^150 /u, `ASCII STOR ${offset} opening reply`);
  const closed = once(data, 'close');
  data.end(bytes);
  await withDeadline(closed, `ASCII STOR ${offset} data close`);
  await expectReply(replies, /^226 /u, `ASCII STOR ${offset} completion reply`);
}

async function openFtpControl(port) {
  const control = connect(port, '127.0.0.1');
  control.on('error', () => undefined);
  await withDeadline(once(control, 'connect'), 'FTP control connection');
  return control;
}

async function login(replies, control, label) {
  await expectReply(replies, /^220 /u, `${label} greeting`);
  control.write('USER linux-ftp-user\r\n');
  await expectReply(replies, /^331 /u, `${label} USER reply`);
  control.write('PASS linux-session-only\r\n');
  await expectReply(replies, /^230 /u, `${label} PASS reply`);
}

function ftpReplyReader(socket) {
  let buffer = '';
  const queued = [];
  const waiters = [];
  const flush = () => {
    while (queued.length > 0 && waiters.length > 0) waiters.shift()(queued.shift());
  };
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    let delimiter = buffer.indexOf('\r\n');
    while (delimiter >= 0) {
      queued.push(buffer.slice(0, delimiter));
      buffer = buffer.slice(delimiter + 2);
      delimiter = buffer.indexOf('\r\n');
    }
    flush();
  };
  socket.on('data', onData);
  return {
    next: () =>
      new Promise((resolve) => {
        if (queued.length > 0) resolve(queued.shift());
        else waiters.push(resolve);
      }),
    close: () => socket.off('data', onData),
  };
}

async function expectReply(replies, pattern, label) {
  const reply = await withDeadline(replies.next(), label);
  if (!pattern.test(reply)) throw new Error(`${label} was ${JSON.stringify(reply)}.`);
  return reply;
}

function passivePort(reply) {
  const values = reply.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/u);
  if (!values) throw new Error(`PASV reply did not include an IPv4 port: ${reply}`);
  return Number(values[5]) * 256 + Number(values[6]);
}

function withDeadline(promise, label) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 5_000);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}
