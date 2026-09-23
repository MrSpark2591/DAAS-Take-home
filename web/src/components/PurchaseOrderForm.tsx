'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/Delete';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useRouter } from 'next/navigation';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';
import { asApiError, useCreatePurchaseOrderMutation, useFormOptionsQuery } from '@/lib/api';
import { formatCents } from '@/lib/format';
import { QueryState } from './QueryState';

/**
 * The form's schema is about what a human types: cost is entered in dollars,
 * because nobody types cents. It is converted to integer cents at the edge, on
 * submit, so the rest of the system only ever sees integers.
 */
const lineSchema = z.object({
  productId: z.string().min(1, 'Choose a product.'),
  quantityOrdered: z.coerce
    .number({ invalid_type_error: 'Enter a quantity.' })
    .int('Whole units only.')
    .positive('Must be at least 1.'),
  unitCostDollars: z.coerce
    .number({ invalid_type_error: 'Enter a unit cost.' })
    .min(0, 'Cannot be negative.'),
});

const formSchema = z
  .object({
    poNumber: z
      .string()
      .trim()
      .min(1, 'PO number is required.')
      .max(32, 'Keep it under 32 characters.'),
    vendorId: z.string().min(1, 'Choose a vendor.'),
    locationId: z.string().min(1, 'Choose a receiving location.'),
    notes: z.string().trim().max(2000, 'Keep notes under 2000 characters.').optional(),
    lines: z.array(lineSchema).min(1, 'A purchase order needs at least one line.'),
  })
  // Mirrors the partial unique index on (purchase_order_id, product_id): the
  // API would reject this anyway, but catching it here points at the row.
  .superRefine((value, ctx) => {
    const seen = new Map<string, number>();
    value.lines.forEach((line, index) => {
      const first = seen.get(line.productId);
      if (line.productId && first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', index, 'productId'],
          message: `Already on line ${first + 1}. Combine them instead.`,
        });
      } else if (line.productId) {
        seen.set(line.productId, index);
      }
    });
  });

type FormValues = z.input<typeof formSchema>;
type ParsedValues = z.output<typeof formSchema>;

const EMPTY_LINE = { productId: '', quantityOrdered: 1, unitCostDollars: 0 };

