import { describe, expect, it } from 'vitest';
import type { TriggerRule } from '../../packages/contracts/src';
import { triggerRuleInputSchema } from '../../packages/contracts/src';
import {
  TriggerEngine,
  validateTriggerPattern,
} from '../../packages/runtime/src/application/trigger-engine';
import {
  BOOKMARK_TRIGGER_PRESET_OPTIONS,
  buildBookmarkTriggerPreset,
} from '../../apps/desktop/src/renderer/src/app/bookmarks/bookmark-trigger-presets';
import { translateAxterm } from '../../apps/desktop/src/renderer/src/i18n/core';

const timestamp = '2026-09-25T00:00:00.000Z';

function materialize(index: number): TriggerRule {
  const preset = BOOKMARK_TRIGGER_PRESET_OPTIONS[index]!;
  const fields = buildBookmarkTriggerPreset(preset.id, translateAxterm('en', preset.nameKey));
  return {
    ...fields,
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
  };
}

describe('Axterm bookmark trigger presets', () => {
  it('keeps both opt-in workflows named in all four supported languages', () => {
    expect(BOOKMARK_TRIGGER_PRESET_OPTIONS).toHaveLength(2);
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja'] as const) {
      for (const preset of BOOKMARK_TRIGGER_PRESET_OPTIONS) {
        expect(translateAxterm(locale, preset.labelKey)).toBeTruthy();
        expect(translateAxterm(locale, preset.nameKey)).toBeTruthy();
      }
    }
  });

  it('sends only Space for a split pager prompt, never Enter or a credential', () => {
    const rule = materialize(0);
    expect(triggerRuleInputSchema.safeParse(rule).success).toBe(false);
    const {
      id: _id,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      version: _version,
      ...input
    } = rule;
    expect(triggerRuleInputSchema.safeParse(input).success).toBe(true);
    const fired: Array<{ action: string; matched: string }> = [];
    const engine = new TriggerEngine(({ action, matched }) => fired.push({ action, matched }));
    engine.setRules([rule]);
    engine.push('--Mo');
    expect(fired).toEqual([]);
    engine.push('re--');
    expect(fired).toEqual([{ action: 'send', matched: '--More--' }]);
    expect(rule.action).toEqual({ type: 'send', value: ' ' });
    expect(rule.sendEnter).toBe(false);
    engine.dispose();
  });

  it('notifies for a password prompt without an automatic secret or host-key response', () => {
    const rule = materialize(1);
    validateTriggerPattern(rule);
    const fired: Array<{ action: string; matched: string }> = [];
    const engine = new TriggerEngine(({ action, matched }) => fired.push({ action, matched }));
    engine.setRules([rule]);
    engine.push('[sudo] password for admin:');
    expect(fired).toEqual([{ action: 'notify', matched: 'password for admin:' }]);
    expect(rule.action).toEqual({ type: 'notify', value: '' });
    expect(rule.sendEnter).toBe(false);
    engine.dispose();
  });
});
