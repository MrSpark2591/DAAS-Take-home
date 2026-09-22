'use client';

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
import { useState } from 'react';
import { QueryState } from '@/components/QueryState';
import { useFormOptionsQuery, useStockOnHandQuery } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

/**
 * The read side of receiving: proof that a receipt moved real stock. Shares the
 * `StockOnHand` cache tag with the receive mutation, so confirming a receipt
 * refreshes this page without it knowing anything about purchase orders.
 */
export default function StockPage() {
  const [locationId, setLocationId] = useState('');
  const options = useFormOptionsQuery();

  const { data, isLoading, isFetching, error, refetch } = useStockOnHandQuery({
    locationId: locationId || null,
  });

  const rows = data?.stockOnHand ?? [];

  return (
    <>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ justifyContent: 'space-between', alignItems: { sm: 'center' }, mb: 3 }}
      >
        <div>
          <Typography variant="h1">Stock on hand</Typography>
          <Typography color="text.secondary">
            A projection of the stock ledger, updated in the same transaction as each movement.
          </Typography>
        </div>

        <TextField
          select
          size="small"
          label="Location"
          value={locationId}
          onChange={(event) => setLocationId(event.target.value)}
          sx={{ minWidth: 220 }}
        >
          <MenuItem value="">All locations</MenuItem>
          {(options.data?.locations ?? []).map((location) => (
            <MenuItem key={location.id} value={location.id}>
              {location.code} — {location.name}
            </MenuItem>
          ))}
        </TextField>
      </Stack>

      <QueryState
        isLoading={isLoading}
        error={error}
        onRetry={refetch}
        isEmpty={rows.length === 0}
        emptyTitle="No stock on hand"
        emptyBody="Receive a purchase order and it will show up here."
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
      </QueryState>
    </>
  );
}
