import { Aperture } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <Link
        href="/"
        className="mb-8 flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Aperture aria-hidden="true" className="size-7 text-primary" />
        <span className="text-lg font-semibold tracking-tight">
          Spectra<span className="text-muted-foreground">Content</span>
        </span>
      </Link>
      <div className="w-full max-w-sm">{children}</div>
      <p className="mt-8 max-w-sm text-center text-xs text-muted-foreground">
        Research-first content intelligence. Local development build — see the README for
        environment setup.
      </p>
    </div>
  );
}
