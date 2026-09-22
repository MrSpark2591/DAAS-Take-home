'use client';

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';
import { asApiError } from '@/lib/api';

/**
 * One place that decides what loading, empty and error look like.
 *
 * Every list and detail screen renders through this, so the three states are
 * handled identically everywhere instead of each page inventing its own
 * spinner and forgetting the empty case.
 */
interface QueryStateProps {
  isLoading: boolean;
  error: unknown;
  isEmpty?: boolean;
  emptyTitle?: string;
  emptyBody?: string;
  emptyAction?: ReactNode;
  onRetry?: () => void;
  skeletonRows?: number;
  children: ReactNode;
}

export function QueryState({
  isLoading,
  error,
  isEmpty = false,
  emptyTitle = 'Nothing here yet',
  emptyBody,
  emptyAction,
  onRetry,
  skeletonRows = 4,
  children,
}: QueryStateProps) {
  if (isLoading) {
    return (
      <Stack spacing={1} aria-busy="true" aria-live="polite">
        {Array.from({ length: skeletonRows }, (_, index) => (
          // Skeleton rows are positional placeholders with no identity of their
          // own, so the index is the only key available.
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
          <Skeleton key={index} variant="rounded" height={56} />
        ))}
      </Stack>
    );
  }

  if (error) {
    const apiError = asApiError(error);
    return (
      <Alert
        severity={apiError?.code === 'FORBIDDEN' ? 'warning' : 'error'}
        action={
          onRetry ? (
            <Button color="inherit" size="small" onClick={onRetry}>
              Retry
            </Button>
          ) : null
        }
      >
        <AlertTitle>{titleForCode(apiError?.code)}</AlertTitle>
        {apiError?.message ?? 'Something went wrong.'}
      </Alert>
    );
  }

  if (isEmpty) {
    return (
      <Box
        sx={{
          py: 6,
          px: 3,
          textAlign: 'center',
          border: '1px dashed',
          borderColor: 'divider',
          borderRadius: 2,
        }}
      >
        <Typography variant="h3" gutterBottom>
          {emptyTitle}
        </Typography>
        {emptyBody ? (
          <Typography color="text.secondary" sx={{ mb: emptyAction ? 2 : 0 }}>
            {emptyBody}
          </Typography>
        ) : null}
        {emptyAction}
      </Box>
    );
  }

  return <>{children}</>;
}

function titleForCode(code: string | undefined): string {
  switch (code) {
    case 'FORBIDDEN':
      return 'Not allowed';
    case 'UNAUTHENTICATED':
      return 'Sign in required';
    case 'NOT_FOUND':
      return 'Not found';
    case 'NETWORK_ERROR':
      return 'API unreachable';
    default:
      return 'Something went wrong';
  }
}
