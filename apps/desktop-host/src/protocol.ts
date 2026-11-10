import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { IndexInjection } from '@axterm/infra-web-server';
const common = {
  kind: z.literal('axterm-desktop-control'),
  version: z.literal(1),
  generation: z.uuid(),
};
export const initializeSchema = z
  .object({
    ...common,
    type: z.literal('initialize'),
    home: z.string().min(1).max(4096).refine(isAbsolute),
    verifier: z
      .object({ generation: z.uuid(), digest: z.string().regex(/^[0-9a-f]{64}$/) })
      .strict(),
  })
  .strict()
  .refine((value) => value.generation === value.verifier.generation);
export const parentControlSchema = z.discriminatedUnion('type', [
  initializeSchema,
  z.object({ ...common, type: z.literal('shutdown') }).strict(),
  z.object({ ...common, type: z.literal('inspect-quit'), id: z.uuid() }).strict(),
]);
export type HostInitialize = z.infer<typeof initializeSchema>;
export type ParentControl = z.infer<typeof parentControlSchema>;

const placement = z.enum(['head', 'body']);
const source = z.string().max(4096);
const text = z.string().max(262144);
export const indexInjectionSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('global'),
        name: z
          .string()
          .regex(/^[A-Za-z_$][\w$]*$/)
          .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value)),
        value: z.json().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('script'),
        placement,
        text: text.refine((value) => !/<\/script/i.test(value)),
      })
      .strict(),
    z.object({ kind: z.literal('script-src'), placement, src: source }).strict(),
    z.object({ kind: z.literal('script-preload'), src: source }).strict(),
    z
      .object({ kind: z.literal('style'), text: text.refine((value) => !/<\/style/i.test(value)) })
      .strict(),
    z.object({ kind: z.literal('html'), placement, html: text }).strict(),
  ])
  .transform((row): IndexInjection => (row.kind === 'global' ? { ...row, value: row.value } : row));
export function isDesktopHostOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname) &&
      Number(url.port) > 0 &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
export const hostControlSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...common,
      type: z.literal('ready'),
      origin: z.string().refine(isDesktopHostOrigin),
      injections: z.array(indexInjectionSchema).max(4096),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal('inspection'),
      id: z.uuid(),
      active: z.boolean(),
      known: z.boolean(),
    })
    .strict(),
  z.object({ ...common, type: z.literal('stopped') }).strict(),
  z
    .object({
      ...common,
      type: z.literal('failed'),
      code: z.enum(['HOST_STARTUP_FAILED', 'HOST_CONTROL_INVALID']),
    })
    .strict(),
]);
export type HostControl = z.infer<typeof hostControlSchema>;
/** A bounded strict startup/supervision boundary; private Native capability frames use a different kind. */
export function parseHostControl(value: unknown): HostControl {
  try {
    if (JSON.stringify(value).length > 2 * 1024 * 1024) throw new Error();
    return hostControlSchema.parse(value);
  } catch {
    throw new Error('HOST_CONTROL_INVALID');
  }
}

/** Finite migration-worker startup contracts; never accepted by the running Desktop Host dispatch. */
export const homeCopyInitializeSchema = z
  .object({
    kind: z.literal('axterm-home-copy'),
    version: z.literal(1),
    source: z.string().min(1).max(4096).refine(isAbsolute),
    home: z.string().min(1).max(4096).refine(isAbsolute),
    action: z.enum(['copy', 'resume', 'retry']),
  })
  .strict();
export const homeCopyFailureSchema = z.enum([
  'DATA_COPY_RECOVERY_REQUIRED',
  'DATA_COPY_NO_SPACE',
  'DATA_COPY_SOURCE_INVALID',
  'DATA_COPY_TARGET_CONFLICT',
  'DATA_COPY_VAULT_INVALID',
  'DATA_COPY_MISSING_REFERENCE',
  'DATA_COPY_SOURCE_CHANGED',
]);
export const homeCopyResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      kind: z.literal('axterm-home-copy-result'),
      version: z.literal(1),
      ok: z.literal(true),
      id: z.uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('axterm-home-copy-result'),
      version: z.literal(1),
      ok: z.literal(false),
      code: homeCopyFailureSchema,
    })
    .strict(),
]);
export const homeCopyReceiptSchema = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    source: z.string().regex(/^[0-9a-f]{64}$/),
    state: z.enum(['copying', 'prepared', 'publishing', 'committed']),
    published: z.array(z.enum(['data-v2', 'vault-v2', 'desktop'])).max(3),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const order = ['data-v2', 'vault-v2', 'desktop'];
    if (
      value.published.some((entry, index) => entry !== order[index]) ||
      (value.state === 'committed' && value.published.length !== 3) ||
      (['copying', 'prepared'].includes(value.state) && value.published.length !== 0)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid migration publication state' });
  });
export type HomeCopyResult = z.infer<typeof homeCopyResultSchema>;
export type HomeCopyFailure = z.infer<typeof homeCopyFailureSchema>;
