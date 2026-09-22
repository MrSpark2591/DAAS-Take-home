'use client';

import LogoutIcon from '@mui/icons-material/Logout';
import AppBar from '@mui/material/AppBar';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';
import { useLogoutMutation } from '@/lib/api';
import { useAppSelector } from '@/lib/hooks';

/** Header, nav, and the signed-in user's menu. */
export function AppShell({ children }: { children: ReactNode }) {
  const user = useAppSelector((state) => state.session.user);
  const [logout, logoutState] = useLogoutMutation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

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

          {user ? (
            <>
              <Tooltip title="Account">
                <Stack
                  direction="row"
                  spacing={1}
                  component="button"
                  type="button"
                  onClick={(event) => setAnchor(event.currentTarget)}
                  aria-haspopup="menu"
                  aria-label={`Account menu for ${user.name}`}
                  sx={{
                    alignItems: 'center',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    p: 0.5,
                    borderRadius: 1,
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  <Avatar sx={{ width: 30, height: 30, fontSize: 13, bgcolor: 'primary.main' }}>
                    {initials(user.name)}
                  </Avatar>
                  <Box sx={{ textAlign: 'left', display: { xs: 'none', sm: 'block' } }}>
                    <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
                      {user.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {ROLE_LABEL[user.role]}
                    </Typography>
                  </Box>
                </Stack>
              </Tooltip>

              <Menu
                anchorEl={anchor}
                open={Boolean(anchor)}
                onClose={() => setAnchor(null)}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                transformOrigin={{ vertical: 'top', horizontal: 'right' }}
              >
                <Box sx={{ px: 2, py: 1 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {user.email}
                  </Typography>
                  <Chip size="small" label={ROLE_LABEL[user.role]} sx={{ mt: 0.5 }} />
                </Box>
                <Divider />
                <MenuItem
                  onClick={() => {
                    setAnchor(null);
                    void logout();
                  }}
                  disabled={logoutState.isLoading}
                >
                  <ListItemIcon>
                    <LogoutIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>Sign out</ListItemText>
                </MenuItem>
              </Menu>
            </>
          ) : null}
        </Toolbar>
      </AppBar>

      <Container maxWidth="lg" sx={{ py: 4 }}>
        {children}
      </Container>
    </Box>
  );
}

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Admin',
  WAREHOUSE: 'Warehouse',
  VIEWER: 'Viewer',
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
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
