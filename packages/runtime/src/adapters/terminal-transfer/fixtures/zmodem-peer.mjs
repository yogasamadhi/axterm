import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Receiver, ReceiverEvent, Sender, SenderEvent } from 'zmodem2';

const filePath = process.argv[2];
const direction = process.argv[3] === 'receive' ? 'receive' : 'send';
const stallAfterFirstChunk = direction === 'send' && process.argv[4] === 'stall-after-first-chunk';
if (!filePath || !process.stdin.isTTY) throw new Error('ZMODEM peer needs a file and a PTY');

process.stdin.setRawMode(true);
execFileSync('stty', ['-opost'], { stdio: ['inherit', 'ignore', 'ignore'] });
process.stdin.resume();
process.stdout.write(`AXTERM_ZMODEM_READY_${direction.toUpperCase()}\r\n`);
// A shell may forward startup/control bytes before the test's explicit '!'.
// Do not start emitting ZMODEM binary data until that handshake is received.
let initialInput = Buffer.alloc(0);
await new Promise((resolveStart) => {
  const awaitStart = (chunk) => {
    const data = Buffer.from(chunk);
    const marker = data.indexOf(0x21);
    if (marker < 0) return;
    process.stdin.off('data', awaitStart);
    process.stdin.pause();
    initialInput = data.subarray(marker + 1);
    resolveStart();
  };
  process.stdin.on('data', awaitStart);
});

const payload = direction === 'send' ? await readFile(filePath) : undefined;
const sender = direction === 'send' ? new Sender() : undefined;
const receiver = direction === 'receive' ? new Receiver() : undefined;
const received = [];
let completed = false;
let pending = Buffer.alloc(0);
if (sender) sender.startFile(basename(filePath), payload.length);

function drive() {
  const engine = sender ?? receiver;
  for (let index = 0; index < 1_000 && !completed; index += 1) {
    let progressed = false;
    const outgoing = engine.drainOutgoing();
    if (outgoing.length > 0) {
      process.stdout.write(Buffer.from(outgoing));
      progressed = true;
    }
    if (sender) {
      let event;
      while ((event = sender.pollEvent())) {
        if (event === SenderEvent.FileComplete) sender.finishSession();
        if (event === SenderEvent.SessionComplete) completed = true;
        progressed = true;
      }
      const request = sender.pollFile();
      if (request) {
        if (stallAfterFirstChunk && request.offset > 0) break;
        sender.feedFile(payload.subarray(request.offset, request.offset + request.len));
        progressed = true;
      }
    } else {
      let event;
      while ((event = receiver.pollEvent())) {
        if (event === ReceiverEvent.SessionComplete) completed = true;
        progressed = true;
      }
      const fileBytes = receiver.drainFile();
      if (fileBytes.length > 0) {
        received.push(Buffer.from(fileBytes));
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  if (completed) {
    const finalBytes = engine.drainOutgoing();
    if (finalBytes.length > 0) process.stdout.write(Buffer.from(finalBytes));
    process.stdin.pause();
    if (receiver) {
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
}

function onProtocolData(data) {
  try {
    pending = Buffer.concat([pending, data]);
    if (pending.length > 4 * 1024 * 1024) throw new Error('ZMODEM peer input exceeded its limit');
    for (let index = 0; index < 10_000 && pending.length > 0 && !completed; index += 1) {
      drive();
      const consumed = (sender ?? receiver).feedIncoming(pending);
      // The published reader retains an incomplete header even when it reports
      // zero consumed bytes. State-machine output and file data are drained by
      // drive() before the next feed.
      pending = consumed === 0 ? Buffer.alloc(0) : pending.subarray(consumed);
      drive();
    }
    if (pending.length > 0 && !completed) throw new Error('ZMODEM peer could not drain input');
  } catch (error) {
    process.stdin.pause();
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
process.stdin.on('data', onProtocolData);
if (initialInput.length > 0) onProtocolData(initialInput);
process.stdin.resume();
drive();
