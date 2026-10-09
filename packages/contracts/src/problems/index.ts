import { z } from 'zod';

export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string(),
  traceId: z.uuid(),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
});
export type ProblemDetails = z.infer<typeof problemSchema>;
