import type { HostCapabilityClient } from '../adapters/host-capability/client';
import type { RuntimeLogger } from '../adapters/logging/runtime-logger';
import { ApplicationError } from './errors';

export class DiagnosticService {
  constructor(
    private readonly generation: string,
    private readonly startedAt: number,
    private readonly resources: () => Record<string, number>,
    private readonly host: HostCapabilityClient | undefined,
    private readonly logger: RuntimeLogger,
  ) {}

  async snapshot() {
    return {
      generation: this.generation,
      uptimeSeconds: Math.max(0, (Date.now() - this.startedAt) / 1000),
      resources: this.resources(),
      database: 'ok' as const,
      updater: this.host ? await this.host.updaterStatus() : { state: 'disabled' as const },
    };
  }
  logs() {
    return this.logger.tail();
  }
  async export(grantId: string) {
    if (!this.host)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Diagnostic export is unavailable', 503);
    const grant = await this.host.resolveGrant(grantId);
    if (!grant.permissions.includes('write'))
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Grant is not writable', 503);
    const createdAt = new Date().toISOString();
    const payload = Buffer.from(
      JSON.stringify(
        {
          format: 'axterm-diagnostics-v1',
          createdAt,
          runtime: await this.snapshot(),
          logs: await this.logs(),
        },
        null,
        2,
      ),
      'utf8',
    );
    const temporary = `${grant.path}.axterm-${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, payload, { mode: 0o600, flag: 'wx' });
      await rename(temporary, grant.path);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return { bytes: payload.length, createdAt };
  }
}
import { randomUUID } from 'node:crypto';
import { writeFile, rename, unlink } from 'node:fs/promises';
