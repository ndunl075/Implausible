import js from '@eslint/js';
import next from '@next/eslint-plugin-next';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['.next/**', 'node_modules/**', 'public/**', 'data/**', 'out/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { '@next/next': next },
    rules: {
      ...next.configs.recommended.rules,
      ...next.configs['core-web-vitals'].rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The tracker is hand-written ES5-ish browser code with its own budget rules.
    files: ['tracker/src/**/*.js'],
    languageOptions: {
      globals: globals.browser,
      ecmaVersion: 5,
      sourceType: 'script',
    },
  },
  {
    files: ['tracker/build.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
);
