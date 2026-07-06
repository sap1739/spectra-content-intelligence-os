'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { registerRequestSchema, type RegisterRequest } from '@spectra/contracts';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '@spectra/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';

import { useRegister } from '@/lib/auth';

export default function RegisterPage() {
  const router = useRouter();
  const register = useRegister();

  const form = useForm<RegisterRequest>({
    resolver: zodResolver(registerRequestSchema),
    defaultValues: { name: '', email: '', password: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    await register.mutateAsync(values);
    router.replace('/');
  });

  const errors = form.formState.errors;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Create your account</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Your name</Label>
            <Input
              id="name"
              autoComplete="name"
              aria-invalid={!!errors.name}
              {...form.register('name')}
            />
            {errors.name ? <p className="text-xs text-destructive">{errors.name.message}</p> : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              aria-invalid={!!errors.email}
              {...form.register('email')}
            />
            {errors.email ? (
              <p className="text-xs text-destructive">{errors.email.message}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              aria-invalid={!!errors.password}
              aria-describedby="password-hint"
              {...form.register('password')}
            />
            <p id="password-hint" className="text-xs text-muted-foreground">
              At least 12 characters.
            </p>
            {errors.password ? (
              <p className="text-xs text-destructive">{errors.password.message}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="organizationName">Organization name (optional)</Label>
            <Input
              id="organizationName"
              autoComplete="organization"
              placeholder="Defaults to a personal organization"
              {...form.register('organizationName', {
                setValueAs: (v: string) => (v === '' ? undefined : v),
              })}
            />
          </div>

          {register.isError ? (
            <p role="alert" className="text-xs text-destructive">
              {register.error.status === 409
                ? 'An account with this email already exists.'
                : register.error.message}
            </p>
          ) : null}

          <Button type="submit" disabled={register.isPending} className="mt-1">
            {register.isPending ? 'Creating account…' : 'Create account'}
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Already have an account?{' '}
          <Link
            href="/login"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
