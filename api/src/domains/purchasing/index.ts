import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvers } from './resolvers.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A domain exposes exactly this: its SDL and its resolvers. Adding sprint 3's
 * `drawings` domain means creating a sibling folder with the same two exports
 * and adding one line to `src/schema.ts` -- nothing else in the server changes.
 */
export const purchasingDomain = {
  typeDefs: readFileSync(join(here, 'schema.graphql'), 'utf8'),
  resolvers,
};
