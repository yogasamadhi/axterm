import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { piCatalogProviderSchema, aiSkillSchema } from '@workspace/contracts';
import type { AiService } from '../application/ai-service';
import { errors, security, type RuntimeHttpEnv } from './route-contract';

export function registerAiCatalogRoutes(
  app: OpenAPIHono<RuntimeHttpEnv>,
  ai: Pick<AiService, 'catalog' | 'skills'>,
) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/ai/skills',
      operationId: 'getAiSkills',
      security,
      responses: {
        200: {
          description: 'Bundled skills loaded and validated by Pi',
          content: { 'application/json': { schema: z.array(aiSkillSchema).max(64) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(ai.skills(), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/ai/catalog',
      operationId: 'getAiCatalog',
      security,
      responses: {
        200: {
          description: 'Pinned Pi API-key provider and model catalog',
          content: { 'application/json': { schema: z.array(piCatalogProviderSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(ai.catalog(), 200),
  );
}
