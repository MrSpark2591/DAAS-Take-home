'use client';

import InventoryIcon from '@mui/icons-material/Inventory2Outlined';
import Box from '@mui/material/Box';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import Link from 'next/link';
import { use, useState } from 'react';
import { QueryState } from '@/components/QueryState';
import { ReceiveDialog } from '@/components/ReceiveDialog';
import { StatusChip } from '@/components/StatusChip';
import { usePurchaseOrderQuery } from '@/lib/api';
import { formatCents, formatDateTime } from '@/lib/format';
import { useAppSelector } from '@/lib/hooks';
import { canReceiveStock } from '@/lib/session';

export default function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const role = useAppSelector((state) => state.session.user?.role);

  const { data, isLoading, error, refetch } = usePurchaseOrderQuery({ id });
  const order = data?.purchaseOrder;

  const canReceive = canReceiveStock(role);
  const hasOutstanding = (order?.lines ?? []).some((line) => line.quantityOutstanding > 0);

  return (
    <QueryState
      isLoading={isLoading}
      error={error}
      onRetry={refetch}
      isEmpty={!order}
      emptyTitle="Purchase order not found"
      emptyBody="It may have been voided."
      emptyAction={
        <Button component={Link} href="/purchase-orders" variant="contained">
          Back to purchase orders
        </Button>
      }
      skeletonRows={6}
    >
      {order ? (
        <>
          <Breadcrumbs sx={{ mb: 1 }}>
            <Link href="/purchase-orders" style={{ color: 'inherit' }}>
              Purchase orders
            </Link>
            <Typography color="text.primary">{order.poNumber}</Typography>
          </Breadcrumbs>

          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            sx={{ justifyContent: 'space-between', alignItems: { sm: 'center' }, mb: 3 }}
          >
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
              <Typography variant="h1">{order.poNumber}</Typography>
              <StatusChip status={order.status} />
            </Stack>

            {/*
              The button mirrors the API's rule rather than owning it. A VIEWER
              who re-enables it in devtools still gets FORBIDDEN from the server.
            */}
            <Tooltip
              title={
                !canReceive
                  ? 'Your role cannot receive stock. Switch to Ada or Wes in the header.'
                  : !hasOutstanding
                    ? 'Every line on this order has been fully received.'
                    : ''
              }
            >
              <span>
                <Button
                  variant="contained"
                  startIcon={<InventoryIcon />}
                  disabled={!canReceive || !hasOutstanding}
                  onClick={() => setReceiveOpen(true)}
                >
                  Receive stock
                </Button>
              </span>
            </Tooltip>
          </Stack>

          <Grid container spacing={2} sx={{ mb: 3 }}>
            <Summary label="Vendor" value={order.vendor.name} />
            <Summary
              label="Receiving location"
              value={`${order.location.code} — ${order.location.name}`}
            />
            <Summary label="Order value" value={formatCents(order.totalCostCents)} />
            <Summary label="Raised by" value={order.createdBy.name} />
          </Grid>

          {order.notes ? (
            <Paper sx={{ p: 2, mb: 3 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                Notes
              </Typography>
              <Typography>{order.notes}</Typography>
            </Paper>
          ) : null}

          <Paper sx={{ p: 3 }}>
            <Typography variant="h3" gutterBottom>
              Lines
            </Typography>

            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Product</TableCell>
                  <TableCell align="right">Unit cost</TableCell>
                  <TableCell align="right">Ordered</TableCell>
                  <TableCell align="right">Received</TableCell>
                  <TableCell sx={{ width: 180 }}>Progress</TableCell>
                  <TableCell align="right">Line total</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {order.lines.map((line) => {
                  const percent =
                    line.quantityOrdered === 0
                      ? 0
                      : Math.min(100, (line.quantityReceived / line.quantityOrdered) * 100);

                  return (
                    <TableRow key={line.id} sx={{ '& > *': { borderBottom: 'unset' } }}>
                      <TableCell>
                        <Typography sx={{ fontWeight: 600 }}>{line.product.sku}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {line.product.name}
                        </Typography>
                        {line.receipts.length > 0 ? (
                          <Box sx={{ mt: 1 }}>
                            {line.receipts.map((receipt) => (
                              <Typography
                                key={receipt.id}
                                variant="caption"
                                color="text.secondary"
                                sx={{ display: 'block' }}
                              >
                                +{receipt.quantity} into {receipt.location.code} ·{' '}
                                {formatDateTime(receipt.createdAt)} · {receipt.createdBy.name}
                                {receipt.reason ? ` · ${receipt.reason}` : ''}
                              </Typography>
                            ))}
                          </Box>
                        ) : null}
                      </TableCell>
                      <TableCell align="right">{formatCents(line.unitCostCents)}</TableCell>
                      <TableCell align="right">{line.quantityOrdered}</TableCell>
                      <TableCell align="right">{line.quantityReceived}</TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <LinearProgress
                            variant="determinate"
                            value={percent}
                            color={percent === 100 ? 'success' : 'warning'}
                            sx={{ flexGrow: 1, height: 8, borderRadius: 4 }}
                          />
                          {line.quantityOutstanding > 0 ? (
                            <Chip size="small" label={`${line.quantityOutstanding} left`} />
                          ) : null}
                        </Stack>
                      </TableCell>
                      <TableCell align="right">{formatCents(line.lineTotalCents)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Paper>

          {receiveOpen ? (
            <ReceiveDialog
              open={receiveOpen}
              onClose={() => setReceiveOpen(false)}
              purchaseOrder={order}
            />
          ) : null}
        </>
      ) : null}
    </QueryState>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <Grid size={{ xs: 12, sm: 6, md: 3 }}>
      <Paper sx={{ p: 2, height: '100%' }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {label}
        </Typography>
        <Typography sx={{ fontWeight: 600 }}>{value}</Typography>
      </Paper>
    </Grid>
  );
}
