import type { FilesTranslator as Translator } from './locales.ts';
export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}

export function messageOf(value: unknown, x?: Translator) {
  return value instanceof Error && !/^FILES_[A-Z_]+$/u.test(value.message)
    ? value.message
    : (x?.('common.operationFailed') ?? 'Operation failed');
}
