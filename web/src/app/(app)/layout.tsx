import type { ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';
import { AuthGuard } from '@/components/AuthGuard';

/**
 * Layout for everything behind a session. `/login` deliberately sits outside
 * this group, so it renders without the app chrome and without the guard that
 * would redirect it to itself.
 *
 * The parentheses make this a route group: it organises files without adding a
 * URL segment, so these pages stay at /purchase-orders and /stock.
 */
export default function AuthenticatedLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGuard>
      <AppShell>{children}</AppShell>
    </AuthGuard>
  );
}
