import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  aiContextPreviewRequestSchema,
  aiContextPreviewSchema,
  aiWorkspaceSchema,
} from '@workspace/contracts';
import type { AiService } from '../application/ai-service';
import { errors, security, type RuntimeHttpEnv } from './route-contract';

export function registerAiContextRoutes(
  app: OpenAPIHono<RuntimeHttpEnv>,
  ai: Pick<AiService, 'previewContext' | 'workspace'>,
) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/ai/workspaces/{terminalId}',
      operationId: 'getAiWorkspace',
      security,
      request: { params: z.object({ terminalId: z.uuid() }) },
      responses: {
        200: {
          description: 'Selected terminal workspace and execution target',
          content: { 'application/json': { schema: aiWorkspaceSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await ai.workspace(c.req.valid('param').terminalId), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/ai/context-preview',
      operationId: 'previewAiContext',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: aiContextPreviewRequestSchema } },
        },
      },
      responses: {
        200: {
          description: 'The bounded redacted model request and expiring review receipt',
          content: { 'application/json': { schema: aiContextPreviewSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await ai.previewContext(c.req.valid('json'), c.req.raw.signal), 200),
  );
}
