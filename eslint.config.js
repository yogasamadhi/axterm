import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      'release/**',
      'vendor/**',
      'packages/framework/**',
      'packages/infra/*/lib/**',
      'packages/api/*/lib/**',
      'packages/plugins/*/lib/**',
      'packages/engines/*/lib/**',
      'packages/data/*/lib/**',
      'packages/tooling/*/lib/**',
      'apps/cli/lib/**',
      'apps/desktop-host/lib/**',
      'apps/web/lib/**',
      'apps/desktop/lib/**',
      'test-results/**',
      'playwright-report/**',
      '**/.next/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.cjs'],
    languageOptions: {
      globals: {
        module: 'readonly',
        process: 'readonly',
        require: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: [
      'apps/web/src/**/*.{ts,tsx}',
      'packages/{api,infra,plugins}/*/src/client/**/*.{ts,tsx}',
    ],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ['packages/api/ui/src/client/controls.tsx'],
    plugins: { 'react-refresh': reactRefresh },
    rules: {
      // Dynamic plugin entries use owned Client HMR; the shared primitives export components plus their stylesheet.
      'react-refresh/only-export-components': [
        'error',
        { allowConstantExport: true, allowExportNames: ['controlsCssText'] },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly', Buffer: 'readonly' },
    },
  },
  prettier,
);
