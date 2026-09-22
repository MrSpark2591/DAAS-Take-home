'use client';

import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { useMeQuery } from '@/lib/api';
import { useAppSelector } from '@/lib/hooks';

/**
 * Gates the app on a real session.
 *
 * Running `me` here is what establishes the session after a reload: the tokens
 * are httpOnly cookies, so the client cannot inspect them and has to ask the
 * server who it is.
 *
 * This is a UX gate, not a security boundary. Every resolver enforces its own
 * rules, so bypassing this in devtools reveals an empty shell, not data.
 */
export function AuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const status = useAppSelector((state) => state.session.status);

  // Fires the session check. `me` returns null rather than erroring when
  // anonymous, so this is safe to run before we know anything.
  const { isLoading } = useMeQuery();

  useEffect(() => {
    if (status !== 'anonymous') return;
    // Preserved so signing in returns them to the page they asked for.
    const next = encodeURIComponent(pathname);
    router.replace(`/login?next=${next}`);
  }, [status, pathname, router]);

  // `unknown` means the cookie has not been checked yet. Redirecting here would
  // bounce a perfectly valid session to the login page on every reload.
  if (status === 'unknown' || isLoading) {
    return (
      <Box sx={{ minHeight: '100dvh', display: 'grid', placeItems: 'center' }}>
        <CircularProgress aria-label="Checking your session" />
      </Box>
    );
  }

  if (status === 'anonymous') return null;

  return <>{children}</>;
}
