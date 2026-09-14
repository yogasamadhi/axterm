import type {
  SshConfigImportDraft,
  SshConfigImportPreviewItem,
  SshConfigImportResult,
} from '@workspace/contracts';

export const importStatusLabelKeys = {
  imported: 'sshConfigImport.willImport',
  linked: 'sshConfigImport.willLink',
  unchanged: 'sshConfigImport.unchanged',
  skipped: 'sshConfigImport.skip',
} as const;

export const resultStatusLabelKeys = {
  imported: 'sshConfigImport.imported',
  linked: 'sshConfigImport.linked',
  unchanged: 'sshConfigImport.noChange',
  skipped: 'sshConfigImport.skipped',
} as const;

export interface IncludeGrantBinding {
  includeId: string;
  grantId: string;
}

export function replaceIncludeGrant(
  bindings: IncludeGrantBinding[],
  replacement: IncludeGrantBinding,
): { bindings: IncludeGrantBinding[]; removedGrantIds: string[] } {
  const removed = bindings.filter(
    ({ includeId }) =>
      includeId === replacement.includeId || includeId.startsWith(`${replacement.includeId}/`),
  );
  return {
    bindings: [
      ...bindings.filter(({ includeId }) => !removed.some((item) => item.includeId === includeId)),
      replacement,
    ],
    removedGrantIds: removed.map(({ grantId }) => grantId),
  };
}

export function draftsFromPreview(items: SshConfigImportPreviewItem[]): SshConfigImportDraft[] {
  return items.flatMap(({ draft }) => (draft ? [structuredClone(draft)] : []));
}

export function replaceDraft(
  drafts: SshConfigImportDraft[],
  replacement: SshConfigImportDraft,
): SshConfigImportDraft[] {
  return drafts.map((draft) => (draft.id === replacement.id ? replacement : draft));
}

export function parseEditedDraft(
  source: string,
  expectedId: string,
  parse: (value: unknown) => SshConfigImportDraft,
  messages: { invalidJson: string; immutableId: string },
): SshConfigImportDraft {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    throw new Error(messages.invalidJson);
  }
  const parsed = parse(json);
  if (parsed.id !== expectedId) throw new Error(messages.immutableId);
  return parsed;
}

export function selectedDraftCount(drafts: SshConfigImportDraft[]): number {
  return drafts.filter(({ selected }) => selected).length;
}

export function resultHasChanges(result: SshConfigImportResult): boolean {
  return result.createdHosts.length > 0 || result.createdBookmarks.length > 0;
}
