import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const disableTypeCheckedConfigs = Array.isArray(tseslint.configs.disableTypeChecked)
  ? tseslint.configs.disableTypeChecked
  : [tseslint.configs.disableTypeChecked]

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '.turbo/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...disableTypeCheckedConfigs.map((config) => ({
    ...config,
    files: ['**/*.{js,mjs,cjs}']
  })),
  {
    files: ['apps/desktop/scripts/**', 'scripts/**'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser
      }
    }
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error'
    }
  }
)
