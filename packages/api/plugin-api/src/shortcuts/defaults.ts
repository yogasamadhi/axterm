import { normalizeBinding, type ShortcutBinding, type ShortcutProfile } from './binding.ts';
import { bindingIssue } from './configuration.ts';
/** Keep retained Desktop defaults and explicitly leave unsupported browser/platform combinations unbound. */
export function createShortcutDefaults(
  other: ShortcutBinding | undefined,
  mac: ShortcutBinding | null | undefined = other,
): Partial<Record<ShortcutProfile, ShortcutBinding>> {
  const defaults: Partial<Record<ShortcutProfile, ShortcutBinding>> = {};
  for (const runtime of ['desktop', 'web'] as const)
    for (const platform of ['macos', 'windows', 'linux'] as const) {
      const binding = platform === 'macos' ? mac : other;
      if (binding && bindingIssue(normalizeBinding(binding, platform), runtime, platform) === null)
        defaults[`${runtime}:${platform}`] = binding;
    }
  return defaults;
}
