import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const SOH = 0x01;
const STX = 0x02;
const EOT = 0x04;
const ACK = 0x06;
const NAK = 0x15;
const CAN = 0x18;
const CRC_REQUEST = 0x43;
const BLOCK = 128;
const LONG_BLOCK = 1024;
const filePath = process.argv[2];
const direction = process.argv[3] === 'receive' ? 'receive' : 'send';
const stallAfterFirstChunk = direction === 'send' && process.argv[4] === 'stall-after-first-chunk';
if (!filePath || !process.stdin.isTTY) throw new Error('XMODEM peer needs a file and a PTY');

process.stdin.setRawMode(true);
execFileSync('stty', ['-opost'], { stdio: ['inherit', 'ignore', 'ignore'] });
process.stdin.resume();
process.stdout.write(`AXTERM_XMODEM_READY_${direction.toUpperCase()}\r\n`);
const startup = await new Promise((resolve) =>
  process.stdin.once('data', (data) => {
    process.stdin.pause();
    resolve(data);
  }),
);
const start = startup.indexOf(0x21);
if (start < 0) throw new Error('XMODEM peer did not receive its start marker');
const startupRemainder = startup.subarray(start + 1);

const payload = direction === 'send' ? await readFile(filePath) : undefined;
if (payload && payload.length % LONG_BLOCK !== 0)
  throw new Error('XMODEM sender fixture requires complete 1K blocks');
let pending = Buffer.alloc(0);
let block = 1;
let offset = 0;
let frame;
let state = direction === 'send' ? 'start' : 'data';
const received = [];

function crc16(data) {
  let value = 0;
  for (const byte of data) {
    value ^= byte << 8;
    for (let bit = 0; bit < 8; bit++)
      value = ((value << 1) ^ (value & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return value;
}

function sendNext() {
  if (offset >= payload.length) {
    state = 'eot';
    process.stdout.write(Buffer.from([EOT]));
    return;
  }
  const chunk = payload.subarray(offset, offset + LONG_BLOCK);
  frame = Buffer.alloc(3 + LONG_BLOCK + 2);
  frame[0] = STX;
  frame[1] = block & 0xff;
  frame[2] = 0xff ^ frame[1];
  chunk.copy(frame, 3);
  frame.writeUInt16BE(crc16(chunk), 3 + LONG_BLOCK);
  state = 'ack';
  process.stdout.write(frame);
}

function complete() {
  state = 'done';
  process.stdin.pause();
  if (direction === 'receive') {
    void writeFile(filePath, Buffer.concat(received)).then(
      () => {
        process.exitCode = 0;
      },
      (error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      },
    );
  } else {
    process.exitCode = 0;
  }
}

function acceptSendControl(byte) {
  if (byte === CAN) throw new Error('XMODEM sender was canceled');
  if (state === 'start' && byte === CRC_REQUEST) {
    sendNext();
  } else if (state === 'ack' && byte === ACK) {
    offset += LONG_BLOCK;
    block = (block + 1) & 0xff;
    if (!stallAfterFirstChunk || offset === 0) sendNext();
  } else if (state === 'ack' && byte === NAK) {
    process.stdout.write(frame);
  } else if (state === 'eot' && byte === ACK) {
    complete();
  } else if (state === 'eot' && byte === NAK) {
    process.stdout.write(Buffer.from([EOT]));
  }
}

function acceptReceivedData(data) {
  pending = Buffer.concat([pending, data]);
  if (pending.length > 4 * 1024 * 1024) throw new Error('XMODEM peer input exceeded its limit');
  while (pending.length > 0 && state !== 'done') {
    const marker = pending[0];
    if (marker === CAN) throw new Error('XMODEM receiver was canceled');
    if (marker === EOT) {
      pending = pending.subarray(1);
      process.stdout.write(Buffer.from([ACK]));
      complete();
      return;
    }
    if (marker !== SOH && marker !== STX) throw new Error('Unexpected XMODEM frame marker');
    const size = marker === STX ? LONG_BLOCK : BLOCK;
    const length = size + 5;
    if (pending.length < length) return;
    const packet = pending.subarray(0, length);
    pending = pending.subarray(length);
    const number = packet[1];
    const payloadBytes = packet.subarray(3, 3 + size);
    if ((number ^ packet[2]) !== 0xff || packet.readUInt16BE(3 + size) !== crc16(payloadBytes)) {
      process.stdout.write(Buffer.from([NAK]));
      continue;
    }
    if (number === ((block - 1) & 0xff)) {
      process.stdout.write(Buffer.from([ACK]));
      continue;
    }
    if (number !== (block & 0xff)) throw new Error('Unexpected XMODEM block number');
    received.push(Buffer.from(payloadBytes));
    block = (block + 1) & 0xff;
    process.stdout.write(Buffer.from([ACK]));
  }
}

function onData(data) {
  try {
    if (direction === 'send') {
      for (const byte of data) acceptSendControl(byte);
    } else {
      acceptReceivedData(data);
    }
  } catch (error) {
    process.stdin.pause();
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
process.stdin.on('data', onData);
if (direction === 'receive') process.stdout.write(Buffer.from([CRC_REQUEST]));
if (startupRemainder.length > 0) onData(startupRemainder);
process.stdin.resume();
