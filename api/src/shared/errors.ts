import { GraphQLError } from 'graphql';

/**
 * Error codes the UI is allowed to branch on. Anything not in this union is a
 * bug on our side and surfaces as INTERNAL_SERVER_ERROR with no detail.
 */
export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'BAD_USER_INPUT'
  | 'OVER_RECEIPT'
  | 'CONFLICT';

function gqlError(code: ErrorCode, message: string, extra?: Record<string, unknown>) {
  return new GraphQLError(message, {
    extensions: { code, ...extra },
  });
}

export const unauthenticated = (message = 'Sign in to continue.') =>
  gqlError('UNAUTHENTICATED', message);

/**
 * `required` is echoed back so a client can say precisely which permission is
 * missing -- which is also the thing an administrator has to grant to fix it.
 */
export const forbidden = (message: string, required?: readonly string[]) =>
  gqlError('FORBIDDEN', message, required ? { requiredPermissions: required } : undefined);

export const notFound = (entity: string, id: string) =>
  gqlError('NOT_FOUND', `${entity} ${id} does not exist.`, { entity, id });

export const badInput = (message: string, extra?: Record<string, unknown>) =>
  gqlError('BAD_USER_INPUT', message, extra);

export const conflict = (message: string, extra?: Record<string, unknown>) =>
  gqlError('CONFLICT', message, extra);

/**
 * Receiving more than was ordered. Its own code because the UI shows a
 * specific, per-line message for it rather than a generic validation error.
 */
export const overReceipt = (details: {
  purchaseOrderLineId: string;
  sku: string;
  ordered: number;
  alreadyReceived: number;
  attempted: number;
}) =>
  gqlError(
    'OVER_RECEIPT',
    `Cannot receive ${details.attempted} of ${details.sku}: ${details.ordered} ordered, ` +
      `${details.alreadyReceived} already received, ` +
      `${details.ordered - details.alreadyReceived} outstanding.`,
    details,
  );
