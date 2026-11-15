// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

/** The app may only use the Supabase anon key. Also enforced by `npm run check:secrets`. */
const NO_SERVICE_ROLE = 'The app must never reference the Supabase service-role key. Use the anon key and RLS.';

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.expo/*', 'node_modules/*', 'scripts/*'],
  },
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    ignores: ['eslint.config.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'Identifier[name=/service_?role/i]', message: NO_SERVICE_ROLE },
        { selector: 'Literal[value=/service[_-]?role/i]', message: NO_SERVICE_ROLE },
        { selector: 'TemplateElement[value.raw=/service[_-]?role/i]', message: NO_SERVICE_ROLE },
      ],
    },
  },
]);
