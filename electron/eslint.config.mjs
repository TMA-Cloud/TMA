import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

/**
 * ESLint 10 flat config for Electron (Node, CommonJS).
 * @see https://eslint.org/docs/latest/use/configure/configuration-files
 */
export default defineConfig([
  {
    ignores: [
      'node_modules/**',
      'dist-electron/**',
      'dist-client/**',
      'clouddrive-dist/**',
      'coverage/**',
      '**/*.min.js',
    ],
  },
  js.configs.recommended,
  prettierConfig,
  {
    // The test suite is ESM (Vitest's API cannot be require()d) while the app
    // it exercises stays CommonJS.
    files: ['tests/**/*.mjs', 'vitest.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.cjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.commonjs,
      },
    },
    plugins: { prettier },
    rules: {
      'prettier/prettier': [
        'error',
        {
          printWidth: 120,
          tabWidth: 2,
          useTabs: false,
          semi: true,
          singleQuote: true,
          quoteProps: 'as-needed',
          trailingComma: 'es5',
          bracketSpacing: true,
          bracketSameLine: false,
          arrowParens: 'avoid',
          endOfLine: 'lf',
        },
        { usePrettierrc: true },
      ],
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-undef': 'error',
      'no-console': 'off',
      'no-debugger': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
    },
  },
  {
    /**
     * A ceiling on file size — the "god file" smell. Past ~550 real lines a
     * file is almost always juggling several concerns; the fix is to split it
     * into focused modules behind a barrel (see CLAUDE.md), not to raise the
     * limit. Blank lines and comments are not counted, so this measures
     * substance, not padding. Tests and one-off scripts are legitimately long,
     * so they are exempt.
     */
    files: ['**/*.cjs', '**/*.js'],
    ignores: ['tests/**', 'scripts/**'],
    rules: {
      'max-lines': ['error', { max: 550, skipBlankLines: true, skipComments: true }],
    },
  },
]);
