import { describe, expect, it } from 'vitest';
import { auditLegacyUiKeys } from '../../scripts/localization/audit-legacy-ui-keys.mjs';

describe('transition locale-key scope', () => {
  it('accounts for literal and fixed dynamic UI keys without accepting new silent fallback', () => {
    const report = auditLegacyUiKeys();
    expect(report.catalogKeyCount).toBe(42);
    expect(report.usedKeys).toHaveLength(42);
    expect(report.unusedKeys).toEqual([]);
    expect(report.literalCalls).toBe(52);
    expect(report.dynamicCalls).toHaveLength(5);
    expect(report.missingKeys).toEqual([]);
    expect(report.unexpectedMissingKeys).toEqual([]);
    expect(report.unrecognizedDynamicCalls).toEqual([]);
    expect(report.usedKeys).toContain('settingSync');
    expect(report.usedKeys).toContain('twoColumnsBottom');
  });
});
