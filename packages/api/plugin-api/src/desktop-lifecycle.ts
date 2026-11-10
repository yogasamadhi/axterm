import { z } from 'zod';
export const desktopLifecycleStateSchema = z
  .object({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    state: z.enum(['active', 'suspended']),
    lastEvent: z.enum(['started', 'suspend', 'resume']),
    changedAt: z.iso.datetime(),
  })
  .strict();
export type DesktopLifecycleState = z.infer<typeof desktopLifecycleStateSchema>;
export interface NativeDesktopLifecycle {
  state(signal: AbortSignal): Promise<DesktopLifecycleState>;
}
