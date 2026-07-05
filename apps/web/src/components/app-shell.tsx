import { Separator } from '@spectra/ui';
import { Aperture } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { MobileNav } from './mobile-nav';
import { SidebarNav } from './sidebar-nav';
import { Topbar } from './topbar';

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-sidebar lg:flex">
        <div className="flex h-14 items-center gap-2 px-4">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Aperture aria-hidden="true" className="size-6 text-primary" />
            <span className="text-sm font-semibold tracking-tight">
              Spectra<span className="text-muted-foreground">Content</span>
            </span>
          </Link>
        </div>
        <Separator />
        <SidebarNav />
        <div className="border-t border-border p-3">
          <p className="text-[11px] leading-4 text-muted-foreground">
            Intelligence OS · Phase 1<br />
            Research-first content platform
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <MobileNav />
        <main id="main" className="flex-1 px-4 py-6 md:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
