'use client';

import { Button, EmptyState } from '@spectra/ui';
import { TriangleAlert } from 'lucide-react';
import * as React from 'react';

/**
 * Route-level error boundary. Shows a recoverable error state; details stay
 * in the console/server logs, never fabricated or hidden behind a blank page.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error('Route error boundary caught:', error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <EmptyState
        icon={<TriangleAlert />}
        title="Something went wrong"
        description={
          error.digest
            ? `The error was logged with reference ${error.digest}. You can retry, or come back later.`
            : 'The error was logged. You can retry, or come back later.'
        }
        action={
          <Button onClick={reset} variant="outline">
            Try again
          </Button>
        }
      />
    </div>
  );
}
