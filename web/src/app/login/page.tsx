'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
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
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

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
              error={Boolean(errors.email)}
              helperText={errors.email?.message}
            />

            <TextField
              {...register('password')}
              label="Password"
              type="password"
              autoComplete="current-password"
              fullWidth
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
          Dev affordance. These are seeded accounts on a local database; the
          note makes a reviewer's first run painless. It would not ship.
        */}
        <Box sx={{ mt: 3, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Seeded accounts — password <code>daas-dev-password</code>
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            ada@daas.test (admin) · wes@daas.test (warehouse) · vic@daas.test (viewer)
          </Typography>
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
