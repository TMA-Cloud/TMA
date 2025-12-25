import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

/**
 * ESLint 9 flat config for Node.js backend (CommonJS)
 * @see https://eslint.org/docs/latest/use/configure/configuration-files-new
 * @see https://github.com/prettier/eslint-plugin-prettier#options
 */
export default [
  // Ignore patterns
  {
    ignores: ['node_modules/**', 'uploads/**', 'coverage/**', 'dist/**', '*.min.js'],
  },

  // Base ESLint recommended rules
  js.configs.recommended,

  // Prettier config (disables conflicting ESLint rules)
  prettierConfig,

  // Main configuration for all JS files
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.commonjs,
      },
    },
    plugins: {
      prettier,
    },
    rules: {
      // Prettier integration - explicitly pass Prettier options to ensure consistency
      // This ensures both CLI and IDE use the same Prettier settings
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
          proseWrap: 'preserve',
        },
        {
          usePrettierrc: true, // Also load from .prettierrc (options above will merge/override)
        },
      ],

      // Error prevention
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-undef': 'error',
      'no-console': 'off', // Allow console in backend
      'no-debugger': 'error',

      // Best practices
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      curly: ['error', 'multi-line'],
      'no-var': 'error',
      'prefer-const': [
        'error',
        {
          destructuring: 'all',
        },
      ],
      'no-throw-literal': 'error',
      'no-return-await': 'error',
      'require-await': 'off', // Disabled - async functions may be intentionally async for interface consistency
      'no-async-promise-executor': 'error',
      'no-promise-executor-return': 'error',

      // Node.js specific
      'no-process-exit': 'off', // Sometimes needed in CLI/server
      'no-path-concat': 'error',
      'handle-callback-err': ['error', '^(err|error)$'],

      // Code style (non-formatting - Prettier handles formatting)
      'no-lonely-if': 'error',
      'no-unneeded-ternary': 'error',
      'prefer-template': 'off', // Allow string concatenation
      'object-shorthand': ['error', 'properties'],
      'no-useless-rename': 'error',
      'no-useless-return': 'error',

      // Security best practices
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
];
