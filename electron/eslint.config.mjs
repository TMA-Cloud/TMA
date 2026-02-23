import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

/**
 * ESLint 10 flat config for Electron (Node, CommonJS).
 * @see https://eslint.org/docs/latest/use/configure/configuration-files
 */
export default [
  {
    ignores: ['node_modules/**', 'dist-electron/**', 'dist-client/**', '**/*.min.js'],
  },
  js.configs.recommended,
  prettierConfig,
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
];
