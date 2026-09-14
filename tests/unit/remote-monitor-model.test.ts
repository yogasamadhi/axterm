import { describe, expect, it } from 'vitest';
import {
  compactDuration,
  formatBytes,
  usageLevel,
} from '../../apps/desktop/src/renderer/src/app/remote-monitor/remote-monitor-model';

describe('remote monitor presentation model', () => {
  it('uses warning hysteresis instead of flickering at thresholds', () => {
    expect(usageLevel(80)).toBe('warning');
    expect(usageLevel(76, 'warning')).toBe('warning');
    expect(usageLevel(74, 'warning')).toBe('normal');
    expect(usageLevel(90, 'warning')).toBe('critical');
    expect(usageLevel(86, 'critical')).toBe('critical');
    expect(usageLevel(84, 'critical')).toBe('warning');
  });

  it('formats compact bounded summaries', () => {
    expect(formatBytes(1_536)).toBe('1.5 KiB');
    expect(formatBytes(null)).toBe('—');
    expect(compactDuration(90_061)).toBe('1d 01h');
    expect(compactDuration(61)).toBe('1m 01s');
  });
});
