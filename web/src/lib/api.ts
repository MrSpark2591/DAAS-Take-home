import { type BaseQueryApi, type BaseQueryFn, createApi } from '@reduxjs/toolkit/query/react';
import { graphqlRequestBaseQuery } from '@rtk-query/graphql-request-base-query';
import type {
  CreatePurchaseOrderMutation,
  CreatePurchaseOrderMutationVariables,
  FormOptionsQuery,
  LoginMutation,
  LoginMutationVariables,
  LogoutMutation,
  MeQuery,
  PurchaseOrderQuery,
  PurchaseOrderQueryVariables,
  PurchaseOrdersQuery,
  PurchaseOrdersQueryVariables,
  ReceivePurchaseOrderMutation,
  ReceivePurchaseOrderMutationVariables,
  StockOnHandQuery,
  StockOnHandQueryVariables,
} from '@/generated/graphql';
import {
  CreatePurchaseOrderDocument,
  FormOptionsDocument,
  LoginDocument,
  LogoutDocument,
  MeDocument,
  PurchaseOrderDocument,
  PurchaseOrdersDocument,
  ReceivePurchaseOrderDocument,
  RefreshSessionDocument,
  StockOnHandDocument,
} from './operations';
import { sessionEnded, sessionEstablished } from './session';
import type { RootState } from './store';

/**
 * The normalised error the UI branches on. The API puts a stable code in
 * `extensions.code`; flattening it here means components never dig through
 * GraphQL error envelopes.
 */
export interface ApiError {
  code: string;
  message: string;
  extensions: Record<string, unknown>;
}

/**
 * Requests go to this app's own origin, where a route handler forwards them to
 * the API. That keeps the session cookies first-party, so the browser attaches
 * them automatically and no token is ever readable by JavaScript.
 *
 * The origin is explicit because graphql-request builds a `URL` internally and
 * a bare path will not parse.
 */
function graphqlEndpoint(): string {
  if (typeof window !== 'undefined') return `${window.location.origin}/api/graphql`;
  // Only reached if a query is constructed during SSR. Nothing fetches there,
  // but the client still needs a parseable URL to be constructed at all.
  return `${process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'}/api/graphql`;
}

const rawBaseQuery = graphqlRequestBaseQuery<ApiError>({
  url: graphqlEndpoint(),

  customErrors: ({ message, response }) => {
    const first = response?.errors?.[0];
    if (!first) {
      return {
        code: 'NETWORK_ERROR',
        message: 'Cannot reach the API. Is it running on port 4000?',
        extensions: {},
      };
    }
    return {
      code: (first.extensions?.code as string | undefined) ?? 'UNKNOWN',
      message: first.message || message,
      extensions: (first.extensions ?? {}) as Record<string, unknown>,
    };
  },
});

/**
 * In-flight refresh, shared by every caller.
 *
 * This matters more than it looks. The server rotates refresh tokens and treats
 * a replayed one as theft -- so if three queries 401 at once and each fires its
 * own refresh, two of them present a token the first has already spent, the
 * server concludes the session leaked, and it revokes the whole family. The
 * user gets logged out by their own app. Single-flighting is what prevents it.
 */
let refreshInFlight: Promise<boolean> | null = null;

function refreshOnce(api: BaseQueryApi, extraOptions: unknown): Promise<boolean> {
  refreshInFlight ??= (async () => {
    const result = await rawBaseQuery(
      { document: RefreshSessionDocument },
      api,
      extraOptions as never,
    );

    const refreshed = (result.data as { refreshSession?: { user: unknown } } | undefined)
      ?.refreshSession;

    if (refreshed?.user) {
      api.dispatch(sessionEstablished(refreshed.user as never));
      return true;
    }
    return false;
  })().finally(() => {
    // Cleared so a later expiry starts a fresh attempt. Callers already hold
    // the promise, so clearing here cannot strand them.
    refreshInFlight = null;
  });

  return refreshInFlight;
}

/** Operations that must never trigger a refresh, or they would recurse. */
const AUTH_DOCUMENTS = [LoginDocument, LogoutDocument, RefreshSessionDocument];

function isAuthOperation(args: unknown): boolean {
  const document = (args as { document?: unknown } | undefined)?.document;
  return typeof document === 'string' && AUTH_DOCUMENTS.includes(document);
}

/**
 * Wraps every request: on an expired access token, refresh once and retry.
 *
 * Access tokens last 15 minutes, so this runs routinely during normal use and
 * is invisible to the user -- no redirect to the login page, no lost form state.
 */
const baseQueryWithReauth: BaseQueryFn<
  Parameters<typeof rawBaseQuery>[0],
  unknown,
  ApiError
