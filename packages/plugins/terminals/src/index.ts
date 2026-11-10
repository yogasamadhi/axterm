import { grantedRecording } from './adapters/granted-recording.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { TerminalInformationService } from './application/terminal-information-service.ts';
import { fileGrantSchema } from '@axterm/plugin-api/files';
import { createTerminalAssets, terminalAssetFailure, type OwnedTerminalAssets } from './assets.ts';
import { isAbsolute } from 'node:path';
import { productDomains } from '@axterm/data-schema';
import { TerminalTransfers } from './application/terminal-transfer.ts';
import { TerminalProtocolAdapter } from './adapters/terminal-transfer/terminal-transfer-adapter.ts';
import { PrivateTerminalStaging } from './adapters/terminal-transfer/private-staging.ts';
import { TerminalStageStore } from './adapters/terminal-transfer/stage-store.ts';
import { TerminalTransferCommands } from './adapters/terminal-transfer/commands.ts';
import { Remote, RemoteError, remoteErrorOf, TypertRemoteService } from '@axterm/plugin-api';
import { randomUUID } from 'node:crypto';
import * as FactContract from '@axterm/plugin-api/terminals';
import { ZodError } from 'zod';
import {
  idSchema,
  createTerminalSchema,
  terminalSessionSchema,
  type CreateTerminalInput,
  type TerminalSession,
  type TerminalUpdate,
  type TerminalBaseline,
} from '@axterm/plugin-api/terminals';
import type {} from '@axterm/plugin-api/host';
import type { ConnectionsApplication, TerminalFactsOwner } from '@axterm/plugin-api/host';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { TerminalService } from './application/terminal-service.ts';
import { TerminalObservation } from './application/terminal-observation.ts';
import { ApplicationError } from './application/errors.ts';
import { NodePtyAdapter } from './adapters/node-pty-adapter.ts';
import { TerminalRecordingWriter } from './adapters/terminal-recording.ts';
import { TerminalBinaryStream } from './adapters/binary-stream.ts';
import { TerminalCreationCommands, TerminalCommandError } from './adapters/creation-commands.ts';
import { optionsForProfile, resolveTerminalProfileId } from './application/profile-options.ts';
export interface Config {
  stagingDirectory?: string;
  shell?: string;
  shellArgs: string[];
  cwd?: string;
  env: Record<string, string>;
  maxSessions: number;
}
export const Config: z<Config> = z.object({
  stagingDirectory: z.string(),
  shell: z.string(),
  shellArgs: z.array(z.string()).default([]),
  cwd: z.string(),
  env: z.dict(z.string()).default({}),
  maxSessions: z.natural().min(1).max(256).default(64),
});
declare module '@deepseek-ai/cordis' {
  interface Context {
    terminalController: TerminalController;
  }
}
/** Composition and generated Remote boundary; adapters never enter the Client face. */
export default class TerminalController extends TypertRemoteService {
  static inject = ['runtimeIdentity', 'desktopTaskInspection', 'subprocess'];
  static Config = Config;
  private readonly terminals: TerminalService;
  private readonly observation: TerminalObservation;
  private readonly information: TerminalInformationService;
  private readonly informationFollowers = new Set<symbol>();
  private readonly commands: TerminalCreationCommands;
  private readonly recordingCommands = new TerminalCreationCommands<{ id: string }>((id) => ({
    id,
  }));
  private readonly lifetime = new AbortController();
  private readonly streams = new Set<TerminalBinaryStream>();
  private readonly creates = new Set<Promise<TerminalSession>>();
  private closing: Promise<void> | undefined;
  private open = true;
  private protocols: TerminalTransfers | undefined;
  private protocolStaging: PrivateTerminalStaging | undefined;
  private readonly protocolCommands = new TerminalTransferCommands();
  private ssh: ConnectionsApplication | undefined;
  private facts: TerminalFactsOwner | undefined;
  private assets: OwnedTerminalAssets | undefined;
  private readonly assetWaiters = new Set<() => void>();
  captureResourceSnapshot(): () => Readonly<Record<string, number>> {
    const protocols = this.protocols;
    if (!protocols) throw Error('TERMINAL_PROTOCOL_OWNER_UNAVAILABLE');
    return () => Object.freeze({ ...this.resourceSnapshot(), ...protocols.resourceSnapshot() });
  }
  resourceSnapshot(): Readonly<Record<string, number>> {
    return Object.freeze({
      ...this.terminals.resourceSnapshot(),
      ...this.information.resourceSnapshot(),
      ...this.protocols?.resourceSnapshot(),
      terminalInformationFollowers: this.informationFollowers.size,
      terminalMetadataFollowers: this.observation.resourceCount(),
    });
  }
  constructor(
    ctx: Context,
    private readonly config: Config,
  ) {
    super(ctx, 'terminalController', { namespace: 'terminals' });
    this.terminals = new TerminalService(
      new NodePtyAdapter(ctx.subprocess),
      TerminalRecordingWriter,
      config.maxSessions,
    );
    this.information = new TerminalInformationService(this.terminals, () => this.ssh);
    this.commands = new TerminalCreationCommands((id) => this.terminals.get(id));
    this.observation = new TerminalObservation(this.terminals, ctx.runtimeIdentity.generation);
    ctx.provide('terminals', {
      addOutputObserver: (observer) => {
        this.assertOpen();
        return this.terminals.addOutputObserver(observer);
      },
      insertText: (id, text) => {
        this.assertOpen();
        this.terminals.insertText(id, text);
      },
      executeCommand: (id, command, signal) => {
        this.assertOpen();
        return this.terminals.executeCommand(
          id,
          command,
          AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
        );
      },
      registerExternal: (metadata, channel, kind) => {
        this.assertOpen();
        return this.terminals.registerExternal(
          terminalSessionSchema.parse({ ...metadata, id: randomUUID() }),
          channel,
          kind,
        );
      },
      enqueueStartupSequence: (id, steps) => {
        this.assertOpen();
        this.terminals.enqueueStartupSequence(id, steps);
      },
      list: () => {
        this.assertOpen();
        return this.terminals.list();
      },
      get: (id) => {
        this.assertOpen();
        try {
          return this.terminals.get(id);
        } catch (error) {
          throw this.failure(error);
        }
      },
      workingDirectory: (id) => {
        this.assertOpen();
        try {
          return this.terminals.workingDirectory(idSchema.parse(id));
        } catch (error) {
          throw this.failure(error);
        }
      },
      recentOutput: (id) => {
        this.assertOpen();
        const bytes = Buffer.from(this.terminals.recentOutput(idSchema.parse(id)), 'utf8');
        let offset = Math.max(0, bytes.byteLength - 64 * 1024);
        while (offset < bytes.byteLength && bytes[offset]! >= 0x80 && bytes[offset]! < 0xc0)
          offset++;
        return bytes.subarray(offset).toString('utf8');
      },
      disconnect: (id) => {
        this.assertOpen();
        return this.terminals.disconnect(id);
      },
      close: (id) => this.closeTerminalOwned(id),
      resourceCount: () => this.terminals.resourceCount(),
    });
    ctx.inject(['connections'], (scope) => {
      const creator = scope.connections;
      this.ssh = creator;
      scope.effect(() => () => {
        if (this.ssh === creator) this.ssh = undefined;
      });
    });
    ctx.inject(['terminalFacts', 'configuration'], (scope) => {
      const facts = scope.terminalFacts;
      this.facts = facts;
      scope.effect(() =>
        this.terminals.subscribeShellCommands((terminalId, command) => {
          if (scope.configuration.getSettings().privacy.commandHistoryEnabled)
            facts.recordHistory(randomUUID(), { terminalId, command, source: 'shellIntegration' });
        }),
      );
      scope.effect(() => () => {
        if (this.facts === facts) this.facts = undefined;
      });
    });
    ctx.inject(['storage', 'storageDomain', 'files', 'configuration'], async (scope) => {
      const assets = await createTerminalAssets(scope);
      if (scope.fiber.uid === null) {
        await assets.application.close();
        return;
      }
      this.assets = assets;
      for (const wake of this.assetWaiters) wake();
      scope.effect(() => () => {
        if (this.assets === assets) this.assets = undefined;
        for (const wake of this.assetWaiters) wake();
      });
    });
    ctx.inject(['storage', 'files', 'fileGrants'], async (scope) => {
      if (!config.stagingDirectory) return;
      if (!isAbsolute(config.stagingDirectory)) throw Error('TERMINAL_STAGING_PATH_INVALID');
      const opening = scope.storage.domain.open(productDomains.terminalTransferStages);
      const owned: {
        application?: TerminalTransfers;
        staging?: PrivateTerminalStaging;
        unhook?: () => void;
      } = {};
      scope.effect(() => async () => {
        await owned.application?.closeAll();
        owned.unhook?.();
        if (this.protocols === owned.application) this.protocols = undefined;
        if (this.protocolStaging === owned.staging) this.protocolStaging = undefined;
        await (await opening).close();
      });
      const domain = await opening;
      if (scope.fiber.uid === null) return;
      const profile = scope.runtimeIdentity.profileName;
      if (!profile) throw Error('PROFILE_IDENTITY_REQUIRED');
      const store = new TerminalStageStore(domain, profile, scope.runtimeIdentity.generation);
      const staging = (owned.staging = new PrivateTerminalStaging(
        config.stagingDirectory,
        scope.files,
        scope.fileGrants,
        store,
      ));
      const application = (owned.application = new TerminalTransfers(
        this.terminals,
        new TerminalProtocolAdapter(),
        staging,
      ));
      owned.unhook = this.terminals.setDataInterceptor(application);
      this.protocols = application;
      this.protocolStaging = staging;
    });
    ctx.effect(() => () => this.dispose());
    ctx.desktopTaskInspection.register('terminals', {
      inspect: (signal) => {
        signal.throwIfAborted();
        return {
          active:
            this.terminals.activeTaskCount() +
              this.creates.size +
              (this.protocols?.resourceCount() ?? 0) >
            0,
        };
      },
      dispose: () => this.dispose(),
    });
    ctx.inject(['webServer', 'connection', 'remoteAccess'], (web) => {
      const stream = new TerminalBinaryStream(web, this.terminals);
      this.streams.add(stream);
      web.effect(() => async () => {
        await stream.dispose();
        this.streams.delete(stream);
      });
    });
  }
  @Remote
  listTerminalSessions(): TerminalSession[] {
    this.assertOpen();
    return this.terminals.list();
  }
  @Remote({ resources: { terminal: (id: string) => id } })
  getTerminalSession(id: string): TerminalSession {
    this.assertOpen();
    try {
      return this.terminals.get(id);
    } catch (error) {
      throw this.failure(error);
    }
  }
  @Remote
  async createTerminal(
    generation: string,
    key: string,
    input: CreateTerminalInput,
    signal: AbortSignal,
  ): Promise<TerminalSession> {
    this.assertOpen();
    if (generation !== this.ctx.runtimeIdentity.generation)
      throw new RemoteError('terminals/failure', 'Terminal generation changed', {
        reason: 'stale',
      });
    try {
      const request = createTerminalSchema.parse(input);
      return await this.commands.execute(key, 'create', request, () => {
        if (this.terminals.resourceCount() + this.creates.size >= this.config.maxSessions)
          throw new RemoteError('terminals/failure', 'Terminal capacity exceeded', {
            reason: 'capacity',
          });
        const task = Promise.resolve().then(() =>
          this.createOwnedTerminal(request, AbortSignal.any([signal, this.lifetime.signal])),
        );
        this.creates.add(task);
        void task.then(
          () => this.creates.delete(task),
          () => this.creates.delete(task),
        );
        return task;
      });
    } catch (error) {
      throw this.failure(error);
    }
  }
  @Remote({ resources: { terminal: (_generation: string, _key: string, id: string) => id } })
  async disconnectTerminal(generation: string, key: string, id: string): Promise<TerminalSession> {
    this.assertOpen();
    this.assertGeneration(generation);
    try {
      const target = idSchema.parse(id);
      return await this.commands.execute(key, 'disconnect', { id: target }, () =>
        this.terminals.disconnect(target),
      );
    } catch (error) {
      throw this.failure(error);
    }
  }

