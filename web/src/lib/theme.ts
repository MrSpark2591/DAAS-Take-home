'use client';

import { createTheme } from '@mui/material/styles';

/**
 * One theme, and every colour in the app comes from it. Components use
 * `color="primary"`, `color="warning.main"` and spacing units rather than hex
 * values, so a rebrand is a change here and nowhere else.
 *
 * Status colours are registered as real palette entries for the same reason:
 * the OPEN/PARTIAL/RECEIVED chips reference `status.open` rather than each
 * picking their own green.
 */
declare module '@mui/material/styles' {
  interface Palette {
    status: { open: string; partial: string; received: string };
  }
  interface PaletteOptions {
    status?: { open: string; partial: string; received: string };
  }
}

export const theme = createTheme({
  cssVariables: true,
  palette: {
    mode: 'light',
    primary: { main: '#1d4ed8' },
    secondary: { main: '#7c3aed' },
    success: { main: '#15803d' },
    warning: { main: '#b45309' },
    error: { main: '#b91c1c' },
    background: { default: '#f6f7f9', paper: '#ffffff' },
    status: {
      open: '#64748b',
      partial: '#b45309',
      received: '#15803d',
    },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: 'var(--font-geist-sans), system-ui, -apple-system, sans-serif',
    h1: { fontSize: '1.75rem', fontWeight: 600 },
    h2: { fontSize: '1.35rem', fontWeight: 600 },
    h3: { fontSize: '1.1rem', fontWeight: 600 },
    // Used for SKUs and ids, where character alignment matters.
    overline: { fontFamily: 'var(--font-geist-mono), ui-monospace, monospace', letterSpacing: 0 },
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: { root: { textTransform: 'none', fontWeight: 600 } },
    },
    MuiPaper: {
      defaultProps: { variant: 'outlined' },
    },
    MuiTextField: {
      defaultProps: { size: 'small' },
    },
    MuiTableCell: {
      styleOverrides: { head: { fontWeight: 600 } },
    },
  },
});
