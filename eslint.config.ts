import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
    // Legacy v1 application: excluded from v2 tooling (CLAUDE.md, I12).
    'Client/**',
    'Server/**',
    'archi/**',
  ]),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message: 'Use a union of string literals or an "as const" object instead of an enum.',
        },
      ],
    },
  },

  // Backend source: Node globals; process.env only in the config module.
  {
    files: ['apps/api/src/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read environment variables only in platform/config.ts.',
        },
      ],
    },
  },
  {
    // Standalone CLI scripts read their own connection string rather than going
    // through the full app config (see src/db/migrate.ts for why).
    files: ['apps/api/src/platform/config.ts', 'apps/api/src/db/migrate.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },

  // Frontend source: browser globals, React rules, no imports from the API package.
  { ...reactHooks.configs.flat.recommended, files: ['apps/web/src/**/*.{ts,tsx}'] },
  { ...jsxA11y.flatConfigs.recommended, files: ['apps/web/src/**/*.{ts,tsx}'] },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@focus-flow/api', '@focus-flow/api/*'],
              message: 'The web app must not import the API package.',
            },
          ],
        },
      ],
    },
  },

  // Shared contracts: schemas and types only; no dependency on apps.
  {
    files: ['packages/contracts/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@focus-flow/*'],
              message: 'Contracts must not depend on apps or other workspace packages.',
            },
          ],
        },
      ],
    },
  },

  // Tests and tooling scripts may use console output and non-null assertions.
  {
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.int.test.ts',
      'apps/api/test/**/*.ts',
      'scripts/**/*.ts',
    ],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  // Build and tool configuration files run in Node.
  {
    files: ['**/*.config.ts', 'scripts/**/*.ts', 'apps/*/scripts/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-properties': 'off',
    },
  },
]);
