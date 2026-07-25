import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'legacy/**', '*.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' }
    },
    rules: {
      // Unused values are usually a leftover from an incomplete refactor — the
      // dead ko-KR number formatters this config was added to catch, for example.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['error'] }],
      eqeqeq: ['error', 'smart']
    }
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Stale-closure and missing-dependency bugs are the single most common
      // class of defect in this renderer; treat them as errors, not hints.
      'react-hooks/exhaustive-deps': 'error'
    }
  },
  {
    files: ['tests/**/*.ts', '**/*.test.ts'],
    languageOptions: { globals: { ...globals.node } }
  }
)
