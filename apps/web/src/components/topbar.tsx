import { Badge, Button, Input } from '@spectra/ui';
import { Bell, Building2, CircleHelp, FolderKanban, Plus, Search, UserRound } from 'lucide-react';
import * as React from 'react';

import { ThemeToggle } from './theme-toggle';

const DOCS_URL = 'https://github.com/sap1739/spectra-content-intelligence-os/tree/main/docs';

/**
 * Top navigation. Selectors and actions that depend on authentication and
 * Phase 2 APIs are rendered disabled with explicit hints — nothing pretends
 * to work.
 */
export function Topbar() {
  return (
    <header className="flex h-14 items-center gap-2 border-b border-border bg-background px-4">
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          disabled
          title="Organization switching arrives with authentication (Phase 2)"
        >
          <Building2 aria-hidden="true" />
          <span className="hidden sm:inline">Organization</span>
        </Button>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled
          title="Workspace switching arrives with authentication (Phase 2)"
        >
          <FolderKanban aria-hidden="true" />
          <span className="hidden sm:inline">Workspace</span>
        </Button>
      </div>

      <div className="relative ml-2 hidden max-w-md flex-1 md:block">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          disabled
          aria-label="Global search (available in Phase 2)"
          title="Global search arrives in Phase 2"
          placeholder="Search research, trends, content…"
          className="pl-8"
        />
      </div>

      <div className="ml-auto flex items-center gap-1">
        <Badge variant="muted" className="hidden lg:inline-flex">
          Phase 1 foundation
        </Badge>
        <Button size="sm" disabled title="Creation flows arrive in Phase 3">
          <Plus aria-hidden="true" />
          <span className="hidden sm:inline">Create</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled
          aria-label="Notifications (none yet)"
          title="No notifications — notification centre arrives in Phase 2"
        >
          <Bell aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Help and documentation" asChild={false}>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Open documentation in a new tab"
            className="flex items-center justify-center"
          >
            <CircleHelp aria-hidden="true" />
          </a>
        </Button>
        <ThemeToggle />
        <Button
          variant="ghost"
          size="icon"
          disabled
          aria-label="User menu (available after authentication in Phase 2)"
          title="Sign-in arrives in Phase 2"
        >
          <UserRound aria-hidden="true" />
        </Button>
      </div>
    </header>
  );
}
