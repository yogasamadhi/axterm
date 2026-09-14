import { randomUUID } from 'node:crypto';
import {
  connectionProfileInputSchema,
  connectionProfilePatchSchema,
  connectionProfileSchema,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type ConnectionProfilePatch,
} from '@workspace/contracts';
import { ApplicationError } from '../../application/errors';
import type { ProductDatabase } from './database';

interface ConnectionProfileRow {
  id: string;
  name: string;
  payload: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export class ConnectionProfileRepository {
  constructor(private readonly database: ProductDatabase) {}

  list(): ConnectionProfile[] {
    return this.database
      .all<ConnectionProfileRow>(
        `SELECT * FROM connection_profiles
         ORDER BY CASE WHEN json_extract(payload, '$.isDefault') THEN 0 ELSE 1 END,
                  lower(name), id`,
      )
      .map(profileFromRow);
  }

  get(id: string): ConnectionProfile {
    return profileFromRow(this.requireRow(id));
  }

  create(input: ConnectionProfileInput): ConnectionProfile {
    const command = connectionProfileInputSchema.parse(input);
    let created: ConnectionProfile | undefined;
    try {
      this.database.transaction(() => {
        const now = new Date().toISOString();
        const isDefault = command.isDefault || !this.profileCount();
        if (isDefault) this.clearDefaultProfiles(undefined, now);
        const id = randomUUID();
        const payload = { ...command, isDefault };
        this.database.run(
          `INSERT INTO connection_profiles(id, name, payload, created_at, updated_at, version)
           VALUES (?, ?, ?, ?, ?, 1)`,
          id,
          command.name,
          JSON.stringify(payloadWithoutName(payload)),
          now,
          now,
        );
        created = connectionProfileSchema.parse({
          id,
          ...payload,
          createdAt: now,
          updatedAt: now,
          version: 1,
        });
        this.database.appendEvent('connection-profile.created', id, created);
      });
    } catch (error) {
      throwProfileConstraint(error);
    }
    if (!created) throw new ApplicationError('INVALID_STATE', 'Connection Profile was not created');
    return created;
  }

  update(
    id: string,
    input: ConnectionProfilePatch,
    ifMatch: string | undefined,
  ): ConnectionProfile {
    const command = connectionProfilePatchSchema.parse(input);
    let updated: ConnectionProfile | undefined;
    try {
      this.database.transaction(() => {
        const current = profileFromRow(this.requireRow(id));
        requireVersion(ifMatch, current.version);
        const now = new Date().toISOString();
        let next = connectionProfileSchema.parse({
          ...current,
          ...command,
          ssh: command.ssh ? { ...current.ssh, ...command.ssh } : current.ssh,
          telnet: command.telnet ? { ...current.telnet, ...command.telnet } : current.telnet,
          vnc: command.vnc ? { ...current.vnc, ...command.vnc } : current.vnc,
          rdp: command.rdp ? { ...current.rdp, ...command.rdp } : current.rdp,
          ftp: command.ftp ? { ...current.ftp, ...command.ftp } : current.ftp,
          spice: command.spice ? { ...current.spice, ...command.spice } : current.spice,
          id,
          createdAt: current.createdAt,
          updatedAt: now,
          version: current.version + 1,
        });

        if (command.isDefault === true) this.clearDefaultProfiles(id, now);
        if (current.isDefault && command.isDefault === false) {
          const replacement = this.database.get<ConnectionProfileRow>(
            `SELECT * FROM connection_profiles
             WHERE id != ? ORDER BY lower(name), id LIMIT 1`,
            id,
          );
          if (replacement) this.writeDefault(profileFromRow(replacement), true, now);
          else next = { ...next, isDefault: true };
        }

        this.database.run(
          `UPDATE connection_profiles
           SET name=?, payload=?, updated_at=?, version=?
           WHERE id=? AND version=?`,
          next.name,
          JSON.stringify(payloadWithoutName(next)),
          now,
          next.version,
          id,
          current.version,
        );
        updated = next;
        this.database.appendEvent('connection-profile.updated', id, next);
      });
    } catch (error) {
      throwProfileConstraint(error);
    }
    if (!updated) throw new ApplicationError('INVALID_STATE', 'Connection Profile was not updated');
    return updated;
  }

  delete(id: string, ifMatch: string | undefined): ConnectionProfile {
    let deleted: ConnectionProfile | undefined;
    this.database.transaction(() => {
      const current = profileFromRow(this.requireRow(id));
      requireVersion(ifMatch, current.version);
      const reference = this.database.get<{ count: number }>(
        'SELECT count(*) AS count FROM bookmarks WHERE connection_profile_id=?',
        id,
      );
      if ((reference?.count ?? 0) > 0)
        throw new ApplicationError(
          'CONFLICT',
          'Connection Profile is still assigned to one or more Bookmarks',
          409,
        );

      if (current.isDefault) {
        const replacement = this.database.get<ConnectionProfileRow>(
          `SELECT * FROM connection_profiles
           WHERE id != ? ORDER BY lower(name), id LIMIT 1`,
          id,
        );
        if (replacement)
          this.writeDefault(profileFromRow(replacement), true, new Date().toISOString());
      }
      const result = this.database.run(
        'DELETE FROM connection_profiles WHERE id=? AND version=?',
        id,
        current.version,
      );
      if (!result.changes)
        throw new ApplicationError('PRECONDITION_FAILED', 'Connection Profile changed', 412);
      deleted = current;
      this.database.appendEvent('connection-profile.deleted', id, { id });
    });
    if (!deleted) throw new ApplicationError('INVALID_STATE', 'Connection Profile was not deleted');
    return deleted;
  }

  private profileCount(): number {
    return this.database.get<{ count: number }>(
      'SELECT count(*) AS count FROM connection_profiles',
    )!.count;
  }

  private requireRow(id: string): ConnectionProfileRow {
    const row = this.database.get<ConnectionProfileRow>(
      'SELECT * FROM connection_profiles WHERE id=?',
      id,
    );
    if (!row) throw new ApplicationError('NOT_FOUND', 'Connection Profile not found', 404);
    return row;
  }

  private clearDefaultProfiles(exceptId: string | undefined, now: string): void {
    const rows = this.database.all<ConnectionProfileRow>(
      `SELECT * FROM connection_profiles
       WHERE json_extract(payload, '$.isDefault') = 1
       ${exceptId ? 'AND id != ?' : ''}`,
      ...(exceptId ? [exceptId] : []),
    );
    for (const row of rows) this.writeDefault(profileFromRow(row), false, now);
  }

  private writeDefault(profile: ConnectionProfile, isDefault: boolean, now: string): void {
    if (profile.isDefault === isDefault) return;
    const next = connectionProfileSchema.parse({
      ...profile,
      isDefault,
      updatedAt: now,
      version: profile.version + 1,
    });
    const result = this.database.run(
      `UPDATE connection_profiles
       SET payload=?, updated_at=?, version=? WHERE id=? AND version=?`,
      JSON.stringify(payloadWithoutName(next)),
      now,
      next.version,
      profile.id,
      profile.version,
    );
    if (!result.changes)
      throw new ApplicationError('PRECONDITION_FAILED', 'Connection Profile changed', 412);
    this.database.appendEvent('connection-profile.updated', profile.id, next);
  }
}

function profileFromRow(row: ConnectionProfileRow): ConnectionProfile {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  return connectionProfileSchema.parse({
    id: row.id,
    name: row.name,
    ...payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });
}

function payloadWithoutName(
  profile: ConnectionProfileInput | ConnectionProfile,
): Record<string, unknown> {
  const { name: _name, ...payload } = profile;
  const stored = { ...payload } as Record<string, unknown>;
  delete stored.id;
  delete stored.createdAt;
  delete stored.updatedAt;
  delete stored.version;
  return stored;
}

function requireVersion(value: string | undefined, version: number): void {
  if (!value)
    throw new ApplicationError(
      'PRECONDITION_REQUIRED',
      'Connection Profile If-Match is required',
      428,
    );
  if (value !== `"v${version}"`)
    throw new ApplicationError('PRECONDITION_FAILED', 'Connection Profile changed', 412);
}

function throwProfileConstraint(error: unknown): never {
  if (error instanceof Error && /constraint|unique/i.test(error.message))
    throw new ApplicationError('CONFLICT', 'Connection Profile name already exists', 409);
  throw error;
}
