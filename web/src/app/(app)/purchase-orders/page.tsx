'use client';

import AddIcon from '@mui/icons-material/Add';
import SearchIcon from '@mui/icons-material/Search';
import Button from '@mui/material/Button';
import InputAdornment from '@mui/material/InputAdornment';
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
import { useEffect, useState } from 'react';
import { PaginationBar } from '@/components/PaginationBar';
import { QueryState } from '@/components/QueryState';
import { StatusChip } from '@/components/StatusChip';
import type { PurchaseOrderStatus } from '@/generated/graphql';
import { useFormOptionsQuery, usePurchaseOrdersQuery } from '@/lib/api';
import { formatCents, formatDate } from '@/lib/format';
import { useAppSelector } from '@/lib/hooks';
import { MIN_SEARCH_CHARS, useCursorPagination, useSearchTerm } from '@/lib/pagination';
import { can, PERMISSIONS } from '@/lib/session';

type StatusFilter = PurchaseOrderStatus | 'ALL';

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'ALL', label: 'All statuses' },
  { value: 'OPEN', label: 'Open' },
  { value: 'PARTIAL', label: 'Partially received' },
  { value: 'RECEIVED', label: 'Received' },
];

const PAGE_SIZE = 20;

export default function PurchaseOrdersPage() {
  const router = useRouter();
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [vendorId, setVendorId] = useState('');
  const [search, setSearch] = useState('');
  const user = useAppSelector((state) => state.session.user);
  const canCreate = can(user, PERMISSIONS.PURCHASE_ORDER_CREATE);

  // Debounced, and held back below three characters, so typing fires one
  // query when the term is worth running -- not one per keystroke.
  const { applied: appliedSearch, pending: searchPending } = useSearchTerm(search);
  const pagination = useCursorPagination(PAGE_SIZE);

  // Every filter is sent to the API; nothing is narrowed in the browser. The
  // filter values are part of the RTK Query cache key, so each combination
  // caches independently and returning to one is instant.
  const filter = {
    ...(status === 'ALL' ? {} : { status }),
    ...(vendorId ? { vendorId } : {}),
    ...(appliedSearch ? { search: appliedSearch } : {}),
  };

  const { data, isLoading, isFetching, error, refetch } = usePurchaseOrdersQuery({
    filter,
    first: PAGE_SIZE,
    after: pagination.after,
  });

  const options = useFormOptionsQuery();

  // Cursors point into a specific result set, so changing a filter invalidates
  // them -- staying on "page 3" of a list that no longer has three pages would
  // show an empty table.
  const { reset } = pagination;
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets the page when the filter changes
  useEffect(() => {
    reset();
  }, [status, vendorId, appliedSearch, reset]);

  const connection = data?.purchaseOrders;
  const orders = connection?.nodes ?? [];
  const hasFilters = status !== 'ALL' || Boolean(vendorId) || Boolean(appliedSearch);

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

        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          sx={{ alignItems: { md: 'center' } }}
        >
          <TextField
            size="small"
            label="Search PO number"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            helperText={
              searchPending ? `Keep typing — ${MIN_SEARCH_CHARS} characters minimum` : ' '
            }
            sx={{ minWidth: 200 }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
          />

          <TextField
            select
            size="small"
            label="Vendor"
            value={vendorId}
            onChange={(event) => setVendorId(event.target.value)}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="">All vendors</MenuItem>
            {(options.data?.vendors ?? []).map((vendor) => (
              <MenuItem key={vendor.id} value={vendor.id}>
                {vendor.name}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            size="small"
            label="Status"
            value={status}
            onChange={(event) => setStatus(event.target.value as StatusFilter)}
            sx={{ minWidth: 180 }}
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
        emptyTitle={hasFilters ? 'Nothing matches these filters' : 'No purchase orders yet'}
        emptyBody={
          hasFilters
            ? 'Try a different vendor, status or search term.'
            : 'Create one to start receiving stock against it.'
        }
        emptyAction={
          !hasFilters && canCreate ? (
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

        <PaginationBar
          totalCount={connection?.totalCount ?? 0}
          shown={orders.length}
          range={pagination.range}
          hasPrevious={pagination.hasPrevious}
          hasNext={connection?.pageInfo.hasNextPage ?? false}
          onPrevious={pagination.previous}
          onNext={() => pagination.next(connection?.pageInfo.endCursor)}
          busy={isFetching}
        />
      </QueryState>
    </>
  );
}
