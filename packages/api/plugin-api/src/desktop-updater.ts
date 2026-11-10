import { z } from 'zod';
export const updaterStatusSchema = z
  .object({
    state: z.enum(['disabled', 'idle', 'checking', 'available', 'downloading', 'ready', 'error']),
    availableVersion: z.string().max(128).optional(),
    progress: z.number().min(0).max(100).optional(),
    errorCode: z
      .string()
      .regex(/^[A-Z0-9_]{1,100}$/u)
      .optional(),
  })
  .strict();
export const updaterActionSchema = z
  .object({ action: z.enum(['check', 'download', 'cancel', 'install']) })
  .strict();
// SemVer 2.0.0: numeric prerelease identifiers cannot have leading zeroes;
// build metadata is permitted but does not affect update precedence.
export const semverVersionSchema = z
  .string()
  .max(128)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
  );
export const signedUpdateManifestSchema = z
  .object({
    version: semverVersionSchema,
    publishedAt: z.iso.datetime(),
    notes: z.string().max(20_000).default(''),
    artifact: z
      .object({
        url: z.url().max(4_096),
        fileName: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .regex(/^[0-9A-Za-z][0-9A-Za-z._+-]*$/),
        size: z
          .number()
          .int()
          .positive()
          .max(4 * 1024 * 1024 * 1024),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        signature: z
          .string()
          .regex(/^[A-Za-z0-9+/]+={0,2}$/)
          .max(512),
      })
      .strict(),
  })
  .strict();

export type UpdaterStatus = z.infer<typeof updaterStatusSchema>;
export type UpdaterAction = z.infer<typeof updaterActionSchema>['action'];
export type SignedUpdateManifest = z.infer<typeof signedUpdateManifestSchema>;
export interface DesktopUpdaterBaseline {
  readonly type: 'baseline';
  readonly generation: string;
  readonly status: UpdaterStatus;
}
export interface DesktopUpdaterReplacement {
  readonly type: 'replace';
  readonly generation: string;
  readonly status: UpdaterStatus;
}
export type DesktopUpdaterUpdate = DesktopUpdaterBaseline | DesktopUpdaterReplacement;
/** Shell implementation port; it accepts no renderer paths, command lines or arbitrary URLs. */
export interface DesktopUpdaterPort {
  status(): UpdaterStatus;
  perform(action: UpdaterAction): Promise<UpdaterStatus>;
  close(): Promise<void>;
}
