import { describe, expect, it } from 'vitest';
import {
  inspectStyleSource,
  inspectInlineStyle,
  mapCssVariables,
} from '../../scripts/level3-style-policy.mjs';
const file = 'packages/plugins/example/src/client/view.module.css';
const definitions = new Set([
  '--ax-color-canvas',
  '--ax-color-text',
  '--ax-font-size-body',
  '--ax-layer-menu',
  '--ax-radius-control',
  '--ax-shadow-menu',
  '--ax-motion-fast',
]);
describe('DSH theme ownership boundary', () => {
  it('accepts semantic operational CSS and keeps layout geometry with its owner', () => {
    expect(
      inspectStyleSource(
        file,
        '.view { background:var(--ax-color-canvas);color:var(--ax-color-text);font-size:var(--ax-font-size-body);width:360px;padding:8px;z-index:var(--ax-layer-menu);border-radius:var(--ax-radius-control);box-shadow:var(--ax-shadow-menu);transition:opacity var(--ax-motion-fast);}',
        definitions,
      ),
    ).toEqual([]);
  });
  it.each([
    'color:#fff',
    'background:rgb(0 0 0 / 30%)',
    'border:1px solid red',
    'font-size:12px',
    'border-radius:6px',
    'box-shadow:0 2px 8px #0008',
    'z-index:1000',
    'transition:opacity 120ms ease',
  ])('rejects private visual literals: %s', (declaration) => {
    expect(inspectStyleSource(file, `.view{${declaration}}`, definitions).length).toBeGreaterThan(
      0,
    );
  });
  it.each([
    'color:var(--shell-text)',
    'color:var(--ax-color-absent)',
    'color:var(--ax-color-text,#fff)',
    '--ax-color-private:#fff',
    '--primary:#fff',
  ])('rejects legacy, unknown, fallback and private palettes: %s', (declaration) => {
    expect(inspectStyleSource(file, `.view{${declaration}}`, definitions).length).toBeGreaterThan(
      0,
    );
  });
  it('rejects local theme selectors and unscoped operational styles', () => {
    expect(
      inspectStyleSource(
        file,
        ':global(:root[data-ax-theme=light]) .view {color:var(--ax-color-text)}',
        definitions,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      inspectStyleSource(file.replace('.module', ''), '.view{}', definitions).length,
    ).toBeGreaterThan(0);
    expect(inspectStyleSource(file, '.view{', definitions).length).toBeGreaterThan(0);
  });
  it('admits the theme owner palette and provider-owned geometry from Radix', () => {
    expect(
      inspectStyleSource(
        'packages/infra/ui-theme/src/client/tokens.module.css',
        ':global(:root){--ax-color-text:#fff}',
        definitions,
      ),
    ).toEqual([]);
    expect(
      inspectStyleSource(
        file,
        '.view{max-height:var(--radix-select-content-available-height);}',
        definitions,
      ),
    ).toEqual([]);
  });
  it('applies the same rules to static inline visual properties while allowing runtime domain data', () => {
    expect(
      inspectInlineStyle(
        file.replace('.module.css', '.tsx'),
        'const element=<div style={{color:"#fff",fontSize:12}}/>;',
        definitions,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      inspectInlineStyle(
        file.replace('.module.css', '.tsx'),
        'const element=<div style={{color:"var(--ax-color-text)",backgroundColor:group.color,width:128}}/>;',
        definitions,
      ),
    ).toEqual([]);
  });
  it.each([
    'const style={color:"#fff"};const element=<div style={style}/>;',
    'const base={color:"#fff"};const element=<div style={{...base}}/>;',
    'const element=<div style={{color:active?"#fff":"var(--ax-color-text)"}}/>;',
    'const element=<div style={{color:chosen??"#fff"}}/>;',
  ])('rejects palette laundering through local objects, spreads and branches', (source) => {
    expect(
      inspectInlineStyle(file.replace('.module.css', '.tsx'), source, definitions).length,
    ).toBeGreaterThan(0);
  });
  it('rejects geometry aliases used as a private palette or typography role', () => {
    const known = new Set([...definitions, '--ax-layout-width']);
    for (const css of [
      '.view{--ax-layout-width:red;color:var(--ax-layout-width)}',
      '.view{--ax-layout-width:12px;font-size:var(--ax-layout-width)}',
    ])
      expect(inspectStyleSource(file, css, known).length).toBeGreaterThan(0);
    expect(
      inspectInlineStyle(
        file.replace('.module.css', '.tsx'),
        'element.style.setProperty("--ax-color-text","#fff")',
        definitions,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      inspectStyleSource(
        file,
        '@media(prefers-color-scheme:dark){.view{color:var(--ax-color-text)}}',
        definitions,
      ).length,
    ).toBeGreaterThan(0);
  });
  it('keeps typed progress geometry in gradients without laundering it into a color role', () => {
    const known = new Set([...definitions, '--ax-angle-boot-progress']);
    expect(
      inspectStyleSource(
        file,
        '.view{background:conic-gradient(var(--ax-color-text) var(--ax-angle-boot-progress),transparent 0)}',
        known,
      ),
    ).toEqual([]);
    expect(
      inspectStyleSource(file, '.view{color:var(--ax-angle-boot-progress)}', known).length,
    ).toBeGreaterThan(0);
  });
  it('parses nested fallback functions without accepting an unowned nested variable', () => {
    expect(
      mapCssVariables(
        'calc(var(--x, var(--y, rgb(1 2 3))) + 2px)',
        (name, fallback) => `[${name}:${fallback ?? ''}]`,
      ),
    ).toBe('calc([--x:[--y:rgb(1 2 3)]] + 2px)');
    expect(
      inspectStyleSource(file, '.view{color:var(--ax-color-text,var(--shell-text))}', definitions)
        .length,
    ).toBeGreaterThan(0);
  });
});
