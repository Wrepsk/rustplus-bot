import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'error', 'no-control-regex': 'off' },
  },
  { ignores: ['dist/**', 'node_modules/**'] },
);
