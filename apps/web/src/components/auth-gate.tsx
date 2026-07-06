'use client';

import { Skeleton } from '@spectra/ui';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { WorkspaceProvider, useMe } from '@/lib/auth';

/**
 * Client-side session gate for the app shell. The API enforces authentication
 * authoritatively; this only routes signed-out visitors to /login.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const me = useMe();

  React.useEffect(() => {
    if (me.isError) {
      router.replace('/login');
    }
  }, [me.isError, router]);

  if (me.isPending || me.isError) {
    return (
      <div aria-busy="true" className="space-y-4 p-8">
        <span className="sr-only">Checking session…</span>
        <Skeleton className="h-6 w-44" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </div>
    );
  }

  return <WorkspaceProvider me={me.data}>{children}</WorkspaceProvider>;
}
