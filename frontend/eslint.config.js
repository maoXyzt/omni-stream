import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // iconForKey() returns a stable reference from a fixed lucide-react set;
      // the lint rule can't see through the indirection. Flagged as cosmetic.
      'react-hooks/static-components': 'off',
      // TextPreview synchronously flips `ready` when the language is already
      // bundled — initial state already handles it, the effect only covers
      // post-mount language switches. Cascading-render cost is negligible.
      'react-hooks/set-state-in-effect': 'off',
      // Allow `_`-prefixed names to signal "intentionally unused" — useful
      // for destructured props we plan to consume in a follow-up.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
])
