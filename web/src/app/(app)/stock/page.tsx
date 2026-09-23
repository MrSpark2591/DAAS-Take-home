'use client';

import SearchIcon from '@mui/icons-material/Search';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
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
import { useEffect, useState } from 'react';
import { PaginationBar } from '@/components/PaginationBar';
import { QueryState } from '@/components/QueryState';
import { useFormOptionsQuery, useStockOnHandQuery } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useAppSelector } from '@/lib/hooks';
import { useCursorPagination, useDebounced } from '@/lib/pagination';
import { FEATURES, hasFeature } from '@/lib/session';

const PAGE_SIZE = 20;

/**
 * The read side of receiving: proof that a receipt moved real stock. Shares the
 * `StockOnHand` cache tag with the receive mutation, so confirming a receipt
 * refreshes this page without it knowing anything about purchase orders.
 *
 * Every filter is applied in SQL. Searching SKUs in the browser would only ever
 * search the page already loaded, which is wrong the moment there is more than
 * one page.
 */
export default function StockPage() {
  // Hiding the nav entry is not enough -- someone can still type the URL. The
  // API refuses either way; this just makes the refusal legible.
  const user = useAppSelector((state) => state.session.user);
  const enabled = hasFeature(user, FEATURES.STOCK_VIEW);

  const [locationId, setLocationId] = useState('');
  const [search, setSearch] = useState('');
  const [inStockOnly, setInStockOnly] = useState(false);

  const debouncedSearch = useDebounced(search);
  const pagination = useCursorPagination(PAGE_SIZE);
  const options = useFormOptionsQuery();

  const filter = {
    ...(locationId ? { locationId } : {}),
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(inStockOnly ? { inStockOnly: true } : {}),
  };

  const { data, isLoading, isFetching, error, refetch } = useStockOnHandQuery(
    { filter, first: PAGE_SIZE, after: pagination.after },
    // Do not call an endpoint the tenant is not entitled to; it would only
    // return FEATURE_DISABLED and light up the error state.
    { skip: !enabled },
  );

  // Cursors belong to one result set, so a filter change has to restart paging.
  const { reset } = pagination;
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets the page when the filter changes
  useEffect(() => {
    reset();
  }, [locationId, debouncedSearch, inStockOnly, reset]);

  const connection = data?.stockOnHand;
  const rows = connection?.nodes ?? [];
  const hasFilters = Boolean(locationId || debouncedSearch.trim() || inStockOnly);

  if (!enabled) {
    return (
      <Box sx={{ py: 8, textAlign: 'center' }}>
        <Typography variant="h1" gutterBottom>
          Stock is not enabled
        </Typography>
        <Typography color="text.secondary">
          Stock visibility is switched off for {user?.tenant.name ?? 'your organisation'}. Talk to
          your account manager if you need it.
        </Typography>
      </Box>
    );
  }

  return (
    <>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={2}
        sx={{ justifyContent: 'space-between', alignItems: { md: 'center' }, mb: 3 }}
      >
        <div>
          <Typography variant="h1">Stock on hand</Typography>
          <Typography color="text.secondary">
            A projection of the stock ledger, updated in the same transaction as each movement.
          </Typography>
        </div>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: 'center' }}>
          <TextField
            size="small"
            label="Search SKU or product"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            sx={{ minWidth: 210 }}
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
            label="Location"
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="">All locations</MenuItem>
            {(options.data?.locations ?? []).map((location) => (
              <MenuItem key={location.id} value={location.id}>
                {location.code} — {location.name}
              </MenuItem>
            ))}
          </TextField>

          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={inStockOnly}
                onChange={(event) => setInStockOnly(event.target.checked)}
              />
            }
            label="In stock only"
          />
        </Stack>
      </Stack>

      <QueryState
        isLoading={isLoading}
        error={error}
        onRetry={refetch}
        isEmpty={rows.length === 0}
        emptyTitle={hasFilters ? 'Nothing matches these filters' : 'No stock on hand'}
        emptyBody={
          hasFilters
            ? 'Try a different location or search term.'
            : 'Receive a purchase order and it will show up here.'
        }
      >
        <TableContainer component={Paper} sx={{ opacity: isFetching ? 0.6 : 1 }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>SKU</TableCell>
                <TableCell>Product</TableCell>
                <TableCell>Location</TableCell>
                <TableCell align="right">Quantity</TableCell>
                <TableCell align="right">Last movement</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} hover>
                  <TableCell>
                    <Typography sx={{ fontWeight: 600 }}>{row.product.sku}</Typography>
                  </TableCell>
                  <TableCell>{row.product.name}</TableCell>
                  <TableCell>{row.location.code}</TableCell>
                  <TableCell align="right">
                    <Typography sx={{ fontWeight: 600 }}>{row.quantity}</Typography>
                  </TableCell>
                  <TableCell align="right">{formatDateTime(row.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>

        <PaginationBar
          totalCount={connection?.totalCount ?? 0}
          shown={rows.length}
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
