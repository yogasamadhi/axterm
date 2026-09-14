import { describe, expect, it, vi } from 'vitest';
import { ApplicationError } from './errors';
import { ExternalEditorService } from './external-editor-service';

describe('ExternalEditorService', () => {
  it('detects local changes, pushes explicitly, preserves conflicts and revokes the grant', async () => {
    let localContent = 'alpha\r\n';
    let remoteContent = 'alpha\r\n';
    let remoteRevision = 'revision-1';
    const readText = vi.fn(async () => ({
      path: '/tmp/bad:name.txt',
      content: remoteContent,
      revision: remoteRevision,
      lineEnding: 'crlf' as const,
    }));
    const writeText = vi.fn(
      async (
        _connectionId: string,
        input: { content: string; overwriteRevision: string; lineEnding: 'lf' | 'crlf' },
      ) => {
        if (input.overwriteRevision !== remoteRevision)
          throw new ApplicationError(
            'REMOTE_EDIT_CONFLICT',
            'Remote file changed after it was opened',
            409,
          );
        remoteContent = input.content.replace(/\r?\n/gu, '\r\n');
        remoteRevision = `${remoteRevision}-saved`;
        return {
          path: '/tmp/bad:name.txt',
          content: remoteContent,
          revision: remoteRevision,
          lineEnding: input.lineEnding,
        };
      },
    );
    const createEditableFile = vi.fn(async (name: string, content: string) => {
      localContent = content;
      return {
        grantId: 'grant',
        kind: 'file' as const,
        name,
        permissions: ['read' as const, 'write' as const],
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    });
    const openEditableFile = vi.fn(async () => {});
    const readGrantedText = vi.fn(async () => ({ name: 'bad_name.txt', content: localContent }));
    const revokeGrant = vi.fn(async () => {});
    const service = new ExternalEditorService({ readText, writeText }, {
      createEditableFile,
      openEditableFile,
      readGrantedText,
      revokeGrant,
    } as never);

    const created = await service.create(
      '00000000-0000-4000-8000-000000000001',
      '/tmp/bad:name.txt',
    );
    expect(created).toMatchObject({ fileName: 'bad_name.txt', state: 'watching' });
    expect(created).not.toHaveProperty('grantId');
    expect(service.resourceCount()).toBe(1);
    expect(openEditableFile).toHaveBeenCalledWith('grant');

    localContent = 'beta\n';
    expect(await service.get(created.id)).toMatchObject({ state: 'changed' });
    expect(await service.push(created.id)).toMatchObject({ state: 'saved' });
    expect(remoteContent).toBe('beta\r\n');
    expect(writeText).toHaveBeenCalledWith(
      created.connectionId,
      expect.objectContaining({ overwriteRevision: 'revision-1', lineEnding: 'crlf' }),
    );

    remoteRevision = 'changed-remotely';
    localContent = 'unpublished draft';
    await expect(service.push(created.id)).rejects.toMatchObject({ code: 'REMOTE_EDIT_CONFLICT' });
    expect(await service.get(created.id)).toMatchObject({ state: 'conflict' });
    expect(localContent).toBe('unpublished draft');

    await service.close(created.id);
    expect(revokeGrant).toHaveBeenCalledWith('grant');
    expect(service.resourceCount()).toBe(0);
  });

  it('opens the editable grant with the configured local editor executable', async () => {
    const openEditableFile = vi.fn(async () => {});
    const service = new ExternalEditorService(
      {
        readText: vi.fn(async () => ({
          path: '/tmp/notes.txt',
          content: 'draft',
          revision: 'revision-1',
          lineEnding: 'lf' as const,
        })),
        writeText: vi.fn(),
      },
      {
        createEditableFile: vi.fn(async () => ({
          grantId: 'grant',
          kind: 'file' as const,
          name: 'notes.txt',
          permissions: ['read' as const, 'write' as const],
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })),
        openEditableFile,
        readGrantedText: vi.fn(),
        revokeGrant: vi.fn(),
      } as never,
      {
        getSettings: () =>
          ({ fileManager: { externalEditor: '/Applications/Editor/bin/editor' } }) as never,
      },
    );

    await service.create('00000000-0000-4000-8000-000000000001', '/tmp/notes.txt');

    expect(openEditableFile).toHaveBeenCalledWith('grant', '/Applications/Editor/bin/editor');
  });
});
