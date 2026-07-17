import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
      'no-constant-binary-expression': 'error',
      'no-promise-executor-return': 'error',
      // Provider failures may contain secrets, so sanitized boundary errors intentionally omit `cause`.
      'preserve-caught-error': 'off',
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
        ignoreRestSiblings: true,
      }],
    },
  },
  {
    files: ['web/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
];
