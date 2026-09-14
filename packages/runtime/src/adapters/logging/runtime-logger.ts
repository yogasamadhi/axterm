import { mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';

export class RuntimeLogger {
  readonly logger: Logger;
  private readonly path: string | undefined;
  private readonly destination: ReturnType<typeof pino.destination> | undefined;

  private constructor(path?: string) {
    this.path = path;
    this.destination = path
      ? pino.destination({ dest: path, sync: false, mkdir: true })
      : undefined;
    this.logger = pino(
      {
        level: path ? 'info' : 'silent',
        base: { component: 'runtime' },
        redact: {
          paths: [
            'req.headers.authorization',
            '*.token',
            '*.secret',
            '*.password',
            '*.passphrase',
            '*.privateKey',
            '*.credential',
          ],
          censor: '[REDACTED]',
        },
        serializers: { err: () => ({ code: 'INTERNAL_ERROR' }) },
      },
      this.destination,
    );
  }

  static async create(directory?: string) {
    if (!directory) return new RuntimeLogger();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'runtime.log');
    await rotate(path);
    return new RuntimeLogger(path);
  }

  async tail(maxBytes = 256 * 1024): Promise<{ lines: string[]; truncated: boolean }> {
    if (!this.path) return { lines: [], truncated: false };
    this.destination?.flushSync();
    const content = await readFile(this.path).catch(() => Buffer.alloc(0));
    const truncated = content.length > maxBytes;
    return {
      lines: content
        .subarray(Math.max(0, content.length - maxBytes))
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-1000),
      truncated,
    };
  }

  close(): void {
    this.destination?.flushSync();
    this.destination?.end();
  }
}

async function rotate(path: string) {
  const size = await stat(path).then(
    (value) => value.size,
    () => 0,
  );
  if (size < 5 * 1024 * 1024) return;
  await unlink(`${path}.5`).catch(() => {});
  for (let index = 4; index >= 1; index--)
    await rename(`${path}.${index}`, `${path}.${index + 1}`).catch(() => {});
  await rename(path, `${path}.1`).catch(() => {});
}
