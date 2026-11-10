import { readFile } from 'node:fs/promises';
import postcss from 'postcss';
/** Inspect declared CSS at its real owner; semantic values resolve against the dark Theme baseline. */
export async function ownedStyleDeclarations(
  path: string,
  selector: RegExp,
): Promise<Map<string, string>[]> {
  const variables = new Map<string, string>();
  for (const file of ['tokens', 'semantic-roles']) {
    const theme = postcss.parse(
      await readFile(`packages/infra/ui-theme/src/client/${file}.module.css`, 'utf8'),
    );
    theme.walkRules((rule) => {
      if (rule.selector === ':global(:root)')
        rule.walkDecls((decl) => {
          variables.set(decl.prop, decl.value);
        });
    });
  }
  const resolveValue = (value: string) => {
    for (let i = 0; i < 16 && /var\(/u.test(value); i++) {
      const next = value.replace(
        /var\(\s*(--[\w-]+)\s*\)/gu,
        (original, name: string) => variables.get(name) ?? original,
      );
      if (next === value) break;
      value = next;
    }
    return value.replace(/\s+/gu, ' ').trim();
  };
  const declarations: Map<string, string>[] = [];
  postcss.parse(await readFile(path, 'utf8')).walkRules((rule) => {
    if (!selector.test(rule.selector)) return;
    const values = new Map<string, string>();
    rule.walkDecls((decl) => {
      values.set(decl.prop, resolveValue(decl.value));
    });
    declarations.push(values);
  });
  if (!declarations.length) throw Error(`Missing owned CSS selector: ${path}: ${selector}`);
  return declarations;
}
