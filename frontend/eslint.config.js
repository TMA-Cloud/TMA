import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';
import house from './eslint-rules/house.js';

/**
 * ESLint 10 flat config for frontend (React + TypeScript).
 * @see https://eslint.org/docs/latest/use/configure/configuration-files
 */
export default defineConfig([
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**', '**/*.min.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        projectService: true,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      house,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'house/toast-copy': 'error',
      'house/no-smart-apostrophe': 'error',
    },
  },
  {
    /**
     * The type ladder is enforced only where it already holds. Widen this list
     * as each surface moves off the Tailwind text-* sizes — an error people can
     * act on beats 200 warnings they learn to scroll past.
     */
    files: ['src/components/ui/*.tsx', 'src/components/settings/components/Settings*.tsx'],
    rules: {
      'house/use-type-tokens': 'error',
    },
  },
  {
    // Test doubles frequently have to match a signature without using every
    // parameter; the `_` prefix marks those as deliberate.
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The fixtures for house/no-smart-apostrophe have to contain the character
    // the rule rejects, so the rule cannot also police its own test.
    files: ['tests/eslintRules.test.ts'],
    rules: {
      'house/no-smart-apostrophe': 'off',
    },
  },
]);