> = async (args, api, extraOptions) => {
  const result = await rawBaseQuery(args, api, extraOptions);

  const code = (result.error as ApiError | undefined)?.code;
  if (code !== 'UNAUTHENTICATED' || isAuthOperation(args)) return result;

  const refreshed = await refreshOnce(api, extraOptions);
  if (!refreshed) {
    // The refresh token is spent, revoked or expired. This is a real sign-out.
    api.dispatch(sessionEnded());
    return result;
  }

  return rawBaseQuery(args, api, extraOptions);
};

export const api = createApi({
  reducerPath: 'api',
  baseQuery: baseQueryWithReauth,
  tagTypes: ['PurchaseOrder', 'StockOnHand', 'Session'],
  endpoints: (build) => ({
    me: build.query<MeQuery, void>({
      query: () => ({ document: MeDocument }),
      providesTags: ['Session'],
      // Keeps the store's session in step with what the cookie actually proves.
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          if (data.me) dispatch(sessionEstablished(data.me));
          else dispatch(sessionEnded());
        } catch {
          dispatch(sessionEnded());
        }
      },
    }),

    login: build.mutation<LoginMutation, LoginMutationVariables>({
      query: (variables) => ({ document: LoginDocument, variables }),
      // Everything cached belonged to the previous (anonymous) session.
      invalidatesTags: ['Session', 'PurchaseOrder', 'StockOnHand'],
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(sessionEstablished(data.login.user));
        } catch {
          // A failed sign-in is expected input, not an exception. The form
          // renders it from `loginState.error`; rethrowing here would only
          // surface an unhandled rejection in the console.
        }
      },
    }),

    logout: build.mutation<LogoutMutation, void>({
      query: () => ({ document: LogoutDocument }),
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          await queryFulfilled;
        } finally {
          // Sign out locally even if the call failed: the user asked to leave,
          // and the cookies are cleared by the server either way.
          dispatch(sessionEnded());
          dispatch(api.util.resetApiState());
        }
      },
    }),

    purchaseOrders: build.query<PurchaseOrdersQuery, PurchaseOrdersQueryVariables>({
      query: (variables) => ({ document: PurchaseOrdersDocument, variables }),
      // Tag each row *and* the list. A receipt invalidates the row it touched;
      // because a receipt can also change the order's status, and status is a
      // filter, it invalidates LIST too -- otherwise a PO that just became
      // RECEIVED would linger in the OPEN tab.
      providesTags: (result) => [
        { type: 'PurchaseOrder' as const, id: 'LIST' },
        ...(result?.purchaseOrders.nodes ?? []).map((po) => ({
          type: 'PurchaseOrder' as const,
          id: po.id,
        })),
      ],
    }),

    purchaseOrder: build.query<PurchaseOrderQuery, PurchaseOrderQueryVariables>({
      query: (variables) => ({ document: PurchaseOrderDocument, variables }),
      providesTags: (_result, _error, { id }) => [{ type: 'PurchaseOrder' as const, id }],
    }),

    formOptions: build.query<FormOptionsQuery, void>({
      query: () => ({ document: FormOptionsDocument }),
    }),

    stockOnHand: build.query<StockOnHandQuery, StockOnHandQueryVariables | undefined>({
      query: (variables) => ({ document: StockOnHandDocument, variables: variables ?? {} }),
      providesTags: [{ type: 'StockOnHand' as const, id: 'LIST' }],
    }),

    createPurchaseOrder: build.mutation<
      CreatePurchaseOrderMutation,
      CreatePurchaseOrderMutationVariables
    >({
      query: (variables) => ({ document: CreatePurchaseOrderDocument, variables }),
      invalidatesTags: [{ type: 'PurchaseOrder', id: 'LIST' }],
    }),

    receivePurchaseOrder: build.mutation<
      ReceivePurchaseOrderMutation,
      ReceivePurchaseOrderMutationVariables
    >({
      query: (variables) => ({ document: ReceivePurchaseOrderDocument, variables }),
      // Receiving moves stock, so the on-hand view is stale too. Skipped on
      // error so a rejected over-receipt does not cause a pointless refetch.
      invalidatesTags: (_result, error, { input }) =>
        error
          ? []
          : [
              { type: 'PurchaseOrder', id: input.purchaseOrderId },
              { type: 'PurchaseOrder', id: 'LIST' },
              { type: 'StockOnHand', id: 'LIST' },
            ],
    }),
  }),
});

export const {
  useMeQuery,
  useLoginMutation,
  useLogoutMutation,
  usePurchaseOrdersQuery,
  usePurchaseOrderQuery,
  useFormOptionsQuery,
  useStockOnHandQuery,
  useCreatePurchaseOrderMutation,
  useReceivePurchaseOrderMutation,
} = api;

/** Narrows an unknown RTK Query error to our normalised shape. */
export function asApiError(error: unknown): ApiError | null {
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
    return error as ApiError;
  }
  return null;
}

/** Re-exported so `store.ts` does not need to know the slice's shape. */
export type { RootState };
