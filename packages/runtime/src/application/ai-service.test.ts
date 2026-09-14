import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ProductDatabase } from '../adapters/sqlite/database';
import { ProductRepository } from '../adapters/sqlite/product-repository';
import type { PtyPort, TerminalChannel } from '../ports/terminal-channel';
import {
  AI_ATTACHMENT_FILE_BYTES,
  AI_ATTACHMENT_TOTAL_BYTES,
  AiService,
  redact,
} from './ai-service';
import { AiToolService } from './ai-tool-service';
import { RealtimeHub } from './realtime-hub';
import { TerminalService } from './terminal-service';

function channel(): TerminalChannel & { writes: Uint8Array[] } {
  const writes: Uint8Array[] = [];
  return {
    writes,
    write: (data) => writes.push(data),
    resize: () => {},
    signal: () => {},
    onData: () => () => {},
    onExit: () => () => {},
    pause: () => {},
    resume: () => {},
    close: async () => {},
  };
}

describe('AI policy and audit', () => {
  it('redacts common credentials and private keys', () => {
    const value = redact(
      'password=hunter2 token=abcdefghijklmnop Bearer abcdefghijklmnop\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
    );
    expect(value).not.toMatch(/hunter2|abcdefghijklmnop|BEGIN PRIVATE|\nsecret\n/);
  });

  it('binds mutating approval to the exact args and persists the tool result', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    const terminalChannel = channel();
    const terminals = new TerminalService({ open: () => terminalChannel } satisfies PtyPort);
    const terminal = terminals.createLocal({ cols: 80, rows: 24 });
    const connections = { handle: vi.fn() };
    const sftp = { list: vi.fn(), readText: vi.fn() };
    const tools = new AiToolService(repository, terminals, connections as never, sftp as never);
    const service = new AiService(repository, undefined, new RealtimeHub(), tools);
    const run = service.start(
      {
        modelId: randomUUID(),
        useCase: 'diagnose',
        prompt: 'run a reviewed command',
        context: '',
        terminalId: terminal.id,
        tool: { name: 'terminal.exec', args: { command: 'printf approved' }, target: terminal.id },
      },
      randomUUID(),
    );
    await vi.waitFor(() => expect(service.get(run.id).state).toBe('waiting_approval'));
    const approval = service.approvals()[0]!;
    await expect(
      service.decideApproval(approval.id, {
        decision: 'approve_once',
        argsHash: 'tampered',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await service.decideApproval(approval.id, {
      decision: 'approve_once',
      argsHash: approval.argsHash,
    });
    await expect(
      service.decideApproval(approval.id, {
        decision: 'approve_once',
        argsHash: approval.argsHash,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(Buffer.concat(terminalChannel.writes).toString()).toBe('printf approved\r');
    expect(service.get(run.id).state).toBe('succeeded');
    expect(service.toolCalls(run.id)[0]).toMatchObject({
      toolName: 'terminal.exec',
      args: { command: 'printf approved' },
      state: 'succeeded',
    });
    expect(repository.listEvents().map((event) => event.type)).toContain('ai-run.updated');
    await service.close();
    await terminals.closeAll();
    database.close();
  });

  it('expires stale approvals and closes their tool and run state', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    const terminalChannel = channel();
    const terminals = new TerminalService({ open: () => terminalChannel });
    const terminal = terminals.createLocal({ cols: 80, rows: 24 });
    const tools = new AiToolService(repository, terminals, {} as never, {} as never);
    const service = new AiService(repository, undefined, new RealtimeHub(), tools);
    const run = service.start(
      {
        modelId: randomUUID(),
        useCase: 'diagnose',
        prompt: 'expire this action',
        context: '',
        tool: { name: 'terminal.exec', args: { command: 'echo never' }, target: terminal.id },
      },
      randomUUID(),
    );
    await vi.waitFor(() => expect(service.get(run.id).state).toBe('waiting_approval'));
    const approval = service.approvals()[0]!;
    database.run(
      'UPDATE ai_approvals SET expires_at=? WHERE id=?',
      new Date(0).toISOString(),
      approval.id,
    );
    expect(service.approvals()[0]).toMatchObject({ id: approval.id, state: 'expired' });
    expect(service.toolCalls(run.id)[0]).toMatchObject({
      state: 'canceled',
      resultMetadata: { code: 'APPROVAL_EXPIRED' },
    });
    expect(service.get(run.id)).toMatchObject({ state: 'canceled', errorCode: 'APPROVAL_EXPIRED' });
    expect(Buffer.concat(terminalChannel.writes)).toHaveLength(0);
    await service.close();
    await terminals.closeAll();
    database.close();
  });

  it('cancels an active read-only tool without allowing late success', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    let resolveTool: ((value: unknown) => void) | undefined;
    const tools = {
      risk: () => 'read_only',
      execute: (_name: string, _args: unknown, _target: string, signal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          resolveTool = resolve;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    };
    const service = new AiService(repository, undefined, new RealtimeHub(), tools as never);
    const run = service.start(
      {
        modelId: randomUUID(),
        useCase: 'diagnose',
        prompt: 'inspect slowly',
        context: '',
        tool: { name: 'system.inspectDisk', args: {}, target: 'local' },
      },
      randomUUID(),
    );
    await vi.waitFor(() => expect(service.toolCalls(run.id)[0]?.state).toBe('running'));
    service.cancel(run.id);
    resolveTool?.({ tooLate: true });
    await vi.waitFor(() => expect(service.get(run.id).state).toBe('canceled'));
    expect(service.toolCalls(run.id)[0]).toMatchObject({
      state: 'canceled',
      resultMetadata: { code: 'REQUEST_CANCELED' },
    });
    expect(service.get(run.id).result).toBeUndefined();
    await service.close();
    database.close();
  });

  it('rejects tools outside the explicit allowlist', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    const terminals = new TerminalService({ open: channel });
    const tools = new AiToolService(repository, terminals, {} as never, {} as never);
    expect(() => tools.risk('shell.anything')).toThrowError(
      expect.objectContaining({ code: 'CAPABILITY_UNAVAILABLE' }),
    );
    database.close();
  });

  it('exposes the registered MCP tools through persisted read and approval paths', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    const terminalChannel = channel();
    const terminals = new TerminalService({ open: () => terminalChannel });
    const terminal = terminals.createLocal({ cols: 80, rows: 24 });
    const tools = new AiToolService(repository, terminals, {} as never, {} as never);
    const service = new AiService(repository, undefined, new RealtimeHub(), tools);
    expect(tools.mcpTools()).toHaveLength(10);
    expect(tools.mcpTools().find(({ name }) => name === 'terminal.exec')).toMatchObject({
      risk: 'mutating',
      inputSchema: expect.objectContaining({ additionalProperties: false }),
    });

    const readKey = randomUUID();
    const read = await service.invokeRegisteredTool(
      tools.mcpProposal('system.inspectMemory', {}),
      readKey,
    );
    expect(read).toMatchObject({
      state: 'succeeded',
      result: expect.objectContaining({ platform: expect.any(String) }),
    });
    const repeated = await service.invokeRegisteredTool(
      tools.mcpProposal('system.inspectMemory', {}),
      readKey,
    );
    expect(repeated.runId).toBe(read.runId);

    const mutation = await service.invokeRegisteredTool(
      tools.mcpProposal('terminal.exec', {
        terminalId: terminal.id,
        command: 'printf mcp-approved',
      }),
      randomUUID(),
    );
    expect(mutation).toMatchObject({
      state: 'waiting_approval',
      approvalId: expect.any(String),
      argsHash: expect.any(String),
      expiresAt: expect.any(String),
    });
    await service.decideApproval(mutation.approvalId!, {
      decision: 'approve_once',
      argsHash: mutation.argsHash!,
    });
    expect(Buffer.concat(terminalChannel.writes).toString()).toBe('printf mcp-approved\r');
    expect(repository.listEvents().map(({ type }) => type)).toContain('ai-run.created');
    await service.close();
    await terminals.closeAll();
    database.close();
  });

  it('prepares redacted text attachments, persists metadata only, and consumes drafts once', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    const model = repository.createJson(
      'ai_models',
      {
        providerId: randomUUID(),
        name: 'Unavailable fixture',
        model: 'fixture',
        capabilities: ['chat'],
      },
      'ai-model',
    );
    const revokeGrant = vi.fn(async () => undefined);
    const host = {
      readGrantedTextPrefix: vi.fn(async () => ({
        name: 'debug\nnotes.txt',
        size: 60 * 1024,
        content: 'failure details\npassword=supersecret\nnext check',
        includedBytes: AI_ATTACHMENT_FILE_BYTES,
        truncated: true,
      })),
      revokeGrant,
    };
    const service = new AiService(repository, host as never, new RealtimeHub(), {} as never);
    const conversation = service.createConversation({
      name: 'Attachment test',
      modelId: model.id,
      useCase: 'diagnose',
    });
    const attachment = await service.prepareAttachment('grant-secret');
    expect(attachment).toMatchObject({
      name: 'debug notes.txt',
      size: 60 * 1024,
      includedBytes: AI_ATTACHMENT_FILE_BYTES,
      truncated: true,
      redacted: true,
    });
    expect(attachment.preview).not.toContain('supersecret');
    expect(revokeGrant).toHaveBeenCalledWith('grant-secret');
    const run = service.start(
      {
        modelId: model.id,
        conversationId: conversation.id,
        useCase: 'diagnose',
        prompt: '',
        context: '',
        attachmentIds: [attachment.id],
      },
      randomUUID(),
    );
    await vi.waitFor(() => expect(service.get(run.id).state).toBe('failed'));
    const message = service.conversation(conversation.id).messages[0]!;
    expect(message).toMatchObject({
      role: 'user',
      content: '',
      attachments: [
        {
          name: 'debug notes.txt',
          size: 60 * 1024,
          includedBytes: AI_ATTACHMENT_FILE_BYTES,
          truncated: true,
        },
      ],
    });
    const stored = database.get<{ request: string }>(
      'SELECT request FROM ai_runs WHERE id=?',
      run.id,
    )!;
    expect(stored.request).not.toMatch(/failure details|supersecret|grant-secret|debug\\nnotes/);
    expect(stored.request).toContain('debug notes.txt');
    expect(() =>
      service.start(
        {
          modelId: model.id,
          conversationId: conversation.id,
          useCase: 'diagnose',
          prompt: 'reuse',
          context: '',
          attachmentIds: [attachment.id],
        },
        randomUUID(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'ATTACHMENT_EXPIRED' }));
    expect(AI_ATTACHMENT_TOTAL_BYTES).toBe(100 * 1024);
    await service.close();
    database.close();
  });

  it('rejects canceled, expired and over-total attachment drafts without starting a run', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    const revokeGrant = vi.fn(async () => undefined);
    const host = {
      readGrantedTextPrefix: vi.fn(async () => ({
        name: 'bounded.txt',
        size: 60 * 1024,
        content: 'bounded text',
        includedBytes: 12,
        truncated: true,
      })),
      revokeGrant,
    };
    const service = new AiService(repository, host as never, new RealtimeHub(), {} as never);
    const canceled = new AbortController();
    canceled.abort();
    await expect(
      service.prepareAttachment('canceled-grant', canceled.signal),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELED' });
    expect(revokeGrant).toHaveBeenCalledWith('canceled-grant');

    const first = await service.prepareAttachment('first-grant');
    const second = await service.prepareAttachment('second-grant');
    expect(() =>
      service.start(
        {
          modelId: randomUUID(),
          useCase: 'diagnose',
          prompt: 'too much source material',
          context: '',
          attachmentIds: [first.id, second.id],
        },
        randomUUID(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }));
    expect(service.list()).toHaveLength(0);

    const now = Date.now();
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
    const expiring = await service.prepareAttachment('expiring-grant');
    dateNow.mockReturnValue(now + 16 * 60_000);
    expect(() =>
      service.start(
        {
          modelId: randomUUID(),
          useCase: 'diagnose',
          prompt: 'expired source material',
          context: '',
          attachmentIds: [expiring.id],
        },
        randomUUID(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'ATTACHMENT_EXPIRED' }));
    dateNow.mockRestore();
    await service.close();
    database.close();
  });
});
