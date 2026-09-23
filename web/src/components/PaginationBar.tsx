'use client';

import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

interface PaginationBarProps {
  totalCount: number;
  shown: number;
  range: { from: number; to: number };
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  busy?: boolean;
}

/**
 * Next/previous rather than numbered pages, because the API is keyset
 * paginated: cursors walk forward from where you are, so there is no cursor for
 * "page 37" without fetching the 36 before it. The total is still shown, since
 * the API returns it alongside the page.
 */
export function PaginationBar({
  totalCount,
  shown,
  range,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  busy = false,
}: PaginationBarProps) {
  if (totalCount === 0) return null;

  const to = Math.min(range.from + shown - 1, totalCount);

  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{ alignItems: 'center', justifyContent: 'flex-end', mt: 2 }}
    >
      <Typography variant="body2" color="text.secondary" aria-live="polite">
        {range.from}–{to} of {totalCount}
      </Typography>
      <Button
        size="small"
        startIcon={<ChevronLeftIcon />}
        onClick={onPrevious}
        disabled={!hasPrevious || busy}
      >
        Previous
      </Button>
      <Button
        size="small"
        endIcon={<ChevronRightIcon />}
        onClick={onNext}
        disabled={!hasNext || busy}
      >
        Next
      </Button>
    </Stack>
  );
}
