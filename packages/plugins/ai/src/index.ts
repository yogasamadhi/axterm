import type { Context } from '@deepseek-ai/cordis';
import { aiRunEventSchema } from '@axterm/plugin-api/ai';
import { OwnedAiApplication, aiOwnerConfigSchema } from './adapters/application-owner.ts';
import { AiController } from './controller.ts';
import { AiMcpSources } from './adapters/mcp-sources.ts';
// AI application owner; default Desktop/Web Profiles compose its complete execution and Client slice.
export { AiRepository } from './adapters/repository.ts';
export { AiStorage } from './adapters/storage.ts';
export { AiRunJournal } from './adapters/run-journal.ts';

export { AiService } from './application/ai-service.ts';
export { AiFacts } from './adapters/facts.ts';

export { AiToolService } from './application/ai-tool-service.ts';
export { AiToolResources } from './adapters/tool-resources.ts';

export { AiOwnerLease } from './adapters/owner-coordination.ts';

export { OwnedAiApplication, AiController };

export const inject = [
  'runtimeIdentity',
  'storage',
  'storageDomain',
  'engines',
  'credentials',
  'subprocess',
  'terminals',
  'connections',
  'remoteFiles',
  'files',
  'desktopTaskInspection',
];
export async function apply(ctx: Context, raw: unknown): Promise<void> {
  const config = aiOwnerConfigSchema.parse(raw);
  const owner = new OwnedAiApplication(ctx, config, {
    publish: (_type, payload) => {
      const event = aiRunEventSchema.parse(payload);
      try {
        ctx.emit('ai/run-event', event);
      } catch {
        console.warn('AI_REALTIME_OBSERVER_FAILED');
      }
    },
  });
  ctx.effect(() => () => owner.close());
  const application = await owner.ready();
  const mcp = new AiMcpSources(application.tools, application.service);
  ctx.provide('aiMcpTools', mcp);
  ctx.effect(() => () => mcp.close());
  new AiController(ctx, application, owner, config.profile);
}
