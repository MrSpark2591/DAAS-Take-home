// biome-ignore-all lint/suspicious/useAwait: every ApolloServerPlugin hook is
// typed as returning a Promise, so each must be async even where nothing is
// awaited. Marking them sync breaks the interface.
import type { ApolloServerPlugin } from '@apollo/server';
import type { GraphQLContext } from '../context.js';
import { slowOperationMs } from './logger.js';

/** Codes that mean the caller got it wrong; noise at error level. */
const EXPECTED_CODES = new Set([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'BAD_USER_INPUT',
  'OVER_RECEIPT',
  'CONFLICT',
  'GRAPHQL_VALIDATION_FAILED',
  'GRAPHQL_PARSE_FAILED',
]);

/**
 * One log line per GraphQL operation, plus a line per unexpected error.
 *
 * Levels are chosen so that a production `level: warn` still surfaces
 * everything actionable: expected rejections (a viewer hitting a guarded
 * mutation) stay at debug, slow operations warn, and only genuine server
 * faults reach error.
 */
export const loggingPlugin: ApolloServerPlugin<GraphQLContext> = {
  async requestDidStart({ request }) {
    const startedAt = performance.now();
    // `request.operationName` is only set when the client sends it, so it is
    // captured from the parsed document instead -- otherwise every operation
    // logs as "anonymous" and the log is far less useful.
    let operationName = request.operationName ?? 'anonymous';

    return {
      async didResolveOperation({ operationName: resolved, operation }) {
        operationName = resolved ?? operation?.name?.value ?? operationName;
      },

      async didEncounterErrors({ errors, contextValue: ctx }) {
        for (const error of errors) {
          const code = error.extensions?.code;
          const expected = typeof code === 'string' && EXPECTED_CODES.has(code);

          ctx.log[expected ? 'debug' : 'error'](
            {
              code,
              path: error.path?.join('.'),
              // Only unexpected errors carry a stack; expected ones are control
              // flow and the trace says nothing useful.
              err: expected ? undefined : (error.originalError ?? error),
            },
            expected ? 'operation rejected' : 'operation failed',
          );
        }
      },

      async willSendResponse({ contextValue: ctx, errors }) {
        // Introspection from a playground would otherwise dominate the log.
        if (operationName === 'IntrospectionQuery') return;

        const durationMs = Math.round(performance.now() - startedAt);
        const slow = durationMs >= slowOperationMs();

        ctx.log[slow ? 'warn' : 'info'](
          {
            operation: operationName,
            durationMs,
            errorCount: errors?.length ?? 0,
            ...(slow ? { slow: true } : {}),
          },
          slow ? 'slow graphql operation' : 'graphql operation',
        );
      },
    };
  },
};
