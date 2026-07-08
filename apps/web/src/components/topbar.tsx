'use client';

import { Badge, Button, Input, cn } from '@spectra/ui';
import { Bell, Check, CircleHelp, LogOut, Plus, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { useLogout, useWorkspace } from '@/lib/auth';
import { useAcknowledgeAlert, useAlerts } from '@/lib/knowledge';
import { ThemeToggle } from './theme-toggle';

const DOCS_URL = 'https://github.com/sap1739/spectra-content-intelligence-os/tree/main/docs';

const selectClass = cn(
  'h-8 max-w-44 truncate rounded-md border border-input bg-background px-2 text-sm shadow-sm',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
);

function AlertsBell() {
  const { activeWorkspace } = useWorkspace();
  const alerts = useAlerts(activeWorkspace.id);
  const acknowledge = useAcknowledgeAlert(activeWorkspace.id);
  const [open, setOpen] = React.useState(false);
  const panelRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const count = alerts.data?.length ?? 0;

  return (
    <div className="relative" ref={panelRef}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={count > 0 ? `Notifications: ${count} unacknowledged alerts` : 'Notifications'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative"
      >
        <Bell aria-hidden="true" />
        {count > 0 ? (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
          >
            {count > 9 ? '9+' : count}
          </span>
        ) : null}
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label="Trend alerts"
          className="absolute right-0 top-11 z-50 w-96 rounded-lg border border-border bg-card p-2 shadow-lg"
        >
          <p className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">Trend alerts</p>
          {count === 0 ? (
            <p className="px-2 pb-2 text-sm text-muted-foreground">
              No unacknowledged alerts. Alerts fire when trends change lifecycle state.
            </p>
          ) : (
            <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto">
              {(alerts.data ?? []).map((alert) => (
                <li
                  key={alert.id}
                  className="flex items-start justify-between gap-2 rounded-md p-2 hover:bg-accent/50"
                >
                  <div>
                    <p className="text-xs leading-snug">{alert.message}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {new Date(alert.triggeredAt).toLocaleString()}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Acknowledge alert"
                    disabled={acknowledge.isPending}
                    onClick={() => acknowledge.mutate(alert.id)}
                  >
                    <Check aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Top navigation. Search, notifications, org/workspace switching and sign-out
 * are live; the Create button stays honestly disabled until Phase 3.
 */
export function Topbar() {
  const router = useRouter();
  const { me, activeWorkspace, setActiveWorkspaceId } = useWorkspace();
  const logout = useLogout();
  const [search, setSearch] = React.useState('');

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

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const q = search.trim();
    if (q.length >= 2) router.push(`/intelligence?q=${encodeURIComponent(q)}`);
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

      <form
        onSubmit={submitSearch}
        role="search"
        className="relative ml-2 hidden max-w-md flex-1 md:block"
      >
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search the knowledge base"
          placeholder="Search research knowledge…"
          className="pl-8"
        />
      </form>

      <div className="ml-auto flex items-center gap-1">
        <Badge variant="muted" className="hidden lg:inline-flex">
          Phase 2 · Identity & Research
        </Badge>
        <Button size="sm" disabled title="Creation flows arrive in Phase 3">
          <Plus aria-hidden="true" />
          <span className="hidden sm:inline">Create</span>
        </Button>
        <AlertsBell />
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
