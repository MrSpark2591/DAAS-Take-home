import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/**
 * Who the browser is signed in as, and what they may do.
 *
 * Note what is NOT here: any token. Both the access and refresh tokens are
 * httpOnly cookies the browser attaches automatically and page JavaScript
 * cannot read. This slice holds only what the UI needs to render -- losing it
 * on reload is harmless, because `me` re-establishes it from the cookie.
 *
 * Note also what the UI branches on: **permissions**, never a role name. Roles
 * are bundles, so a new role granting `stock:receive` must light up the receive
 * button with no frontend change. Hard-coding `role === 'WAREHOUSE'` anywhere
 * would quietly undo that.
 */

export interface SessionRole {
  id: string;
  key: string;
  name: string;
}

export interface SessionTenant {
  id: string;
  slug: string;
  name: string;
  /** Feature keys switched on. Absent means off. */
  features: string[];
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  tenant: SessionTenant;
  roles: SessionRole[];
  /** Effective permissions: the union across every role held. */
  permissions: string[];
}

export interface SessionState {
  user: SessionUser | null;
  /**
   * `unknown` until the first `me` resolves. The auth guard waits on this
   * rather than redirecting, otherwise a reload would bounce a signed-in user
   * to the login page before their cookie had been checked.
   */
  status: 'unknown' | 'authenticated' | 'anonymous';
}

const initialState: SessionState = { user: null, status: 'unknown' };

const sessionSlice = createSlice({
  name: 'session',
  initialState,
  reducers: {
    sessionEstablished(state, action: PayloadAction<SessionUser>) {
      state.user = action.payload;
      state.status = 'authenticated';
    },
    /** Signed out, or the refresh token is spent, revoked or expired. */
    sessionEnded(state) {
      state.user = null;
      state.status = 'anonymous';
    },
  },
});

export const { sessionEstablished, sessionEnded } = sessionSlice.actions;
export const sessionReducer = sessionSlice.reducer;

/**
 * The permission keys the UI cares about. Mirrors `api/src/shared/permissions.ts`.
 * Kept as a const object so a typo is a typecheck failure rather than a
 * silently-false permission check.
 */
export const PERMISSIONS = {
  PURCHASE_ORDER_READ: 'purchase_order:read',
  PURCHASE_ORDER_CREATE: 'purchase_order:create',
  PURCHASE_ORDER_VOID: 'purchase_order:void',
  STOCK_READ: 'stock:read',
  STOCK_RECEIVE: 'stock:receive',
  ROLE_MANAGE: 'role:manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * The client-side half of the rule the API enforces in `requirePermission`.
 * This only decides what to render; the server decides what is permitted, and
 * rejects a forged request regardless of what the UI shows.
 */
export const can = (user: SessionUser | null | undefined, permission: Permission): boolean =>
  user?.permissions.includes(permission) ?? false;

/**
 * Feature keys, mirroring `api/src/shared/features.ts`.
 *
 * Deliberately separate from permissions. A permission asks *may this user*; a
 * feature asks *does this organisation have it at all*. The UI needs both,
 * because something switched off for the tenant should disappear rather than
 * look like something the user could be granted.
 */
export const FEATURES = {
  STOCK_VIEW: 'stock.view',
} as const;

export type Feature = (typeof FEATURES)[keyof typeof FEATURES];

/**
 * Off unless switched on. Matching the server's default matters: if the UI
 * assumed "on" it would render a page the API refuses, which reads as a bug
 * rather than as a feature the customer does not have.
 */
export const hasFeature = (user: SessionUser | null | undefined, feature: Feature): boolean =>
  user?.tenant.features.includes(feature) ?? false;
