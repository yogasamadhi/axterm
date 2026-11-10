/** One shared browser identity table; the Web seed and plugin bundler use these exact keys. */
export const CLIENT_PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@axterm/plugin-api',
  '@axterm/engine-api',
  '@axterm/plugin-api/brand',
  '@axterm/plugin-api/credentials',
  '@axterm/plugin-api/saved-credentials',
  '@axterm/plugin-api/configuration-portable',
  '@axterm/plugin-api/configuration-sync',
  '@axterm/plugin-api/types',
  '@axterm/plugin-api/remote-info',
  '@axterm/plugin-api/stream-protocol',
  '@axterm/plugin-api/storage',
  '@axterm/plugin-api/terminals',
  '@axterm/plugin-api/session-intents',
  '@axterm/plugin-api/catalog',
  '@axterm/plugin-api/configuration',
  '@axterm/plugin-api/shortcuts',
  '@axterm/plugin-api/connections',
  '@axterm/plugin-api/files',
  '@axterm/plugin-api/transfers',
  '@axterm/plugin-api/remote-desktop',
  '@axterm/plugin-api/automation',
  '@axterm/plugin-api/ai',
  '@axterm/plugin-api/plugins',
  '@axterm/plugin-api/market',
  '@axterm/plugin-api/desktop',
  '@axterm/ui',
  '@axterm/ui/workspace',
  '@axterm/ui/store-contract',
  '@axterm/ui/controls',
  '@axterm/ui/presentation',
  '@axterm/ui/preference',
];

/** Validate the explicit seed table, including formatter-safe identifier keys. */
export async function validatePlatformSeed(source) {
  const { default: ts } = await import('typescript');
  const file = ts.createSourceFile('seed.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'getStaticModules',
  );
  const returned = declaration?.body?.statements.find((node) => ts.isReturnStatement(node));
  const table = returned?.expression;
  if (!table || !ts.isObjectLiteralExpression(table)) throw new Error('CLIENT_PLATFORM_SEED_DRIFT');
  const keys = table.properties.map((property) => {
    if (
      !ts.isPropertyAssignment(property) ||
      (!ts.isStringLiteral(property.name) && !ts.isIdentifier(property.name))
    )
      throw new Error('CLIENT_PLATFORM_SEED_DRIFT');
    return property.name.text;
  });
  if (JSON.stringify(keys.sort()) !== JSON.stringify([...CLIENT_PLATFORM_MODULES].sort()))
    throw new Error('CLIENT_PLATFORM_SEED_DRIFT');
}
