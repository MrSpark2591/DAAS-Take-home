'use client';

import Chip from '@mui/material/Chip';
import type { PurchaseOrderStatus } from '@/generated/graphql';

/**
 * Colours come from `palette.status`, not from inline hex, so the three
 * statuses stay visually consistent everywhere they appear.
 */
const LABEL: Record<PurchaseOrderStatus, string> = {
  OPEN: 'Open',
  PARTIAL: 'Partially received',
  RECEIVED: 'Received',
};

export function StatusChip({ status }: { status: PurchaseOrderStatus }) {
  return (
    <Chip
      size="small"
      label={LABEL[status]}
      variant="outlined"
      sx={{
        color: `status.${status.toLowerCase()}`,
        borderColor: `status.${status.toLowerCase()}`,
        fontWeight: 600,
      }}
    />
  );
}
