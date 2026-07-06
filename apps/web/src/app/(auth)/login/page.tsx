'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginRequestSchema, type LoginRequest } from '@spectra/contracts';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '@spectra/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';

import { useLogin, useMe } from '@/lib/auth';

export default function LoginPage() {
  const router = useRouter();
  const me = useMe();
  const login = useLogin();

  const form = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { email: '', password: '' },
  });

  React.useEffect(() => {
    if (me.isSuccess) router.replace('/');
  }, [me.isSuccess, router]);

  const onSubmit = form.handleSubmit(async (values) => {
    await login.mutateAsync(values);
    router.replace('/');
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sign in</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              aria-invalid={!!form.formState.errors.email}
              aria-describedby={form.formState.errors.email ? 'email-error' : undefined}
              {...form.register('email')}
            />
            {form.formState.errors.email ? (
              <p id="email-error" className="text-xs text-destructive">
                {form.formState.errors.email.message}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              aria-invalid={!!form.formState.errors.password}
              aria-describedby={form.formState.errors.password ? 'password-error' : undefined}
              {...form.register('password')}
            />
            {form.formState.errors.password ? (
              <p id="password-error" className="text-xs text-destructive">
                {form.formState.errors.password.message}
              </p>
            ) : null}
          </div>

          {login.isError ? (
            <p role="alert" className="text-xs text-destructive">
              {login.error.status === 401 ? 'Invalid email or password.' : login.error.message}
            </p>
          ) : null}

          <Button type="submit" disabled={login.isPending} className="mt-1">
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          New to Spectra?{' '}
          <Link
            href="/register"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Create an account
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
