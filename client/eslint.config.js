import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist'] },
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  prettier,
);