  @Remote
  getTerminalCommandOutcome(generation: string, key: string): FactContract.TerminalCommandOutcome {
    this.assertOpen();
    this.assertGeneration(generation);
    try {
      return this.commands.outcome(key);
    } catch (error) {
      throw this.failure(error);
    }
  }
  private assertGeneration(generation: string): void {
    if (generation !== this.ctx.runtimeIdentity.generation)
      throw new RemoteError('terminals/failure', 'Terminal generation changed', {
        reason: 'stale',
      });
  }
  private async createOwnedTerminal(
    input: CreateTerminalInput,
    signal: AbortSignal,
  ): Promise<TerminalSession> {
    this.assertOpen();
    const parsed = createTerminalSchema.safeParse(input);
    if (!parsed.success)
      throw new RemoteError('terminals/failure', 'Terminal input is invalid', {
        reason: 'invalid-input',
      });
    if (this.terminals.resourceCount() >= this.config.maxSessions)
      throw new RemoteError('terminals/failure', 'Terminal capacity exceeded', {
        reason: 'capacity',
      });
    try {
      const bookmarkProfileId = parsed.data.bookmarkId
        ? this.ctx.get('catalog')?.getBookmark(parsed.data.bookmarkId).profileId
        : undefined;
      const profileId = resolveTerminalProfileId(
        this.facts?.listProfiles(),
        parsed.data.profileId,
        bookmarkProfileId,
        this.ctx.get('configuration')?.getSettings().terminal.defaultProfileId,
      );
      const profile = profileId
        ? this.readFacts((facts) => facts.getProfile(profileId!))
        : undefined;
      const profileOptions = profile ? optionsForProfile(profile) : undefined;
      if (parsed.data.kind === 'serial' || parsed.data.kind === 'telnet') {
        if (!this.ssh)
          throw new RemoteError('terminals/failure', 'Protocol terminal creation is unavailable', {
            reason: 'unavailable',
          });
        return await this.finishCreate(
          this.ssh.openBookmarkTerminal(
            {
              kind: parsed.data.kind,
              bookmarkId: parsed.data.bookmarkId!,
              cols: parsed.data.cols,
              rows: parsed.data.rows,
              ...(profileId ? { profileId: profileId } : {}),
              ...(profileOptions
                ? { appearance: profileOptions.appearance, behavior: profileOptions.behavior }
                : {}),
            },
            signal,
          ),
          signal,
        );
      }
      if (parsed.data.kind === 'ssh') {
        if (!this.ssh)
          throw new RemoteError('terminals/failure', 'SSH terminal creation is unavailable', {
            reason: 'unavailable',
          });
        return await this.finishCreate(
          this.ssh.openTerminal(parsed.data.connectionId!, {
            cols: parsed.data.cols,
            rows: parsed.data.rows,
            ...(parsed.data.bookmarkId ? { bookmarkId: parsed.data.bookmarkId } : {}),
            ...(profileId ? { profileId: profileId } : {}),
            ...(profileOptions
              ? {
                  term: profileOptions.term,
                  appearance: profileOptions.appearance,
                  behavior: profileOptions.behavior,
                }
              : {}),
            ...(profileOptions?.env || parsed.data.environment
              ? { env: { ...profileOptions?.env, ...parsed.data.environment } }
              : {}),
            ...(parsed.data.workingDirectory?.scope === 'remote'
              ? { directory: parsed.data.workingDirectory.path }
              : {}),
          }),
          signal,
        );
      }
      let cwd: string | undefined;
      if (parsed.data.workingDirectory?.scope === 'local') {
        const files = this.ctx.get('fileGrants');
        if (!files)
          throw new RemoteError('terminals/failure', 'File grants are unavailable', {
            reason: 'unavailable',
          });
        cwd = await files.resolveDirectory(
          parsed.data.workingDirectory.grantId,
          parsed.data.workingDirectory.path,
          AbortSignal.any([signal, this.lifetime.signal]),
        );
        this.assertOpen();
      }
      signal.throwIfAborted();
      return await this.finishCreate(
        this.terminals.createLocal({
          signal,
          cols: parsed.data.cols,
          rows: parsed.data.rows,
          ...(this.config.shell ? { shell: this.config.shell } : {}),
          shellArgs: this.config.shellArgs,
          ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
          ...profileOptions,
          ...(cwd ? { cwd } : {}),
          ...(profileId ? { profileId: profileId } : {}),
          env: { ...this.config.env, ...profileOptions?.env },
        }),
        signal,
      );
    } catch (error) {
      throw this.failure(error);
    }
  }
  private async finishCreate(
    opening: Promise<TerminalSession>,
    signal: AbortSignal,
  ): Promise<TerminalSession> {
    const created = await opening;
    if (signal.aborted || !this.open) {
      await this.closeTerminalOwned(created.id);
      throw new RemoteError('terminals/failure', 'Terminal creation was canceled', {
        reason: 'cancelled',
      });
    }
    return created;
  }
  @Remote({ resources: { terminal: (_generation: string, id: string) => id } })
  async closeTerminal(generation: string, id: string): Promise<{ closed: true }> {
    this.assertOpen();
    this.assertGeneration(generation);
    try {
      await this.closeTerminalOwned(id);
      return { closed: true };
    } catch (error) {
      throw this.failure(error);
    }
  }
  @Remote
  getSnapshot(): TerminalBaseline {
    this.assertOpen();
    return this.observation.snapshot();
  }
  @Remote({ mode: 'stream' })
  watchTerminals(signal: AbortSignal): AsyncIterable<TerminalUpdate> {
    this.assertOpen();
    return this.observation.watch(AbortSignal.any([signal, this.lifetime.signal]));
  }
  @Remote listTerminalProfiles(): FactContract.TerminalProfile[] {
    return this.readFacts((facts) => facts.listProfiles());
  }
  @Remote({ resources: { terminalProfile: (id: string) => id } }) getTerminalProfile(
    id: string,
  ): FactContract.TerminalProfile {
    return this.readFacts((facts) => facts.getProfile(FactContract.idSchema.parse(id)));
  }
  @Remote createTerminalProfile(
    key: string,
    input: FactContract.TerminalProfileInput,
  ): FactContract.TerminalFactsReceipt {
    return this.readFacts((facts) => facts.createProfile(key, input));
  }
  @Remote({ resources: { terminalProfile: (key: string, id: string) => id } })
  updateTerminalProfile(
    key: string,
    id: string,
    input: FactContract.TerminalProfilePatch,
    ifMatch: string | undefined,
  ): FactContract.TerminalFactsReceipt {
    return this.readFacts((facts) =>
      facts.updateProfile(key, FactContract.idSchema.parse(id), input, ifMatch),
    );
  }
  @Remote({ resources: { terminalProfile: (key: string, id: string) => id } })
  deleteTerminalProfile(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): FactContract.TerminalFactsReceipt {
    return this.readFacts((facts) =>
      facts.deleteProfile(key, FactContract.idSchema.parse(id), ifMatch),
    );
  }
  @Remote listTerminalThemes(): FactContract.TerminalTheme[] {
    return this.readFacts((facts) => facts.listThemes());
  }
  @Remote createTerminalTheme(
    key: string,
    input: FactContract.TerminalThemeInput,
    generation: string,
  ): FactContract.TerminalFactsReceipt {
    this.assertGeneration(generation);
    return this.readFacts((facts) => facts.createTheme(key, input));
  }
  @Remote({ resources: { terminalTheme: (key: string, id: string) => id } }) cloneTerminalTheme(
    key: string,
    id: string,
    name: string | undefined,
    generation: string,
  ): FactContract.TerminalFactsReceipt {
    this.assertGeneration(generation);
    return this.readFacts((facts) => facts.cloneTheme(key, FactContract.idSchema.parse(id), name));
  }
  @Remote({ resources: { terminalTheme: (key: string, id: string) => id } }) updateTerminalTheme(
    key: string,
    id: string,
    input: FactContract.TerminalThemePatch,
    ifMatch: string | undefined,
    generation: string,
  ): FactContract.TerminalFactsReceipt {
    this.assertGeneration(generation);
    return this.readFacts((facts) =>
      facts.updateTheme(key, FactContract.idSchema.parse(id), input, ifMatch),
    );
  }
  @Remote({ resources: { terminalTheme: (key: string, id: string) => id } }) deleteTerminalTheme(
    key: string,
    id: string,
    ifMatch: string | undefined,
    generation: string,
  ): FactContract.TerminalFactsReceipt {
    this.assertGeneration(generation);
    return this.readFacts((facts) =>
      facts.deleteTheme(key, FactContract.idSchema.parse(id), ifMatch),
    );
  }
  @Remote listCommandHistory(
    input: FactContract.CommandHistoryQuery,
  ): FactContract.CommandHistoryPage {
    return this.readFacts((facts) => facts.listHistory(input));
  }
  @Remote async startTerminalRecording(
    generation: string,
    key: string,
    id: string,
    input: FactContract.StartTerminalRecordingInput,
    signal: AbortSignal,
  ): Promise<FactContract.TerminalRecording> {
    try {
      this.assertGeneration(generation);
      const parsed = FactContract.startTerminalRecordingSchema.parse(input),
        terminalId = idSchema.parse(id);
      await this.recordingCommands.execute(
        key,
        'record-start',
        { terminalId, input: parsed },
        async () => {
          const files = this.ctx.get('files'),
            grants = this.ctx.get('fileGrants');
          if (!files || !grants) throw Error('TERMINAL_RECORDING_FILES_UNAVAILABLE');
          const lease = await files.open(parsed.grantId, 'write', this.lifetime.signal);
          let transferred = false;
          const factory = grantedRecording(lease, () => grants.revoke(parsed.grantId));
          try {
            signal.throwIfAborted();
            this.assertOpen();
            await this.terminals.startRecording(
              terminalId,
              {
                path: lease.path,
                fileName: lease.path,
                timestamps: parsed.timestamps,
                includeRecent: parsed.includeRecent,
              },
              {
                open: async (options) => {
                  const writer = await factory.open(options);
                  transferred = true;
                  return writer;
                },
              },
            );
            return { id: terminalId };
          } finally {
            if (!transferred) {
              await lease.close();
              await grants.revoke(parsed.grantId);
            }
          }
        },
      );
      const recording = this.terminals.get(terminalId).recording;
      if (!recording) throw Error('TERMINAL_RECORDING_RECEIPT_EXPIRED');
      return recording;
    } catch (error) {
      throw this.failure(error);
    }
  }
  @Remote async stopTerminalRecording(
    generation: string,
    key: string,
    id: string,
  ): Promise<FactContract.TerminalRecording> {
    try {
      this.assertGeneration(generation);
      const terminalId = idSchema.parse(id);
      await this.recordingCommands.execute(key, 'record-stop', { terminalId }, async () => {
        await this.terminals.stopRecording(terminalId);
        return { id: terminalId };
      });
      const recording = this.terminals.get(terminalId).recording;
      if (!recording) throw Error('TERMINAL_RECORDING_RECEIPT_EXPIRED');
      return recording;
    } catch (error) {
      throw this.failure(error);
    }
  }
  @Remote getTerminalRecordingOutcome(
    generation: string,
    key: string,
  ): FactContract.TerminalCommandOutcome {
    try {
      this.assertGeneration(generation);
      return this.recordingCommands.outcome(key);
    } catch (error) {
      throw this.failure(error);
    }
  }
  @Remote({ mode: 'stream' })
  async *watchTerminalInformation(
    generation: string,
    id: string,
    signal: AbortSignal,
  ): AsyncIterable<FactContract.TerminalInformationBaseline> {
    const owned = AbortSignal.any([signal, this.lifetime.signal]);
    let revision = 0;
    const follower = Symbol();
    try {
      this.assertGeneration(generation);
      const terminalId = idSchema.parse(id);
      if (this.informationFollowers.size >= 16)
        throw new ApplicationError(
          'CAPACITY_EXCEEDED',
          'Terminal information observation capacity reached',
          503,
        );
      this.informationFollowers.add(follower);
      while (!owned.aborted) {
        this.assertGeneration(generation);
        const snapshot = await this.information.snapshot(terminalId, owned);
        owned.throwIfAborted();
        yield { type: 'baseline', generation, revision: ++revision, snapshot };
        await delay(5000, undefined, { signal: owned });
      }
    } catch (error) {
      if (!owned.aborted) throw this.failure(error);
    } finally {
      this.informationFollowers.delete(follower);
    }
  }
  @Remote recordCommandHistory(
    key: string,
    input: FactContract.RecordCommandHistoryInput,
    generation: string,
  ): FactContract.RecordCommandHistoryResult {
    this.assertGeneration(generation);
    return this.readFacts((facts) => facts.recordHistory(key, input));
  }
  @Remote({ resources: { commandHistory: (key: string, id: string) => id } }) deleteCommandHistory(
    key: string,
    id: string,
    ifMatch: string | undefined,
    generation: string,
  ): FactContract.DeleteCommandHistoryResult {
    this.assertGeneration(generation);
    return this.readFacts((facts) =>
      facts.deleteHistory(key, FactContract.idSchema.parse(id), ifMatch),
    );
  }
  @Remote clearCommandHistory(
    key: string,
    ifMatch: string | undefined,
    generation: string,
  ): FactContract.ClearCommandHistoryResult {
    this.assertGeneration(generation);
    return this.readFacts((facts) => facts.clearHistory(key, ifMatch));
  }
  @Remote({ resources: { fileGrant: (_key: string, grantId: string) => grantId } })
  async importTerminalBackgroundAsset(
    key: string,
    grantId: string,
    generation: string,
    signal: AbortSignal,
  ): Promise<FactContract.TerminalAssetReceipt> {
    try {
      this.assertGeneration(generation);
      const assets = await this.backgroundAssets(signal);
      return assets.application.import(
        FactContract.idSchema.parse(key),
        fileGrantSchema.shape.grantId.parse(grantId),
        generation,
        signal,
      );
    } catch (error) {
      throw terminalAssetFailure(error);
    }
  }
  @Remote({ resources: { terminalBackgroundAsset: (_key: string, id: string) => id } })
  async deleteTerminalBackgroundAsset(
    key: string,
    id: string,
    version: number,
    generation: string,
    signal: AbortSignal,
  ): Promise<FactContract.TerminalAssetDeleteReceipt> {
    try {
      this.assertGeneration(generation);
      const assets = await this.backgroundAssets(signal);
      return assets.application.remove(
        FactContract.idSchema.parse(key),
        FactContract.idSchema.parse(id),
        FactContract.zAssetVersionSchema.parse(version),
        generation,
      );
    } catch (error) {
      throw terminalAssetFailure(error);
    }
  }
  @Remote({ resources: { terminalBackgroundAsset: (id: string) => id } })
  async getTerminalBackgroundAssetContent(
    id: string,
    generation: string,
    signal: AbortSignal,
  ): Promise<FactContract.TerminalBackgroundContentDescriptor> {
    try {
      this.assertGeneration(generation);
      const assets = await this.backgroundAssets(signal),
        asset = assets.application.get(FactContract.idSchema.parse(id));
      return { asset, href: 'terminals/background-assets/' + asset.id };
    } catch (error) {
      throw terminalAssetFailure(error);
    }
  }
  @Remote({ mode: 'stream' })
  async *watchTerminalBackgroundAssets(
    signal: AbortSignal,
  ): AsyncIterable<FactContract.TerminalAssetsUpdate> {
    const assets = await this.backgroundAssets(signal);
    yield* assets.observation.watch(signal);
  }
  private backgroundAssets(signal: AbortSignal): Promise<OwnedTerminalAssets> {
    this.assertOpen();
    const lifetime = AbortSignal.any([signal, this.lifetime.signal]);
    lifetime.throwIfAborted();
    if (this.assets) return Promise.resolve(this.assets);
    if (this.assetWaiters.size >= 64)
      throw new RemoteError('terminals/failure', 'Background assets are unavailable', {
        reason: 'capacity',
      });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.assetWaiters.delete(wake);
        lifetime.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(this.assets!);
      };
      const wake = () => {
          if (this.assets) finish();
        },
        abort = () =>
          finish(
            new RemoteError('terminals/failure', 'Background assets are unavailable', {
              reason: 'closed',
            }),
          );
      const timer = setTimeout(
        () =>
          finish(
            new RemoteError('terminals/failure', 'Background assets are unavailable', {
              reason: 'unavailable',
            }),
          ),
        10000,
      );
      this.assetWaiters.add(wake);
      lifetime.addEventListener('abort', abort, { once: true });
      if (lifetime.aborted) abort();
      else wake();
    });
  }
  @Remote({ mode: 'stream' }) watchTerminalFacts(
    signal: AbortSignal,
  ): AsyncIterable<FactContract.TerminalFactsUpdate> {
    return this.readFacts((facts) => facts.watch(signal));
  }
  @Remote({ resources: { terminal: (_generation: string, id: string) => id } }) getTerminalTransfer(
    generation: string,
    id: string,
  ): FactContract.TerminalTransferState | null {
    this.transferGeneration(generation);
    return this.protocols!.get(FactContract.idSchema.parse(id));
  }
  @Remote({ resources: { terminal: (_generation: string, _key: string, id: string) => id } })
  async performTerminalTransfer(
    generation: string,
    key: string,
    id: string,
    input: FactContract.TerminalTransferAction,
    signal: AbortSignal,
  ): Promise<FactContract.TerminalTransferState> {
    this.transferGeneration(generation);
    signal.throwIfAborted();
    const terminalId = FactContract.idSchema.parse(id),
      action = FactContract.terminalTransferActionSchema.parse(input);
    return this.protocolCommands.execute(key, { generation, terminalId, action }, async () => {
      this.transferGeneration(generation);
      try {
        signal.throwIfAborted();
        return await this.protocols!.perform(terminalId, action);
      } catch (error) {
        throw this.failure(error);
      }
    });
  }
  @Remote async reviewTerminalTransferRecovery(
    generation: string,
    grantId: string,
    signal: AbortSignal,
  ): Promise<FactContract.TerminalTransferRecoveryRecord[]> {
    this.transferGeneration(generation);
    try {
      return await this.protocolStaging!.review(
        grantId,
        AbortSignal.any([this.lifetime.signal, signal]),
      );
    } catch (error) {
      throw this.failure(error);
    }
  }
  @Remote async removeTerminalTransferStage(
    generation: string,
    key: string,
    id: string,
    grantId: string,
    signal: AbortSignal,
  ): Promise<FactContract.TerminalTransferRecoveryRecord[]> {
    this.transferGeneration(generation);
    signal.throwIfAborted();
    FactContract.idSchema.parse(id);
    return this.protocolCommands.execute(
      key,
      { operation: 'remove-stage', generation, id, grantId },
      async () => {
        try {
          return await this.protocolStaging!.remove(id, grantId, this.lifetime.signal);
        } catch (error) {
          throw this.failure(error);
        }
      },
    );
  }
  @Remote async forgetTerminalTransferStage(
    generation: string,
    key: string,
    id: string,
    grantId: string,
    acknowledgeFileRemains: true,
    signal: AbortSignal,
  ): Promise<FactContract.TerminalTransferRecoveryRecord[]> {
    this.transferGeneration(generation);
    signal.throwIfAborted();
    FactContract.idSchema.parse(id);
    if (acknowledgeFileRemains !== true)
      throw this.failure(
        new ApplicationError('VALIDATION_ERROR', 'Acknowledgement is required', 400),
      );
    return this.protocolCommands.execute(
      key,
      { operation: 'forget-stage', generation, id, grantId },
      async () => {
        try {
          return await this.protocolStaging!.remove(id, grantId, this.lifetime.signal, true);
        } catch (error) {
          throw this.failure(error);
        }
      },
    );
  }
  private transferGeneration(generation: string): void {
    this.assertOpen();
    if (generation !== this.ctx.runtimeIdentity.generation)
      throw new RemoteError('terminals/failure', 'Terminal transfer generation is retired', {
        reason: 'stale',
      });
    if (!this.protocols || !this.protocolStaging)
      throw new RemoteError('terminals/failure', 'Terminal transfers are unavailable', {
        reason: 'unavailable',
      });
  }
  private async closeTerminalOwned(id: string): Promise<void> {
    await this.protocols?.closeTerminal(id);
    await this.terminals.close(id);
  }
  private readFacts<T>(operation: (facts: TerminalFactsOwner) => T): T {
    this.assertOpen();
    if (!this.facts)
      throw new RemoteError('terminals/failure', 'Terminal facts are unavailable', {
        reason: 'unavailable',
      });
    try {
      return operation(this.facts);
    } catch (error) {
      throw this.failure(error);
    }
  }
  private assertOpen(): void {
    if (!this.open)
      throw new RemoteError('terminals/failure', 'Terminal service is closed', {
        reason: 'closed',
      });
  }
  private failure(error: unknown): RemoteError<'terminals/failure'> {
    const marked = remoteErrorOf(error);
    if (marked?.code === 'terminals/failure') return marked as RemoteError<'terminals/failure'>;
    if (marked?.code === 'files/failure')
      return new RemoteError('terminals/failure', 'The terminal working directory is unavailable', {
        reason:
          marked.details.reason === 'uncertain' ||
          marked.details.reason === 'unsupported-destination'
            ? 'unavailable'
            : marked.details.reason,
      });
    if (marked?.code === 'connections/failure') {
      const reason = marked.details.reason;
      return new RemoteError('terminals/failure', 'The SSH terminal operation failed', {
        reason,
      });
    }
    if (error instanceof TerminalCommandError)
      return new RemoteError('terminals/failure', 'Terminal command failed', {
        reason: error.reason,
      });
    if (error instanceof ZodError)
      return new RemoteError('terminals/failure', 'Terminal input is invalid', {
        reason: 'invalid-input',
      });
    const reason =
      error instanceof ApplicationError
        ? error.code === 'NOT_FOUND'
          ? 'not-found'
          : error.code === 'CAPACITY_EXCEEDED'
            ? 'capacity'
            : error.code === 'REQUEST_CANCELED'
              ? 'cancelled'
              : 'invalid-input'
        : 'unavailable';
    return new RemoteError('terminals/failure', 'The terminal operation failed', { reason });
  }
  private dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      this.open = false;
      this.commands.stop();
      this.recordingCommands.stop();
      this.lifetime.abort();
      const protocolResults = await Promise.allSettled([this.protocols?.closeAll()]);
      await this.protocolCommands.close();
      this.terminals.stopAdmission();
      this.observation.dispose();
      for (const stream of this.streams) stream.stopAdmission();
      const results = await Promise.allSettled([...this.streams].map((stream) => stream.dispose()));
      this.streams.clear();
      await this.commands.dispose();
      await this.recordingCommands.dispose();
      await Promise.allSettled([...this.creates]);
      const terminalResults = await Promise.allSettled([
        this.information.dispose(),
        this.terminals.dispose(),
      ]);
      if (
        [...protocolResults, ...results, ...terminalResults].some(
          (result) => result.status === 'rejected',
        )
      )
        throw new Error('TERMINAL_DRAIN_FAILED');
    })());
  }
}
