import { access, readFile } from 'node:fs/promises';
import { globSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkStyleOwnership } from '../../scripts/level3-style-check.mjs';
import { ownedStyleDeclarations } from '../support/owned-product-styles';
const theme = 'packages/infra/ui-theme/src/client';
const editor = 'packages/plugins/catalog/src/client/ui/editor/editor.module.css';
describe('Axterm product-shell style provenance', () => {
  it('uses only Axterm-named shell entry points without historical-reference copy', async () => {
    for (const file of ['tokens.module.css', 'semantic-roles.module.css']) {
      const source = await readFile(resolve(theme, file), 'utf8');
      expect(source).not.toMatch(/\b(?:legacy-prototype|parity|upstream)\b/iu);
    }
    for (const file of ['legacy-prototype-parity.tokens.css', 'legacy-prototype-shell.css'])
      await expect(access(resolve(theme, file))).rejects.toThrow();
  });
  it('uses the mint product accent and excludes the retired blue product marks', async () => {
    const workspace = await ownedStyleDeclarations(
      'packages/plugins/workspace/src/client/workspace.module.css',
      /^\.tab-number$/u,
    );
    expect(
      workspace.some(
        (rule) => rule.get('background') === '#2fc7a1' && rule.get('color') === '#06201b',
      ),
    ).toBe(true);
    const host = await ownedStyleDeclarations(editor, /^\.modal\.host-bookmark-modal$/u),
      protocol = await ownedStyleDeclarations(editor, /^\.modal\.protocol-bookmark-modal$/u),
      actions = await ownedStyleDeclarations(
        editor,
        /^\.protocol-bookmark-form > \.modal-actions$/u,
      ),
      profiles = await ownedStyleDeclarations(
        'packages/plugins/catalog/src/client/ui/profiles/profiles.module.css',
        /\.connection-profile-basics input:focus$/u,
      );
    expect(
      host.some(
        (rule) =>
          rule.get('width') === 'min(920px, calc(100vw - 40px))' &&
          rule.get('border-radius') === '12px',
      ),
    ).toBe(true);
    expect(
      protocol.some(
        (rule) =>
          rule.get('width') === 'min(820px, calc(100vw - 40px))' &&
          rule.get('border-color')?.includes('#2fc7a1'),
      ),
    ).toBe(true);
    expect(
      actions.some(
        (rule) =>
          rule.get('position') === 'sticky' && rule.get('border-top') === '1px solid #3c3c3c',
      ),
    ).toBe(true);
    expect(
      profiles.some(
        (rule) => rule.get('border-color') === '#2fc7a1' && rule.get('box-shadow')?.includes('24%'),
      ),
    ).toBe(true);
    const panels = await readFile(
      'packages/plugins/catalog/src/client/ui/editor/protocol-editors.tsx',
      'utf8',
    );
    expect([
      ...panels.matchAll(/data-protocol="(?:ftp|telnet|serial|rdp|vnc|spice|web)"/gu),
    ]).toHaveLength(7);
    expect([...panels.matchAll(/classes\('form-grid protocol-bookmark-form'\)/gu)]).toHaveLength(7);
    expect([...panels.matchAll(/<input\s+data-autofocus/gu)]).toHaveLength(7);
    expect(await readFile(editor, 'utf8')).not.toMatch(
      /host-bookmark-shell-(?:tabs|sidebar|toolbar|search|tree)|host-bookmark-protocol-heading|host-field-run-script|#266aa2|#122a39/iu,
    );
    const empty = await readFile('packages/plugins/terminals/src/client/ui.tsx', 'utf8');
    expect(empty).toContain("props.renderSlot('workspace.empty.actions', owner)");
    expect(empty).not.toMatch(/empty-pane-(?:brand|shape|sort)/u);
    const icon = await readFile('apps/desktop/build/icon.svg', 'utf8');
    expect(icon).toContain('stop-color="#56d8aa"');
    expect(icon).not.toContain('#55cfe0');
  });
  it('keeps saturated blue out of product CSS and renderer utility classes', async () => {
    // ADR-173 replaces literal/utility styles with owned theme roles; the gate rejects every private color literal.
    expect(checkStyleOwnership().styles).toBeGreaterThan(0);
    const paths = globSync('packages/{api,infra,plugins}/*/src/client/**/*.{tsx,css}');
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths)
      expect(await readFile(path, 'utf8'), path).not.toMatch(
        /\b(?:bg|text|border|ring|outline|decoration|from|via|to)-(?:blue|sky|cyan|indigo)(?:-\d{2,3})?\b/giu,
      );
  });
});
