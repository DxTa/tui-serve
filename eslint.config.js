import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      'server/dist/**',
      'server/node_modules/**',
      'tui-web/dist/**',
      'tui-web/node_modules/**',
      'packaging/build/**',
      'packaging/dist/**',
    ],
  },
  {
    files: ['server/src/**/*.ts', 'server/test/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': 'off',
      'preserve-caught-error': 'off',
      'no-useless-assignment': 'off',
    },
  }, 
  {
    files: ['tui-web/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2022 },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': 'off',
    },
  },
);
