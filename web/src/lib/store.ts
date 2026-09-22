import { configureStore } from '@reduxjs/toolkit';
import { setupListeners } from '@reduxjs/toolkit/query';
import { api } from './api';
import { sessionReducer } from './session';

export function makeStore() {
  const store = configureStore({
    reducer: {
      [api.reducerPath]: api.reducer,
      session: sessionReducer,
    },
    middleware: (getDefault) => getDefault().concat(api.middleware),
  });

  // Enables refetchOnFocus / refetchOnReconnect for endpoints that opt in.
  setupListeners(store.dispatch);
  return store;
}

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
