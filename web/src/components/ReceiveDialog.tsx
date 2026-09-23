'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import type { PurchaseOrderQuery } from '@/generated/graphql';
import { asApiError, useFormOptionsQuery, useReceivePurchaseOrderMutation } from '@/lib/api';

type PurchaseOrder = NonNullable<PurchaseOrderQuery['purchaseOrder']>;
type Line = PurchaseOrder['lines'][number];

interface ReceiveDialogProps {
  open: boolean;
  onClose: () => void;
  purchaseOrder: PurchaseOrder;
}

/**
 * Receiving form. Only lines with something outstanding are shown -- you
 * cannot receive against a line that is already complete.
 *
 * The per-line max is validated here for fast feedback and again on the server
 * inside the transaction, which is the copy that actually counts: this dialog
 * can be stale by the time it is submitted if someone else received first.
 */
export function ReceiveDialog({ open, onClose, purchaseOrder }: ReceiveDialogProps) {
  const outstanding = purchaseOrder.lines.filter((line) => line.quantityOutstanding > 0);
  const options = useFormOptionsQuery();
  const [receive, receiveState] = useReceivePurchaseOrderMutation();

  // The form seeds locationId from the PO, which is known immediately, while the
  // location list arrives a request later. Falling back to the PO's own location
  // keeps the Select's value in range for that gap -- otherwise MUI renders an
  // empty box and warns about an out-of-range value.
  const locationOptions = options.data?.locations ?? [purchaseOrder.location];

  const schema = buildSchema(outstanding);
  type FormValues = z.input<typeof schema>;
  type ParsedValues = z.output<typeof schema>;

  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues, unknown, ParsedValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      locationId: purchaseOrder.location.id,
      reason: '',
      // Pre-filled with the full outstanding quantity: receiving everything is
      // the common case, and correcting a number is faster than typing one.
      quantities: Object.fromEntries(
        outstanding.map((line) => [line.id, line.quantityOutstanding]),
      ),
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    const lines = Object.entries(values.quantities)
      .map(([purchaseOrderLineId, quantity]) => ({ purchaseOrderLineId, quantity }))
      .filter((line) => line.quantity > 0);

    try {
      await receive({
        input: {
          purchaseOrderId: purchaseOrder.id,
          locationId: values.locationId,
          reason: values.reason || null,
          lines,
        },
      }).unwrap();

      reset();
      onClose();
    } catch {
      // Surfaced in the banner below via `receiveState.error`.
    }
  });

  const error = asApiError(receiveState.error);

  return (
    <Dialog
      open={open}
      // Undefined while the receipt is in flight, which is what stops the
      // backdrop and Escape from closing it. Dismissing the dialog does not
      // cancel the transaction -- it only hides the outcome of one.
      onClose={receiveState.isLoading ? undefined : onClose}
      maxWidth="md"
      fullWidth
    >
      <form onSubmit={onSubmit} noValidate>
        <DialogTitle>Receive against {purchaseOrder.poNumber}</DialogTitle>

        <DialogContent>
          {error ? (
            <Alert severity={error.code === 'FORBIDDEN' ? 'warning' : 'error'} sx={{ mb: 2 }}>
              {error.message}
            </Alert>
          ) : null}

          <DialogContentText sx={{ mb: 2 }}>
            Each quantity appends a stock movement and increases on-hand at the chosen location. The
            whole receipt is one transaction.
          </DialogContentText>

          <Stack spacing={2}>
            <Controller
              control={control}
              name="locationId"
              render={({ field }) => (
                <TextField
                  {...field}
                  select
                  label="Receive into"
                  fullWidth
                  helperText="Defaults to the order's location. Override for an overflow delivery."
                >
                  {locationOptions.map((location) => (
                    <MenuItem key={location.id} value={location.id}>
                      {location.code} — {location.name}
                    </MenuItem>
                  ))}
                </TextField>
              )}
            />

            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Product</TableCell>
                  <TableCell align="right">Ordered</TableCell>
                  <TableCell align="right">Received</TableCell>
                  <TableCell align="right">Outstanding</TableCell>
                  <TableCell align="right" sx={{ width: 140 }}>
                    Receive now
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {outstanding.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {line.product.sku}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {line.product.name}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">{line.quantityOrdered}</TableCell>
                    <TableCell align="right">{line.quantityReceived}</TableCell>
                    <TableCell align="right">{line.quantityOutstanding}</TableCell>
                    <TableCell align="right">
                      <TextField
                        {...register(`quantities.${line.id}`)}
                        type="number"
                        size="small"
                        slotProps={{
                          htmlInput: {
                            min: 0,
                            max: line.quantityOutstanding,
                            step: 1,
                            'aria-label': `Quantity to receive for ${line.product.sku}`,
                          },
                        }}
                        error={Boolean(errors.quantities?.[line.id])}
                        helperText={errors.quantities?.[line.id]?.message}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {errors.quantities?.root ? (
              <Alert severity="error">{errors.quantities.root.message}</Alert>
            ) : null}

            <TextField
              {...register('reason')}
              label="Reason / delivery note"
              fullWidth
              placeholder="Delivery docket 88213"
              helperText="Recorded on every movement in this receipt."
            />
          </Stack>
        </DialogContent>

        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={onClose} color="inherit" disabled={receiveState.isLoading}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="contained"
            loading={receiveState.isLoading}
            loadingPosition="start"
          >
            {receiveState.isLoading ? 'Receiving…' : 'Confirm receipt'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/**
 * Built from the current lines so each field's max is that line's outstanding
 * quantity, and so the "at least one" rule can look across all of them.
 */
function buildSchema(lines: Line[]) {
  const quantities = Object.fromEntries(
    lines.map((line) => [
      line.id,
      z.coerce
        .number({ invalid_type_error: 'Enter a number.' })
        .int('Whole units only.')
        .min(0, 'Cannot be negative.')
        .max(line.quantityOutstanding, `Only ${line.quantityOutstanding} outstanding.`),
    ]),
  );

  return z.object({
    locationId: z.string().min(1, 'Choose a location.'),
    reason: z.string().trim().max(500).optional(),
    quantities: z
      .object(quantities)
      .refine(
        (value) => Object.values(value).some((quantity) => Number(quantity) > 0),
        'Enter a quantity on at least one line.',
      ),
  });
}
