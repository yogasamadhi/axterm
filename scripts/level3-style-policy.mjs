import postcss from 'postcss';
import ts from 'typescript';

export const themeDirectory = 'packages/infra/ui-theme/src/client/';
const keywords = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'none',
  'auto',
  'normal',
  'transparent',
  'currentcolor',
]);
const paletteWords =
  /(?<![-\w])(?:black|white|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|gold|navy|teal|aqua|cyan|magenta|lime|maroon|olive|fuchsia|rebeccapurple)(?![-\w])/iu;
const paints = /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\s*\(/iu;
export const visualPrefix =
  /^(?:color|border|font|line|letter|radius|shadow|layer|motion|opacity|animation)-/u;

/** Balanced var expressions, including nested fallbacks; callbacks never receive partial functions.
 * @param {string} value
 * @param {(name: string, fallback: string | undefined) => string} visit
 * @returns {string}
 */
export function mapCssVariables(value, visit) {
  let result = '',
    at = 0;
  const pattern = /\bvar\s*\(/gu;
  for (let match; (match = pattern.exec(value));) {
    result += value.slice(at, match.index);
    const start = pattern.lastIndex;
    let depth = 1,
      quote = '',
      comma = -1,
      end = start;
    for (; end < value.length && depth; end++) {
      const char = value[end];
      if (quote) {
        if (char === '\\') end++;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === '(') depth++;
      else if (char === ')') depth--;
      else if (char === ',' && depth === 1 && comma < 0) comma = end;
    }
    if (depth) throw Error('Unclosed CSS variable');
    const name = value.slice(start, comma < 0 ? end - 1 : comma).trim();
    const fallback =
      comma < 0 ? undefined : mapCssVariables(value.slice(comma + 1, end - 1).trim(), visit);
    result += visit(name, fallback);
    at = end;
    pattern.lastIndex = end;
  }
  return result + value.slice(at);
}
export function hasLiteralPaint(value) {
  const remainder = mapCssVariables(value, () => '').replace(
    /url\([^)]*\)|(['"])(?:\\.|(?!\1).)*?\1/giu,
    '',
  );
  return paints.test(remainder) || paletteWords.test(remainder);
}
export function visualKind(property, value) {
  const p = property.toLowerCase();
  if (keywords.has(value.trim().toLowerCase())) return undefined;
  if (p.startsWith('--')) return undefined;
  if (
    /^(?:color|background(?:-color)?|fill|stroke|caret-color|accent-color|scrollbar-color|(?:border|outline)(?:-.*)?-color)$/u.test(
      p,
    )
  )
    return 'color';
  if (/shadow$/u.test(p)) return 'shadow';
  if (/radius$/u.test(p)) return 'radius';
  if (p === 'z-index') return 'layer';
  if (/^font(?:-.*)?$/u.test(p)) return 'font';
  if (p === 'line-height') return 'line';
  if (p === 'letter-spacing') return 'letter';
  if (p === 'opacity' && value !== '0' && value !== '1') return 'opacity';
  if (/^(?:animation|transition)(?:-.*)?$/u.test(p)) return 'motion';
  if (hasLiteralPaint(value)) return /^(?:border|outline)/u.test(p) ? 'border' : 'color';
  return undefined;
}
function inspectValue(value, property, definitions, errors) {
  const kind = visualKind(property, value);
  mapCssVariables(value, (name, fallback) => {
    if (
      !name.startsWith('--ax-') &&
      !['--radix-select-trigger-width', '--radix-select-content-available-height'].includes(name)
    )
      errors.push(`Legacy or unowned variable: ${name}`);
    if (name.startsWith('--ax-') && !definitions.has(name))
      errors.push(`Undefined owned variable: ${name}`);
    const gradientGeometry =
      kind === 'color' &&
      /background/u.test(property) &&
      /(?:conic|linear|radial)-gradient\s*\(/u.test(value) &&
      /^--ax-(?:angle|size|space)-/u.test(name);
    if (
      kind &&
      !gradientGeometry &&
      name.startsWith('--ax-') &&
      !new RegExp('^--ax-' + (kind === 'color' ? '(?:color|opacity)' : kind) + '-').test(name)
    )
      errors.push(`Wrong semantic role for ${property}: ${name}`);
    if (name.startsWith('--ax-') && visualPrefix.test(name.slice(5))) {
      if (!definitions.has(name)) errors.push(`Undefined theme role: ${name}`);
      if (fallback !== undefined)
        errors.push(`Theme role must not carry a private fallback: ${name}`);
    }
    return `var(${name}${fallback === undefined ? '' : ',' + fallback})`;
  });
  if (!kind) return;
  if (hasLiteralPaint(value)) errors.push(`Literal paint in ${property}`);
  const remainder = mapCssVariables(value, () => '').trim();
  if (
    ['font', 'line', 'letter', 'radius', 'shadow', 'layer', 'opacity'].includes(kind) &&
    remainder &&
    !keywords.has(remainder.toLowerCase())
  )
    errors.push(`Literal visual parameter in ${property}`);
  if (
    kind === 'motion' &&
    /\b\d*\.?\d+(?:ms|s)\b|\b(?:linear|ease|ease-in|ease-out|ease-in-out)\b|\b(?:cubic-bezier|steps)\s*\(/u.test(
      remainder,
    )
  )
    errors.push(`Literal motion parameter in ${property}`);
}
export function inspectStyleSource(path, source, definitions = new Set()) {
  const errors = [];
  let root;
  try {
    root = postcss.parse(source, { from: path });
  } catch {
    return [`${path}: Invalid CSS syntax`];
  }
  const owner = path.startsWith(themeDirectory);
  if (!path.endsWith('.module.css')) errors.push('Client styles must use CSS Modules');
  root.walkRules((rule) => {
    if (!owner && /\[data-(?:ax-)?theme(?:=|\]|\s)/u.test(rule.selector))
      errors.push('Theme selection belongs to the theme component');
  });
  root.walkAtRules((rule) => {
    if (!owner && rule.name === 'media' && /prefers-color-scheme/u.test(rule.params))
      errors.push('Theme selection belongs to the theme component');
  });
  root.walkDecls((declaration) => {
    if (owner) return;
    if (declaration.prop.startsWith('--ax-') && visualPrefix.test(declaration.prop.slice(5)))
      errors.push(`Private palette definition: ${declaration.prop}`);
    if (declaration.prop.startsWith('--ax-') && hasLiteralPaint(declaration.value))
      errors.push(`Private palette definition: ${declaration.prop}`);
    if (declaration.prop.startsWith('--') && !declaration.prop.startsWith('--ax-'))
      errors.push(`Legacy palette definition: ${declaration.prop}`);
    inspectValue(declaration.value, declaration.prop, definitions, errors);
  });
  return [...new Set(errors)].map((error) => `${path}: ${error}`);
}
export function inspectInlineStyle(path, source, definitions = new Set()) {
  const errors = [];
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function initializer(name, use) {
    for (let scope = use.parent; scope; scope = scope.parent) {
      if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name)
            return declaration.initializer;
      }
    }
    return undefined;
  }
  function unwrap(expression) {
    while (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isNonNullExpression(expression)
    )
      expression = expression.expression;
    return expression;
  }
  function value(expression, name) {
    expression = unwrap(expression);
    if (ts.isStringLiteralLike(expression))
      inspectValue(expression.text, name, definitions, errors);
    else if (ts.isNumericLiteral(expression) && visualKind(name, expression.text))
      errors.push(`Literal visual parameter in inline ${name}`);
    else if (ts.isConditionalExpression(expression)) {
      value(expression.whenTrue, name);
      value(expression.whenFalse, name);
    } else if (
      ts.isBinaryExpression(expression) &&
      [
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
      ].includes(expression.operatorToken.kind)
    ) {
      value(expression.left, name);
      value(expression.right, name);
    }
  }
  function object(expression, seen = new Set()) {
    expression = unwrap(expression);
    if (seen.has(expression)) return;
    seen.add(expression);
    if (ts.isIdentifier(expression)) {
      const declared = initializer(expression.text, expression);
      if (declared) object(declared, seen);
      return;
    }
    if (ts.isConditionalExpression(expression)) {
      object(expression.whenTrue, seen);
      object(expression.whenFalse, seen);
      return;
    }
    if (!ts.isObjectLiteralExpression(expression)) return;
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        object(property.expression, seen);
        continue;
      }
      if (!ts.isPropertyAssignment(property)) continue;
      const name =
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : undefined;
      if (!name) continue;
      const cssName = name.replace(/[A-Z]/gu, (letter) => '-' + letter.toLowerCase());
      if (cssName.startsWith('--ax-') && visualPrefix.test(cssName.slice(5)))
        errors.push(`Private palette definition in inline ${name}`);
      value(property.initializer, cssName);
    }
  }
  function walk(node) {
    if (
      !path.startsWith(themeDirectory) &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'setProperty' &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text.startsWith('--ax-') &&
      visualPrefix.test(node.arguments[0].text.slice(5))
    )
      errors.push('Private palette mutation outside Theme');
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(tree) === 'style' &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression
    )
      object(node.initializer.expression);
    ts.forEachChild(node, walk);
  }
  walk(tree);
  return [...new Set(errors)].map((error) => `${path}: ${error}`);
}
