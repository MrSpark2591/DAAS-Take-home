import { purchasingDomain } from './domains/purchasing/index.js';

/**
 * The only place domains are wired together. Sprints 3-5 add a folder and a
 * line here.
 */
const domains = [purchasingDomain];

export const typeDefs = domains.map((d) => d.typeDefs);
export const resolvers = domains.map((d) => d.resolvers);
