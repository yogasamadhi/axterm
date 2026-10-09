import type { useI18n } from '../../i18n/context';
type Translator = ReturnType<typeof useI18n>['x'];
export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}

export function messageOf(value: unknown, x?: Translator) {
  return value instanceof Error
    ? value.message
    : (x?.('common.operationFailed') ?? 'Operation failed');
}
