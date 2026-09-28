import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier/flat';

export default tseslint.config(
    {
        ignores: ['dist/**', 'node_modules/**'],
    },
    {
        files: ['src/**/*.ts', 'tests/**/*.ts'],
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        rules: {
            '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
            'func-style': ['error', 'expression', { allowArrowFunctions: true }],
            'no-var': 'error',
            'prefer-const': 'error',
        },
    },
    {
        files: ['src/pipeline.ts'],
        // The CPS runner intentionally erases heterogeneous stage types at its runtime boundary.
        rules: { '@typescript-eslint/no-explicit-any': 'off' },
    },
    eslintConfigPrettier
);
