import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/**
 * Who the browser is acting as.
 *
 * Real deployments get this from the IdP. For the take-home it is a role
 * switcher in the header so a reviewer can watch the same screen change
 * behaviour per role -- and watch the API reject a VIEWER even if they force
 * the button back on in devtools. The UI mirrors the policy; it does not own it.
 */

export type Role = 'ADMIN' | 'WAREHOUSE' | 'VIEWER';

/** Mirrors `mintToken` in api/src/shared/auth.ts. */
function mintToken(userId: string, role: Role): string {
  const payload = JSON.stringify({ sub: userId, role });
  const base64 = btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `daas_${base64}`;
}

export interface DemoUser {
  id: string;
  label: string;
  role: Role;
}

export interface SessionState {
  /** Null until the seeded users load, which is what mints a usable token. */
  user: DemoUser | null;
  token: string | null;
}

const initialState: SessionState = { user: null, token: null };

const sessionSlice = createSlice({
  name: 'session',
  initialState,
  reducers: {
    signedInAs(state, action: PayloadAction<DemoUser>) {
      state.user = action.payload;
      state.token = mintToken(action.payload.id, action.payload.role);
    },
    signedOut(state) {
      state.user = null;
      state.token = null;
    },
  },
});

export const { signedInAs, signedOut } = sessionSlice.actions;
export const sessionReducer = sessionSlice.reducer;

/** The client-side half of the rule the API enforces in `requireRole`. */
export const canReceiveStock = (role: Role | undefined): boolean =>
  role === 'ADMIN' || role === 'WAREHOUSE';

export const canManagePurchaseOrders = (role: Role | undefined): boolean => role === 'ADMIN';