export function PurchaseOrderForm() {
  const router = useRouter();
  const options = useFormOptionsQuery();
  const [createPurchaseOrder, createState] = useCreatePurchaseOrderMutation();

  const {
    control,
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, ParsedValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      poNumber: '',
      vendorId: '',
      locationId: '',
      notes: '',
      lines: [{ ...EMPTY_LINE }],
    },
    mode: 'onBlur',
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const watchedLines = watch('lines');

  const estimatedTotalCents = (watchedLines ?? []).reduce((sum, line) => {
    const qty = Number(line?.quantityOrdered) || 0;
    const dollars = Number(line?.unitCostDollars) || 0;
    return sum + Math.round(dollars * 100) * qty;
  }, 0);

  const onSubmit = handleSubmit(async (values) => {
    try {
      const result = await createPurchaseOrder({
        input: {
          poNumber: values.poNumber,
          vendorId: values.vendorId,
          locationId: values.locationId,
          notes: values.notes || null,
          lines: values.lines.map((line) => ({
            productId: line.productId,
            quantityOrdered: line.quantityOrdered,
            unitCostCents: Math.round(line.unitCostDollars * 100),
          })),
        },
      }).unwrap();

      router.push(`/purchase-orders/${result.createPurchaseOrder.id}`);
    } catch (error) {
      // A duplicate PO number is a field problem, not a page problem, so it is
      // attached to the input rather than shown as a banner.
      const apiError = asApiError(error);
      if (apiError?.code === 'CONFLICT' && apiError.extensions.field === 'poNumber') {
        setError('poNumber', { message: apiError.message });
      }
    }
  });

  const submitError = asApiError(createState.error);
  const showBanner =
    submitError &&
    !(submitError.code === 'CONFLICT' && submitError.extensions.field === 'poNumber');

  return (
    <QueryState
      isLoading={options.isLoading}
      error={options.error}
      onRetry={options.refetch}
      skeletonRows={5}
    >
      <Box component="form" onSubmit={onSubmit} noValidate>
        {showBanner ? (
          <Alert severity={submitError.code === 'FORBIDDEN' ? 'warning' : 'error'} sx={{ mb: 3 }}>
            {submitError.message}
          </Alert>
        ) : null}

        <Paper sx={{ p: 3, mb: 3 }}>
          <Typography variant="h3" gutterBottom>
            Order details
          </Typography>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 4 }}>
              <TextField
                {...register('poNumber')}
                label="PO number"
                fullWidth
                required
                placeholder="PO-1005"
                error={Boolean(errors.poNumber)}
                helperText={errors.poNumber?.message}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 4 }}>
              <Controller
                control={control}
                name="vendorId"
                render={({ field }) => (
                  <TextField
                    {...field}
                    select
                    label="Vendor"
                    fullWidth
                    required
                    error={Boolean(errors.vendorId)}
                    helperText={errors.vendorId?.message}
                  >
                    {(options.data?.vendors ?? []).map((vendor) => (
                      <MenuItem key={vendor.id} value={vendor.id}>
                        {vendor.name}
                      </MenuItem>
                    ))}
                  </TextField>
                )}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 4 }}>
              <Controller
                control={control}
                name="locationId"
                render={({ field }) => (
                  <TextField
                    {...field}
                    select
                    label="Receiving location"
                    fullWidth
                    required
                    error={Boolean(errors.locationId)}
                    helperText={errors.locationId?.message ?? 'Default destination for receipts.'}
                  >
                    {(options.data?.locations ?? []).map((location) => (
                      <MenuItem key={location.id} value={location.id}>
                        {location.code} — {location.name}
                      </MenuItem>
                    ))}
                  </TextField>
                )}
              />
            </Grid>
            <Grid size={12}>
              <TextField
                {...register('notes')}
                label="Notes"
                fullWidth
                multiline
                minRows={2}
                error={Boolean(errors.notes)}
                helperText={errors.notes?.message}
              />
            </Grid>
          </Grid>
        </Paper>

        <Paper sx={{ p: 3, mb: 3 }}>
          <Stack
            direction="row"
            sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 2 }}
          >
            <Typography variant="h3">Lines</Typography>
            <Button startIcon={<AddIcon />} onClick={() => append({ ...EMPTY_LINE })} size="small">
              Add line
            </Button>
          </Stack>

          {errors.lines?.message ? (
            <Alert severity="error" sx={{ mb: 2 }}>
              {errors.lines.message}
            </Alert>
          ) : null}

          <Stack spacing={2} divider={<Divider flexItem />}>
            {fields.map((field, index) => (
              <Grid container spacing={2} key={field.id} sx={{ alignItems: 'flex-start' }}>
                <Grid size={{ xs: 12, sm: 5 }}>
                  <Controller
                    control={control}
                    name={`lines.${index}.productId`}
                    render={({ field: productField }) => (
                      <TextField
                        {...productField}
                        select
                        label={`Product ${index + 1}`}
                        fullWidth
                        required
                        error={Boolean(errors.lines?.[index]?.productId)}
                        helperText={errors.lines?.[index]?.productId?.message}
                      >
                        {(options.data?.products ?? []).map((product) => (
                          <MenuItem key={product.id} value={product.id}>
                            {product.sku} — {product.name}
                          </MenuItem>
                        ))}
                      </TextField>
                    )}
                  />
                </Grid>
                <Grid size={{ xs: 6, sm: 3 }}>
                  <TextField
                    {...register(`lines.${index}.quantityOrdered`)}
                    label="Quantity"
                    type="number"
                    fullWidth
                    required
                    slotProps={{ htmlInput: { min: 1, step: 1 } }}
                    error={Boolean(errors.lines?.[index]?.quantityOrdered)}
                    helperText={errors.lines?.[index]?.quantityOrdered?.message}
                  />
                </Grid>
                <Grid size={{ xs: 6, sm: 3 }}>
                  <TextField
                    {...register(`lines.${index}.unitCostDollars`)}
                    label="Unit cost"
                    type="number"
                    fullWidth
                    required
                    slotProps={{ htmlInput: { min: 0, step: '0.01' } }}
                    error={Boolean(errors.lines?.[index]?.unitCostDollars)}
                    helperText={errors.lines?.[index]?.unitCostDollars?.message ?? 'In dollars.'}
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 1 }}>
                  <IconButton
                    aria-label={`Remove line ${index + 1}`}
                    onClick={() => remove(index)}
                    disabled={fields.length === 1}
                    sx={{ mt: 0.5 }}
                  >
                    <DeleteOutlineIcon />
                  </IconButton>
                </Grid>
              </Grid>
            ))}
          </Stack>
        </Paper>

        <Stack
          direction="row"
          spacing={2}
          sx={{ alignItems: 'center', justifyContent: 'flex-end' }}
        >
          <Typography color="text.secondary">
            Estimated total <strong>{formatCents(estimatedTotalCents)}</strong>
          </Typography>
          <Button
            onClick={() => router.push('/purchase-orders')}
            color="inherit"
            disabled={createState.isLoading}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="contained"
            loading={isSubmitting || createState.isLoading}
            loadingPosition="start"
          >
            {createState.isLoading ? 'Creating…' : 'Create purchase order'}
          </Button>
        </Stack>
      </Box>
    </QueryState>
  );
}
