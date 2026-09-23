import { makeExecutableSchema } from '@graphql-tools/schema';
import type { GraphQLFieldResolver } from 'graphql';
import { defaultFieldResolver } from 'graphql';
import type { GraphQLContext } from './context.js';
import { authDomain } from './domains/auth/index.js';
import { purchasingDomain } from './domains/purchasing/index.js';
import { assertPolicyIsComplete, enforcePolicy } from './shared/authorize.js';

/**
 * The only place domains are wired together. Sprints 3-5 add a folder and a
 * line here.
 *
 * Purchasing comes first because it declares the base `Query` and `Mutation`
 * types that auth extends.
 */
const domains = [purchasingDomain, authDomain];

const executableSchema = makeExecutableSchema<GraphQLContext>({
  typeDefs: domains.map((domain) => domain.typeDefs),
  resolvers: domains.map((domain) => domain.resolvers),
});

/**
 * Wraps every Query and Mutation field so authorisation runs before the
 * resolver, whether or not its author remembered to check.
 *
 * Only root fields are wrapped: nested fields are only reachable *through* a
 * root field, so gating the entry point gates the subtree.
 */
function applyAuthorisation(): void {
  for (const rootType of [executableSchema.getQueryType(), executableSchema.getMutationType()]) {
    if (!rootType) continue;

    for (const [fieldName, field] of Object.entries(rootType.getFields())) {
      const original = (field.resolve ?? defaultFieldResolver) as GraphQLFieldResolver<
        unknown,
        GraphQLContext
      >;

      field.resolve = (source, args, context, info) => {
        enforcePolicy(fieldName, context.actor, context.features);
        return original(source, args, context, info);
      };
    }
  }
}

// Order matters: refuse to start with an unmapped field, then wrap.
assertPolicyIsComplete(executableSchema);
applyAuthorisation();

export const schema = executableSchema;
