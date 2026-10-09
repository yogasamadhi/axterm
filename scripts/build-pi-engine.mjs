import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkPiSource } from './pi-source-provenance.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'vendor/pi/packages');
if (!existsSync(path.join(source, 'ai/src/index.ts')))
  throw new Error('Pi source is missing. Run git submodule update --init --recursive vendor/pi.');
checkPiSource();
// Use Pi's own discovery, validation and frontmatter handling on explicit bundled
// skills. No ambient user/project skills, settings, credentials or scripts are loaded.
const { loadSkillsFromDir } = await import('../vendor/pi/packages/coding-agent/src/core/skills.ts');
const { stripFrontmatter } =
  await import('../vendor/pi/packages/coding-agent/src/utils/frontmatter.ts');
const loaded = loadSkillsFromDir({
  dir: path.join(root, 'packages/pi-engine/skills'),
  source: 'builtin',
});
const useCases = {
  'explain-command': 'explainCommand',
  'explain-output': 'explainOutput',
  'generate-command': 'generateCommand',
  diagnose: 'diagnose',
};
if (loaded.diagnostics.length || loaded.skills.length !== Object.keys(useCases).length)
  throw new Error('Bundled Pi skills failed validation');
const skills = loaded.skills
  .map((skill) => {
    const useCase = useCases[skill.name];
    const body = stripFrontmatter(readFileSync(skill.filePath, 'utf8')).trim();
    if (!useCase || body.length > 8192 || !skill.disableModelInvocation)
      throw new Error('Invalid bundled Pi skill');
    return { id: skill.name, useCase, description: skill.description, body };
  })
  .sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(
  path.join(root, 'packages/pi-engine/catalog/skills.generated.json'),
  JSON.stringify(skills, null, 2) + '\n',
);
const { hydrateModelCatalog } =
  await import('../vendor/pi/packages/ai/scripts/hydrate-model-catalog.ts');
hydrateModelCatalog(
  path.join(source, 'ai'),
  path.join(root, 'packages/pi-engine/catalog/models.all.json'),
);
await build({
  absWorkingDir: root,
  entryPoints: ['packages/pi-engine/src/index.ts'],
  outfile: 'packages/pi-engine/dist/index.js',
  bundle: true,
  nodePaths: [path.join(root, 'packages/pi-engine/node_modules')],
  external: ['ws'],
  tsconfigRaw: {},
  banner: {
    js: "import { createRequire as piCreateRequire } from 'node:module'; const require = piCreateRequire(import.meta.url);",
  },
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: false,
  alias: {
    '@earendil-works/pi-ai': path.join(source, 'ai/src/index.ts'),
    '@earendil-works/pi-telemetry': path.join(source, 'telemetry/src/index.ts'),
  },
  plugins: [
    {
      name: 'google-request-scoped-fetch',
      setup(builder) {
        builder.onLoad(
          { filter: /@google[\\/]genai[\\/]dist[\\/]node[\\/]index\.mjs$/ },
          ({ path: filename }) => {
            const text = readFileSync(filename, 'utf8');
            if ((text.match(/\bfetch\(/gu) ?? []).length !== 3)
              throw new Error(
                'Google SDK fetch injection points changed; review the transport binding',
              );
            const transport = JSON.stringify(
              path.join(root, 'packages/pi-engine/src/scoped-fetch.ts'),
            );
            return {
              contents: `import { scopedModelFetch } from ${transport};\n${text.replaceAll(/\bfetch\(/gu, 'scopedModelFetch(')}`,
              loader: 'js',
            };
          },
        );
      },
    },
  ],
});
