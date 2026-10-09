import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { TrzszTransfer } from 'trzsz2';

const sourcePath = process.argv[2];
const direction = process.argv[3] === 'receive' ? 'receive' : 'send';
const stallAfterFirstChunk = direction === 'send' && process.argv[3] === 'stall-after-first-chunk';
const misreportSize = direction === 'send' && process.argv[3] === 'misreport-size';
const oversizedChunkHeader = direction === 'send' && process.argv[3] === 'oversized-chunk-header';
if (!sourcePath || !process.stdin.isTTY) throw new Error('TRZSZ peer needs a source and a PTY');

process.stdin.setRawMode(true);
execFileSync('stty', ['-opost'], { stdio: ['inherit', 'ignore', 'ignore'] });
process.stdin.resume();

// Let the parent subscribe to PTY output before beginning the protocol.
process.stdout.write(`AXTERM_PEER_READY_${direction.toUpperCase()}\r\n`);
await new Promise((resolve) => process.stdin.once('data', resolve));

const transfer = new TrzszTransfer((data) => process.stdout.write(Buffer.from(data)));
process.stdin.on('data', (data) => transfer.addReceivedData(data));
process.stdout.write(`::TRZSZ:TRANSFER:${direction === 'receive' ? 'R' : 'S'}:pty-fixture\r\n`);

try {
  const action = await transfer.recvAction();
  if (!action.confirm) throw new Error('Axterm rejected the transfer');
  await transfer.sendConfig(oversizedChunkHeader ? { binary: true } : {}, [], 0, 0);
  if (oversizedChunkHeader) {
    const sendData = transfer.sendData.bind(transfer);
    let sentHeader = false;
    transfer.sendData = async (data, binary, escapeCodes) => {
      if (binary && !sentHeader) {
        sentHeader = true;
        process.stdout.write('#DATA:16777217\n');
        return;
      }
      await sendData(data, binary, escapeCodes);
    };
  }
  if (direction === 'send') {
    const bytes = await readFile(sourcePath);
    let offset = 0;
    await transfer.sendFiles(
      [
        {
          getPathId: () => 0,
          getRelPath: () => [basename(sourcePath)],
          isDir: () => false,
          getSize: () => (misreportSize ? 1 : bytes.length),
          async readFile(buffer) {
            if (stallAfterFirstChunk && offset > 0) await new Promise(() => {});
            const chunk = bytes.subarray(offset, offset + buffer.byteLength);
            offset += chunk.length;
            return chunk;
          },
          closeFile: () => {},
        },
      ],
      null,
    );
  } else {
    const chunks = [];
    await transfer.recvFiles(
      null,
      async () => ({
        getFileName: () => basename(sourcePath),
        getLocalName: () => basename(sourcePath),
        isDir: () => false,
        writeFile: async (data) => chunks.push(Buffer.from(data)),
        closeFile: () => {},
        deleteFile: async () => sourcePath,
      }),
      null,
    );
    await writeFile(sourcePath, Buffer.concat(chunks));
  }
  if ((await transfer.recvExit()) !== 'Success') throw new Error('Axterm did not complete');
  transfer.cleanup();
  process.stdin.setRawMode(false);
  process.exitCode = 0;
} catch (error) {
  transfer.cleanup();
  process.stdin.setRawMode(false);
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
process.stdin.pause();
