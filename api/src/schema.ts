import { authDomain } from './domains/auth/index.js';
import { purchasingDomain } from './domains/purchasing/index.js';

/**
 * The only place domains are wired together. Sprints 3-5 add a folder and a
 * line here.
 *
 * Purchasing comes first because it declares the base `Query` and `Mutation`
 * types that auth extends.
 */
const domains = [purchasingDomain, authDomain];

export const typeDefs = domains.map((d) => d.typeDefs);
export const resolvers = domains.map((d) => d.resolvers);
