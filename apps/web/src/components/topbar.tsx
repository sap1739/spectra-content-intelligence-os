'use client';

import { Badge, Button, Input, cn } from '@spectra/ui';
import { Bell, CircleHelp, LogOut, Plus, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { useLogout, useWorkspace } from '@/lib/auth';
import { ThemeToggle } from './theme-toggle';

const DOCS_URL = 'https://github.com/sap1739/spectra-content-intelligence-os/tree/main/docs';

const selectClass = cn(
  'h-8 max-w-44 truncate rounded-md border border-input bg-background px-2 text-sm shadow-sm',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
);

/**
 * Top navigation. Organization/workspace selectors and the user menu are live
 * (Phase 2); actions that depend on later phases stay disabled with explicit
 * hints — nothing pretends to work.
 */
export function Topbar() {
  const router = useRouter();
  const { me, activeWorkspace, setActiveWorkspaceId } = useWorkspace();
  const logout = useLogout();

  const activeOrgId = activeWorkspace.organizationId;
  const orgWorkspaces = me.workspaces.filter((ws) => ws.organizationId === activeOrgId);

  const handleOrgChange = (organizationId: string) => {
    const first = me.workspaces.find((ws) => ws.organizationId === organizationId);
    if (first) setActiveWorkspaceId(first.id);
  };

  const handleLogout = async () => {
    await logout.mutateAsync();
    router.replace('/login');
  };

  return (
    <header className="flex h-14 items-center gap-2 border-b border-border bg-background px-4">
      <div className="flex items-center gap-1.5">
        <label htmlFor="org-select" className="sr-only">
          Organization
        </label>
        <select
          id="org-select"
          className={selectClass}
          value={activeOrgId}
          onChange={(event) => handleOrgChange(event.target.value)}
        >
          {me.memberships.map((m) => (
            <option key={m.organizationId} value={m.organizationId}>
              {m.organizationName}
            </option>
          ))}
        </select>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <label htmlFor="workspace-select" className="sr-only">
          Workspace
        </label>
        <select
          id="workspace-select"
          className={selectClass}
          value={activeWorkspace.id}
          onChange={(event) => setActiveWorkspaceId(event.target.value)}
        >
          {orgWorkspaces.map((ws) => (
            <option key={ws.id} value={ws.id}>
              {ws.name}
            </option>
          ))}
        </select>
      </div>

      <div className="relative ml-2 hidden max-w-md flex-1 md:block">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          disabled
          aria-label="Global search (available in a later increment)"
          title="Global search arrives with the research pipeline"
          placeholder="Search research, trends, content…"
          className="pl-8"
        />
      </div>

      <div className="ml-auto flex items-center gap-1">
        <Badge variant="muted" className="hidden lg:inline-flex">
          Phase 2 · Identity & Research
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
          title="No notifications — notification centre arrives later in Phase 2"
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
        <div className="ml-1 flex items-center gap-2 border-l border-border pl-2">
          <span className="hidden max-w-32 truncate text-xs text-muted-foreground sm:inline">
            {me.user.email}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Sign out"
            title="Sign out"
            disabled={logout.isPending}
            onClick={handleLogout}
          >
            <LogOut aria-hidden="true" />
          </Button>
        </div>
      </div>
    </header>
  );
}
