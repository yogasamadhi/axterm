import { z } from 'zod';
export const nativeWebUrlSchema = z
  .url()
  .max(4_096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Expected a credential-free HTTP(S) URL');
export const nativeWebViewBoundsSchema = z
  .object({
    x: z.number().int().min(0).max(32_768),
    y: z.number().int().min(0).max(32_768),
    width: z.number().int().min(1).max(32_768),
    height: z.number().int().min(1).max(32_768),
  })
  .strict();
export const nativeWebViewCreateSchema = z
  .object({
    id: z.uuid(),
    windowId: z.uuid(),
    url: nativeWebUrlSchema,
    userAgent: z.string().trim().min(1).max(512).nullable().default(null),
  })
  .strict();
export const nativeWebViewPresentationSchema = z
  .object({
    bounds: nativeWebViewBoundsSchema.optional(),
    visible: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Expected a presentation change');
export const nativeWebViewActionSchema = z
  .object({
    action: z.enum([
      'back',
      'forward',
      'reload',
      'stop',
      'set-zoom',
      'open-external',
      'open-blocked-external',
    ]),
    zoomFactor: z.number().min(0.25).max(5).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === 'set-zoom' && value.zoomFactor === undefined)
      context.addIssue({
        code: 'custom',
        path: ['zoomFactor'],
        message: 'Zoom factor is required',
      });
    if (value.action !== 'set-zoom' && value.zoomFactor !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['zoomFactor'],
        message: 'Zoom factor is only valid for set-zoom',
      });
  });
export const nativeWebViewAuthResponseSchema = z
  .object({
    challengeId: z.uuid(),
    username: z.string().max(1_024),
    password: z.string().max(16_384),
  })
  .strict();
export const nativeWebViewStateSchema = z
  .object({
    id: z.uuid(),
    state: z.enum(['created', 'loading', 'ready', 'auth-required', 'failed']),
    url: nativeWebUrlSchema,
    title: z.string().max(1_024),
    loading: z.boolean(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    zoomFactor: z.number().min(0.25).max(5),
    visible: z.boolean(),
    blockedUrl: nativeWebUrlSchema.optional(),
    errorCode: z.string().max(100).optional(),
    authChallenge: z
      .object({
        id: z.uuid(),
        host: z.string().max(253),
        realm: z.string().max(512).optional(),
        isProxy: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type NativeWebViewBounds = z.infer<typeof nativeWebViewBoundsSchema>;
export type NativeWebViewCreate = z.infer<typeof nativeWebViewCreateSchema>;
export type NativeWebViewPresentation = z.infer<typeof nativeWebViewPresentationSchema>;
export type NativeWebViewAction = z.infer<typeof nativeWebViewActionSchema>;
export type NativeWebViewAuthResponse = z.infer<typeof nativeWebViewAuthResponseSchema>;
export type NativeWebViewState = z.infer<typeof nativeWebViewStateSchema>;

/** Native view primitives only; session workflows remain in the Host plugin. */
export interface NativeWebViews {
  create(input: NativeWebViewCreate, signal: AbortSignal): Promise<NativeWebViewState>;
  state(windowId: string, id: string, signal: AbortSignal): Promise<NativeWebViewState>;
  present(
    windowId: string,
    id: string,
    input: NativeWebViewPresentation,
    signal: AbortSignal,
  ): Promise<NativeWebViewState>;
  perform(
    windowId: string,
    id: string,
    input: NativeWebViewAction,
    signal: AbortSignal,
  ): Promise<NativeWebViewState>;
  authenticate(
    windowId: string,
    id: string,
    input: NativeWebViewAuthResponse,
    signal: AbortSignal,
  ): Promise<NativeWebViewState>;
  close(windowId: string, id: string, signal: AbortSignal): Promise<true>;
}
