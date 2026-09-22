import { createApi } from '@reduxjs/toolkit/query/react';
import { graphqlRequestBaseQuery } from '@rtk-query/graphql-request-base-query';
import type {
  CreatePurchaseOrderMutation,
  CreatePurchaseOrderMutationVariables,
  DemoUsersQuery,
  FormOptionsQuery,
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
  DemoUsersDocument,
  FormOptionsDocument,
  MeDocument,
  PurchaseOrderDocument,
  PurchaseOrdersDocument,
  ReceivePurchaseOrderDocument,
  StockOnHandDocument,
} from './operations';
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

const baseQuery = graphqlRequestBaseQuery<ApiError>({
  url: process.env.NEXT_PUBLIC_GRAPHQL_URL ?? 'http://localhost:4000/',

  // The bearer token is read from the store on every request rather than
  // captured once, so switching roles takes effect on the next query without
  // recreating the client.
  prepareHeaders: (headers, { getState }) => {
    const { token } = (getState() as RootState).session;
    if (token) headers.set('authorization', `Bearer ${token}`);
    return headers;
  },

  customErrors: ({ message, response }) => {
    const first = response?.errors?.[0];
    if (!first) {
      // No GraphQL envelope means the request never reached the API.
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

export const api = createApi({
  reducerPath: 'api',
  baseQuery,
  tagTypes: ['PurchaseOrder', 'StockOnHand', 'Session'],
  endpoints: (build) => ({
    demoUsers: build.query<DemoUsersQuery, void>({
      query: () => ({ document: DemoUsersDocument }),
    }),

    me: build.query<MeQuery, void>({
      query: () => ({ document: MeDocument }),
      providesTags: ['Session'],
    }),

    purchaseOrders: build.query<PurchaseOrdersQuery, PurchaseOrdersQueryVariables>({
      query: (variables) => ({ document: PurchaseOrdersDocument, variables }),
      // Tag each row *and* the list. A receipt invalidates the row it touched;
      // because a receipt can also change the order's status, and status is a
      // filter, it invalidates LIST too -- otherwise a PO that just became
      // RECEIVED would linger in the OPEN tab.
      providesTags: (result) => [
        { type: 'PurchaseOrder' as const, id: 'LIST' },
        ...(result?.purchaseOrders ?? []).map((po) => ({
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
  useDemoUsersQuery,
  useMeQuery,
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
