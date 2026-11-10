import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const tokens = resolve('packages/infra/ui-theme/src/client/tokens.module.css');
const controls = 'packages/api/ui/src/client/controls.module.css';
import { ownedStyleDeclarations } from '../support/owned-product-styles';

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const channels = color
      .slice(1)
      .match(/../gu)
      ?.map((part) => Number.parseInt(part, 16) / 255);
    if (!channels || channels.length !== 3)
      throw new Error(`Expected a #rrggbb color, got ${color}`);
    const linear = channels.map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  };
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

function token(source: string, name: string): string {
  const match = source.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'iu'));
  if (!match?.[1]) throw new Error(`Missing ${name} token`);
  return match[1];
}

describe('Axterm shell semantic contrast', () => {
  it('keeps normal semantic text and on-color text above WCAG AA contrast', async () => {
    const source = await readFile(tokens, 'utf8');
    const colors = {
      canvas: token(source, '--ax-color-canvas'),
      raised: token(source, '--ax-color-surface-raised'),
      text: token(source, '--ax-color-text'),
      mutedText: token(source, '--ax-color-text-muted'),
      primary: token(source, '--ax-color-primary'),
      danger: token(source, '--ax-color-danger'),
      onPrimary: token(source, '--ax-color-on-primary'),
      onDanger: token(source, '--ax-color-on-danger'),
    };

    for (const [name, foreground, background] of [
      ['text on canvas', colors.text, colors.canvas],
      ['muted text on canvas', colors.mutedText, colors.canvas],
      ['muted text on raised surface', colors.mutedText, colors.raised],
      ['on-primary text', colors.onPrimary, colors.primary],
      ['on-danger text', colors.onDanger, colors.danger],
    ] as const) {
      expect(contrastRatio(foreground, background), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('uses semantic on-color roles instead of low-contrast white shell text', async () => {
    const primary = await ownedStyleDeclarations(controls, /^\.primary$/u),
      danger = await ownedStyleDeclarations(controls, /^\.destructive$/u);
    expect(
      primary.some(
        (rule) => rule.get('background') === '#2fc7a1' && rule.get('color') === '#06201b',
      ),
    ).toBe(true);
    expect(
      danger.some(
        (rule) => rule.get('background') === '#f06473' && rule.get('color') === '#101617',
      ),
    ).toBe(true);
  });

  it('keeps disabled buttons readable without fading their text below contrast', async () => {
    const rules = await ownedStyleDeclarations(controls, /\.button:disabled/u);
    expect(
      rules.some(
        (rule) =>
          rule.get('opacity') === '1' &&
          rule.get('background') === '#343434' &&
          rule.get('color') === '#b0b0b0',
      ),
    ).toBe(true);
    expect(contrastRatio('#b0b0b0', '#343434')).toBeGreaterThanOrEqual(4.5);
  });

  it('does not animate primary text and background through low-contrast intermediate colors', async () => {
    for (const path of [
      controls,
      'packages/plugins/catalog/src/client/ui/editor/editor.module.css',
    ]) {
      const rules = await ownedStyleDeclarations(path, /(?:\.primary$|button\.primary$)/u);
      for (const rule of rules) {
        const transition = rule.get('transition');
        if (transition !== undefined) expect(transition).toBe('border-color 120ms ease');
      }
    }
  });
});
