import type { CodegenConfig } from '@graphql-codegen/cli';

/**
 * Types are generated from the API's SDL, so the UI cannot drift from the
 * schema without `npm run typecheck` failing. The operations below live in
 * src/lib/operations.ts and are validated against the schema at generation
 * time -- a typo in a field name is a codegen error, not a runtime null.
 */
const config: CodegenConfig = {
  schema: '../api/src/domains/**/*.graphql',
  documents: ['src/**/*.ts', 'src/**/*.tsx'],
  ignoreNoDocuments: true,
  generates: {
    './src/generated/graphql.ts': {
      plugins: ['typescript', 'typescript-operations'],
      config: {
        skipTypename: true,
        enumsAsTypes: true,
        scalars: { DateTime: 'string', ID: 'string' },
        avoidOptionals: { field: true, inputValue: false },
      },
    },
  },
};

export default config;
