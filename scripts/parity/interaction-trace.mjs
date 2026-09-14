import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sanitizeInteractionTrace } from './trace-security.mjs';

export async function withInteractionTrace(page, path, run) {
  await mkdir(dirname(path), { recursive: true });
  const tracing = page.context().tracing;
  await tracing.start({ screenshots: true, snapshots: true, sources: false });
  try {
    return await run();
  } finally {
    await tracing.stop({ path });
    await sanitizeInteractionTrace(path);
  }
}
