'use client';

import AddIcon from '@mui/icons-material/Add';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { QueryState } from '@/components/QueryState';
import { StatusChip } from '@/components/StatusChip';
import type { PurchaseOrderStatus } from '@/generated/graphql';
import { usePurchaseOrdersQuery } from '@/lib/api';
import { formatCents, formatDate } from '@/lib/format';
import { useAppSelector } from '@/lib/hooks';
import { can, PERMISSIONS } from '@/lib/session';

type StatusFilter = PurchaseOrderStatus | 'ALL';

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'ALL', label: 'All statuses' },
  { value: 'OPEN', label: 'Open' },
  { value: 'PARTIAL', label: 'Partially received' },
  { value: 'RECEIVED', label: 'Received' },
];

export default function PurchaseOrdersPage() {
  const router = useRouter();
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const user = useAppSelector((state) => state.session.user);
  const canCreate = can(user, PERMISSIONS.PURCHASE_ORDER_CREATE);

  // The filter is part of the query key, so RTK Query caches each tab
  // separately and switching back to a visited tab is instant.
  const { data, isLoading, isFetching, error, refetch } = usePurchaseOrdersQuery({
    filter: status === 'ALL' ? null : { status },
  });

  const orders = data?.purchaseOrders ?? [];

  return (
    <>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ justifyContent: 'space-between', alignItems: { sm: 'center' }, mb: 3 }}
      >
        <div>
          <Typography variant="h1">Purchase orders</Typography>
          <Typography color="text.secondary">
            Status is derived from received quantities, never set by hand.
          </Typography>
        </div>

        <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
          <TextField
            select
            size="small"
            label="Status"
            value={status}
            onChange={(event) => setStatus(event.target.value as StatusFilter)}
            sx={{ minWidth: 200 }}
          >
            {FILTERS.map((filter) => (
              <MenuItem key={filter.value} value={filter.value}>
                {filter.label}
              </MenuItem>
            ))}
          </TextField>

          {canCreate ? (
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              component={Link}
              href="/purchase-orders/new"
            >
              New PO
            </Button>
          ) : null}
        </Stack>
      </Stack>

      <QueryState
        isLoading={isLoading}
        error={error}
        onRetry={refetch}
        isEmpty={orders.length === 0}
        emptyTitle={status === 'ALL' ? 'No purchase orders yet' : 'Nothing matches this filter'}
        emptyBody={
          status === 'ALL'
            ? 'Create one to start receiving stock against it.'
            : 'Try a different status.'
        }
        emptyAction={
          status === 'ALL' && canCreate ? (
            <Button variant="contained" component={Link} href="/purchase-orders/new">
              New purchase order
            </Button>
          ) : null
        }
      >
        <TableContainer component={Paper} sx={{ opacity: isFetching ? 0.6 : 1 }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>PO</TableCell>
                <TableCell>Vendor</TableCell>
                <TableCell>Location</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Received / ordered</TableCell>
                <TableCell align="right">Value</TableCell>
                <TableCell align="right">Created</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {orders.map((order) => (
                <TableRow
                  key={order.id}
                  hover
                  sx={{ cursor: 'pointer' }}
                  onClick={() => router.push(`/purchase-orders/${order.id}`)}
                >
                  <TableCell>
                    <Typography sx={{ fontWeight: 600 }}>{order.poNumber}</Typography>
                  </TableCell>
                  <TableCell>{order.vendor.name}</TableCell>
                  <TableCell>{order.location.code}</TableCell>
                  <TableCell>
                    <StatusChip status={order.status} />
                  </TableCell>
                  <TableCell align="right">
                    {order.totalReceived} / {order.totalOrdered}
                  </TableCell>
                  <TableCell align="right">{formatCents(order.totalCostCents)}</TableCell>
                  <TableCell align="right">{formatDate(order.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </QueryState>
    </>
  );
}
