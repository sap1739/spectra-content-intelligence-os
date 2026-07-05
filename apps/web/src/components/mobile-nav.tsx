'use client';

import { cn } from '@spectra/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { ALL_NAV_ITEMS } from '@/lib/nav';

/** Horizontal nav strip for small screens; the sidebar covers lg and above. */
export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary (mobile)"
      className="flex gap-1 overflow-x-auto border-b border-border px-3 py-2 lg:hidden"
    >
      {ALL_NAV_ITEMS.map((item) => {
        const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'shrink-0 rounded-full px-3 py-1 text-xs transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
