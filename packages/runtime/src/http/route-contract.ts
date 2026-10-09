import { problemSchema } from '@workspace/contracts';
export type RuntimeHttpEnv = { Variables: { traceId: string } };
const errorResponse = {
  description: 'Problem Details',
  content: { 'application/problem+json': { schema: problemSchema } },
};
export const errors = {
  400: errorResponse,
  401: errorResponse,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
  412: errorResponse,
  413: errorResponse,
  428: errorResponse,
  429: errorResponse,
  500: errorResponse,
  503: errorResponse,
};
export const security = [{ bearerAuth: [] }];
