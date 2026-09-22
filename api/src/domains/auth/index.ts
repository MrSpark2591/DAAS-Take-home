import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvers } from './resolvers.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Identity: who can sign in, and the session lifecycle. Owns the `User` type
 * that purchasing references for attribution.
 */
export const authDomain = {
  typeDefs: readFileSync(join(here, 'schema.graphql'), 'utf8'),
  resolvers,
};
