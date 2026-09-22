'use client';

import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter';
import { type ReactNode, useRef } from 'react';
import { Provider } from 'react-redux';
import { type AppStore, makeStore } from '@/lib/store';
import { theme } from '@/lib/theme';

/**
 * The store is created once per browser session and held in a ref rather than
 * a module-level singleton -- a module singleton is shared across requests on
 * the server, which would leak one user's cache into another's render.
 */
export function Providers({ children }: { children: ReactNode }) {
  const storeRef = useRef<AppStore | null>(null);
  if (!storeRef.current) storeRef.current = makeStore();

  return (
    <Provider store={storeRef.current}>
      <AppRouterCacheProvider options={{ key: 'mui' }}>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          {children}
        </ThemeProvider>
      </AppRouterCacheProvider>
    </Provider>
  );
}
