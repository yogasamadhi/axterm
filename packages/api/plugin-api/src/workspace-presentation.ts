import { terminalVisualSettingsSchema } from './schemas/terminal-visual.ts';
import { z } from 'zod';
export const workspacePresentationSlotSchema = z.string().regex(/^(?:desktop_[0-9]{1,3}|web)$/);
export const workspaceLayoutModeSchema = z.enum([
  'c1',
  'c2',
  'r2',
  'c3',
  'r3',
  'c2x2',
  'c1r2',
  'r1c2',
]);
export type WorkspaceLayoutMode = z.infer<typeof workspaceLayoutModeSchema>;
const tabId = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('\0'));
export const workspacePresentationSchema = z
  .object({
    section: z.string().min(1).max(128),
    sidebarOpen: z.boolean(),
    activeTabId: tabId.nullable(),
    layout: z
      .object({
        mode: workspaceLayoutModeSchema,
        paneTabIds: z.array(tabId.nullable()).min(1).max(4),
        focusedPane: z.number().int().min(0).max(3),
        maximizedPane: z.number().int().min(0).max(3).optional(),
        ratios: z
          .object({
            x: z.number().min(10).max(90),
            x2: z.number().min(10).max(90),
            y: z.number().min(10).max(90),
            y2: z.number().min(10).max(90),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    tabs: z
      .array(
        z
          .object({
            id: tabId,
            kind: z.string().min(1).max(128),
            caption: z.string().min(1).max(512),
            title: z.string().min(1).max(512).optional(),
            terminalVisual: terminalVisualSettingsSchema.optional(),
            pinned: z.boolean().optional(),
            paneIndex: z.number().int().min(0).max(3).optional(),
            tabNumber: z.number().int().min(1).max(9999).optional(),
          })
          .strict(),
      )
      .max(128),
  })
  .strict()
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 256 * 1024,
    'Workspace presentation is too large',
  )
  .superRefine((value, ctx) => {
    if (new Set(value.tabs.map((tab) => tab.id)).size !== value.tabs.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate workspace tab' });
    if (value.activeTabId && !value.tabs.some((tab) => tab.id === value.activeTabId))
      ctx.addIssue({ code: 'custom', message: 'Unknown active workspace tab' });
    if (value.layout) {
      const count =
        value.layout.mode === 'c1'
          ? 1
          : ['c2', 'r2'].includes(value.layout.mode)
            ? 2
            : value.layout.mode === 'c2x2'
              ? 4
              : 3;
      const ids = value.layout.paneTabIds.filter((id) => id !== null);
      const ratios = value.layout.ratios;
      if (
        ratios &&
        ((value.layout.mode === 'c3' && ratios.x2 - ratios.x < 10) ||
          (value.layout.mode === 'r3' && ratios.y2 - ratios.y < 10))
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid workspace pane ratios' });
      if (
        value.layout.paneTabIds.length !== count ||
        value.layout.focusedPane >= count ||
        (value.layout.maximizedPane !== undefined && value.layout.maximizedPane >= count) ||
        new Set(ids).size !== ids.length ||
        value.tabs.some((tab) => (tab.paneIndex ?? 0) >= count) ||
        value.layout.paneTabIds.some(
          (id, index) =>
            id && !value.tabs.some((tab) => tab.id === id && (tab.paneIndex ?? 0) === index),
        )
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid workspace pane assignment' });
    }
  });
export type WorkspacePresentation = z.infer<typeof workspacePresentationSchema>;
export const workspacePresentationRecordSchema = z
  .object({
    version: z.number().int().positive(),
    generation: z.uuid(),
    lastCommandId: z.uuid(),
    presentation: workspacePresentationSchema,
  })
  .strict();
export type WorkspacePresentationRecord = z.infer<typeof workspacePresentationRecordSchema>;
export const workspacePresentationRecordsSchema = z
  .record(
    z.string().regex(/^[a-f0-9]{32}_(?:desktop_[0-9]{1,3}|web)$/),
    workspacePresentationRecordSchema,
  )
  .refine((value) => Object.keys(value).length <= 128, 'Workspace window capacity exceeded')
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 4 * 1024 * 1024,
    'Workspace presentation capacity exceeded',
  );
export interface WorkspacePresentationSnapshot {
  readonly type: 'baseline';
  readonly generation: string;
  readonly slot: string;
  readonly record: WorkspacePresentationRecord | null;
}
export interface WorkspacePresentationReceipt {
  readonly version: number;
  readonly settingsVersion: number;
  readonly cursor: number;
}

export interface WorkspacePresentationBinding {
  readonly importRevision: number;
  readonly key: string;
  readonly generation: string;
}
