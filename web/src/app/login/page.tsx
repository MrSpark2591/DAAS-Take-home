'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { asApiError, useLoginMutation } from '@/lib/api';
import { useAppSelector } from '@/lib/hooks';

const schema = z.object({
  email: z.string().trim().min(1, 'Enter your email.').email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

type FormValues = z.infer<typeof schema>;

const SEED_PASSWORD = 'daas-dev-password';

/**
 * Mirrors `api/prisma/seed.ts`. Two organisations rather than one, because the
 * interesting thing to try first is signing in as each and seeing that they get
 * different data -- and that Northgate has no stock navigation at all.
 */
const SEEDED_TENANTS = [
  {
    name: 'Riverside AV',
    stockVisible: true,
    users: [
      { email: 'ada@daas.test', role: 'admin' },
      { email: 'wes@daas.test', role: 'warehouse' },
      { email: 'vic@daas.test', role: 'viewer' },
    ],
  },
  {
    name: 'Northgate Integration',
    stockVisible: false,
    users: [{ email: 'nina@northgate.test', role: 'admin' }],
  },
];

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const status = useAppSelector((state) => state.session.status);
  const [login, loginState] = useLoginMutation();

  // Where the guard bounced them from, so they land back where they were going.
  const next = searchParams.get('next') || '/purchase-orders';

  // Covers arriving at /login with a session already valid, and the moment
  // after a successful sign-in.
  useEffect(() => {
    if (status === 'authenticated') router.replace(next);
  }, [status, next, router]);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  /** Fills the form from a seeded account, so trying each one is one click. */
  const fillCredentials = (email: string) => {
    setValue('email', email, { shouldValidate: true });
    setValue('password', SEED_PASSWORD, { shouldValidate: true });
  };

  /**
   * MUI decides whether to float the label from its own state, which never sees
   * a value set through `setValue` -- the label then sits on top of the text.
   * Forcing shrink when there is a value fixes that; `undefined` hands the
   * decision back to MUI so focus behaviour on an empty field is unchanged.
   */
  const shrinkIfFilled = (value: string | undefined) => (value ? { shrink: true } : undefined);
  const [emailValue, passwordValue] = [watch('email'), watch('password')];

  const onSubmit = handleSubmit(async (values) => {
    try {
      await login({ input: values }).unwrap();
      router.replace(next);
    } catch {
      // Surfaced from loginState.error below.
    }
  });

  const error = asApiError(loginState.error);

  return (
    <Box
      sx={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        bgcolor: 'background.default',
        p: 2,
      }}
    >
      <Paper sx={{ p: 4, width: '100%', maxWidth: 420 }}>
        <Typography variant="h1" sx={{ mb: 0.5 }}>
          DaaS
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Sign in to manage purchase orders and stock.
        </Typography>

        <Box component="form" onSubmit={onSubmit} noValidate>
          <Stack spacing={2}>
            {error ? <Alert severity="error">{error.message}</Alert> : null}

            <TextField
              {...register('email')}
              label="Email"
              type="email"
              autoComplete="username"
              fullWidth
              autoFocus
              slotProps={{ inputLabel: shrinkIfFilled(emailValue) }}
              error={Boolean(errors.email)}
              helperText={errors.email?.message}
            />

            <TextField
              {...register('password')}
              label="Password"
              type="password"
              autoComplete="current-password"
              fullWidth
              slotProps={{ inputLabel: shrinkIfFilled(passwordValue) }}
              error={Boolean(errors.password)}
              helperText={errors.password?.message}
            />

            <Button
              type="submit"
              variant="contained"
              size="large"
              disabled={isSubmitting || loginState.isLoading}
            >
              {loginState.isLoading ? 'Signing in…' : 'Sign in'}
            </Button>
          </Stack>
        </Box>

        {/*
          Dev affordance. These are seeded accounts on a local database, and the
          note makes a reviewer's first run painless -- including showing that
          the two organisations see different data. It would not ship.
        */}
        <Box sx={{ mt: 3, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            Seeded accounts — password <code>daas-dev-password</code>. Click one to fill the form.
          </Typography>

          {SEEDED_TENANTS.map((tenant) => (
            <Box key={tenant.name} sx={{ mb: 1.5 }}>
              <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.5 }}>
                <Typography variant="caption" sx={{ fontWeight: 600 }}>
                  {tenant.name}
                </Typography>
                <Chip
                  size="small"
                  label={tenant.stockVisible ? 'stock on' : 'stock off'}
                  variant="outlined"
                  sx={{ height: 18, fontSize: 10 }}
                />
              </Stack>

              <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                {tenant.users.map((user) => (
                  <Chip
                    key={user.email}
                    size="small"
                    label={`${user.email} · ${user.role}`}
                    onClick={() => fillCredentials(user.email)}
                    sx={{ fontSize: 11 }}
                  />
                ))}
              </Stack>
            </Box>
          ))}
        </Box>
      </Paper>
    </Box>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary to keep the route prerenderable.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
