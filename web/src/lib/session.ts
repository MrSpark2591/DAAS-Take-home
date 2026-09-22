import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/**
 * Who the browser is signed in as.
 *
 * Note what is NOT here: any token. Both the access and refresh tokens are
 * httpOnly cookies the browser attaches automatically and page JavaScript
 * cannot read. This slice holds only the identity the UI needs to render --
 * losing it on reload is harmless, because `me` re-establishes it from the
 * cookie.
 */

export type Role = 'ADMIN' | 'WAREHOUSE' | 'VIEWER';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
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
 * The client-side half of the rules the API enforces in `requireRole`. These
 * only decide what to render; the server decides what is permitted, and will
 * reject a forged request regardless of what the UI shows.
 */
export const canReceiveStock = (role: Role | undefined): boolean =>
  role === 'ADMIN' || role === 'WAREHOUSE';

export const canManagePurchaseOrders = (role: Role | undefined): boolean => role === 'ADMIN';
