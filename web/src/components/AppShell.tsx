'use client';

import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import Link from 'next/link';
import { type ReactNode, useEffect } from 'react';
import { useDemoUsersQuery } from '@/lib/api';
import { useAppDispatch, useAppSelector } from '@/lib/hooks';
import { type Role, signedInAs } from '@/lib/session';

/**
 * Header, nav, and the demo role switcher.
 *
 * Switching role remints the bearer token in the store; RTK Query reads it on
 * the next request, so the whole app changes identity without a reload.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const dispatch = useAppDispatch();
  const session = useAppSelector((state) => state.session);
  const { data } = useDemoUsersQuery();

  const users = data?.demoUsers ?? [];

  // Default to the admin once the seeded users arrive, so a reviewer lands on
  // a session that can do everything rather than an empty one.
  useEffect(() => {
    if (session.user || users.length === 0) return;
    const admin = users.find((user) => user.role === 'ADMIN') ?? users[0];
    if (admin) {
      dispatch(signedInAs({ id: admin.id, label: admin.name, role: admin.role as Role }));
    }
  }, [users, session.user, dispatch]);

  return (
    <Box sx={{ minHeight: '100dvh', bgcolor: 'background.default' }}>
      <AppBar
        position="static"
        color="inherit"
        elevation={0}
        sx={{ borderBottom: '1px solid', borderColor: 'divider' }}
      >
        <Toolbar sx={{ gap: 3 }}>
          <Typography
            variant="h3"
            component={Link}
            href="/purchase-orders"
            sx={{ color: 'text.primary', textDecoration: 'none', letterSpacing: '-0.02em' }}
          >
            DaaS
          </Typography>

          <Stack direction="row" spacing={2} sx={{ flexGrow: 1 }}>
            <NavLink href="/purchase-orders">Purchase orders</NavLink>
            <NavLink href="/stock">Stock on hand</NavLink>
          </Stack>

          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <TextField
              select
              size="small"
              label="Acting as"
              value={session.user?.id ?? ''}
              sx={{ minWidth: 220 }}
              slotProps={{ htmlInput: { 'aria-label': 'Acting as role' } }}
              onChange={(event) => {
                const user = users.find((candidate) => candidate.id === event.target.value);
                if (user) {
                  dispatch(signedInAs({ id: user.id, label: user.name, role: user.role as Role }));
                }
              }}
            >
              {users.map((user) => (
                <MenuItem key={user.id} value={user.id}>
                  {user.name}
                </MenuItem>
              ))}
            </TextField>

            {/*
              The explanation hangs off its own icon rather than the select. On
              the select it fired every time someone reached for the dropdown,
              which is exactly when it is in the way.
            */}
            <Tooltip title="Demo sign-in: picks one of the seeded users and mints their bearer token. The API enforces the role on its own regardless of what this is set to.">
              <InfoOutlinedIcon
                fontSize="small"
                aria-label="About the role switcher"
                sx={{ color: 'text.disabled', cursor: 'help' }}
              />
            </Tooltip>
          </Stack>
        </Toolbar>
      </AppBar>

      <Container maxWidth="lg" sx={{ py: 4 }}>
        {children}
      </Container>
    </Box>
  );
}

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Typography
      component={Link}
      href={href}
      sx={{
        color: 'text.secondary',
        textDecoration: 'none',
        fontWeight: 500,
        '&:hover': { color: 'primary.main' },
      }}
    >
      {children}
    </Typography>
  );
}
