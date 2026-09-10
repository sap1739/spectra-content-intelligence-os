'use client';

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  cn,
} from '@spectra/ui';
import { Info, Lock } from 'lucide-react';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { usePermissions, useWorkspace } from '@/lib/auth';
import {
  COMMON_TIMEZONES,
  useUpdateOrganization,
  useUpdatePreferences,
  useUpdateWorkspace,
} from '@/lib/settings';

const fieldClass = cn(
  'w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm shadow-sm',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
);

function SavedNote({ show }: { show: boolean }) {
  return show ? (
    <p role="status" className="text-xs text-emerald-600 dark:text-emerald-400">
      Saved.
    </p>
  ) : null;
}

function ReadOnlyNotice({ permission }: { permission: string }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Lock aria-hidden="true" className="size-3.5 shrink-0" />
      Read-only — editing requires <code className="rounded bg-muted px-1">{permission}</code>.
    </p>
  );
}

function OrganizationSettings() {
  const { me, activeWorkspace } = useWorkspace();
  const { can } = usePermissions();
  const canManage = can('org:manage');
  const organizationId = activeWorkspace.organizationId;
  const membership = me.memberships.find((m) => m.organizationId === organizationId);

  const update = useUpdateOrganization(organizationId);
  const [name, setName] = React.useState(membership?.organizationName ?? '');
  const [saved, setSaved] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaved(false);
    if (!name.trim()) return;
    await update.mutateAsync({ name: name.trim() });
    setSaved(true);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Organization</CardTitle>
        <p className="text-xs text-muted-foreground">
          The tenant every workspace, source and credential belongs to.
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-name">Name</Label>
            <Input
              id="org-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canManage}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-slug">Slug</Label>
            <Input id="org-slug" value={membership?.organizationSlug ?? ''} readOnly disabled />
            <p className="text-xs text-muted-foreground">
              Slugs are permanent — they appear in stored object-storage keys.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-role">Your role</Label>
            <p id="org-role" className="text-sm">
              <Badge variant="secondary">{membership?.role ?? 'unknown'}</Badge>
              <span className="ml-2 text-xs text-muted-foreground">
                {membership?.effectivePermissions.length ?? 0} permission(s) — every action is
                checked against these, not the role label.
              </span>
            </p>
          </div>

          {update.isError ? (
            <p role="alert" className="text-xs text-destructive">
              {update.error.message}
            </p>
          ) : null}
          <SavedNote show={saved && !update.isError} />

          {canManage ? (
            <div>
              <Button type="submit" disabled={update.isPending || !name.trim()}>
                {update.isPending ? 'Saving…' : 'Save organization'}
              </Button>
            </div>
          ) : (
            <ReadOnlyNotice permission="org:manage" />
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function WorkspaceSettings() {
  const { activeWorkspace } = useWorkspace();
  const { can } = usePermissions();
  const canManage = can('workspace:manage');
  const update = useUpdateWorkspace(activeWorkspace.id);

  const [name, setName] = React.useState(activeWorkspace.name);
  const [timezone, setTimezone] = React.useState(activeWorkspace.timezone ?? 'UTC');
  const [saved, setSaved] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaved(false);
    if (!name.trim()) return;
    await update.mutateAsync({ name: name.trim(), timezone });
    setSaved(true);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace</CardTitle>
        <p className="text-xs text-muted-foreground">
          Research, content, budgets and publishing targets are all scoped to a workspace.
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ws-name">Name</Label>
            <Input
              id="ws-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canManage}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ws-timezone">Display timezone</Label>
            <select
              id="ws-timezone"
              className={fieldClass}
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              disabled={!canManage}
            >
              {/* Include the stored value even if it is outside the short list,
                  so an existing setting is never silently replaced. */}
              {[...new Set([timezone, ...COMMON_TIMEZONES])].map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Affects how calendar and publication times are DISPLAYED. Every timestamp is stored in
              UTC and never converted on write.
            </p>
          </div>

          {update.isError ? (
            <p role="alert" className="text-xs text-destructive">
              {update.error.message}
            </p>
          ) : null}
          <SavedNote show={saved && !update.isError} />

          {canManage ? (
            <div>
              <Button type="submit" disabled={update.isPending || !name.trim()}>
                {update.isPending ? 'Saving…' : 'Save workspace'}
              </Button>
            </div>
          ) : (
            <ReadOnlyNotice permission="workspace:manage" />
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function UserPreferences() {
  const { me } = useWorkspace();
  const update = useUpdatePreferences();
  const [name, setName] = React.useState(me.user.name);
  const [timezone, setTimezone] = React.useState(me.user.timezone);
  const [saved, setSaved] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaved(false);
    if (!name.trim()) return;
    await update.mutateAsync({ name: name.trim(), timezone });
    setSaved(true);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your preferences</CardTitle>
        <p className="text-xs text-muted-foreground">
          Applies to your account only, in every workspace.
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="me-email">Email</Label>
            <Input id="me-email" value={me.user.email} readOnly disabled />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="me-name">Display name</Label>
            <Input id="me-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="me-timezone">Your timezone</Label>
            <select
              id="me-timezone"
              className={fieldClass}
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            >
              {[...new Set([timezone, ...COMMON_TIMEZONES])].map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>

          {update.isError ? (
            <p role="alert" className="text-xs text-destructive">
              {update.error.message}
            </p>
          ) : null}
          <SavedNote show={saved && !update.isError} />

          <div>
            <Button type="submit" disabled={update.isPending || !name.trim()}>
              {update.isPending ? 'Saving…' : 'Save preferences'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Organization, workspace and personal preferences. Only fields the platform actually stores appear here."
      />

      <Card className="mb-6">
        <CardContent className="flex items-start gap-3 py-4">
          <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="text-sm">
            <p className="font-medium">What is editable here</p>
            <p className="text-muted-foreground">
              Organization name, workspace name and display timezone, and your own name and
              timezone. Slugs are permanent because they appear in stored object-storage keys. There
              is no organization-wide timezone: the platform does not store one, and showing a
              control that silently does nothing would be worse than its absence. Budgets live on{' '}
              <span className="font-medium">Usage</span>; members and invitations on{' '}
              <span className="font-medium">Team</span>.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <OrganizationSettings />
        <WorkspaceSettings />
        <UserPreferences />
      </div>
    </>
  );
}
