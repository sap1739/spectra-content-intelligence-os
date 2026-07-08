'use client';

import { ROLES } from '@spectra/contracts';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  Skeleton,
} from '@spectra/ui';
import { Copy, Users, X } from 'lucide-react';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { useWorkspace } from '@/lib/auth';
import { useInvitations, useInvite, useMembers, useRevokeInvitation } from '@/lib/team';

export default function TeamPage() {
  const { me, activeWorkspace } = useWorkspace();
  const organizationId = activeWorkspace.organizationId;
  const membership = me.memberships.find((m) => m.organizationId === organizationId);
  const canManage = membership?.role === 'ORG_OWNER' || membership?.role === 'ORG_ADMIN';

  const members = useMembers(organizationId);
  const invitations = useInvitations(organizationId, canManage);
  const invite = useInvite(organizationId);
  const revoke = useRevokeInvitation(organizationId);

  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState('RESEARCHER');
  const [copied, setCopied] = React.useState<string | null>(null);

  const registerLink =
    typeof window === 'undefined' ? '/register' : `${window.location.origin}/register`;

  const submitInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email.trim()) return;
    await invite.mutateAsync({ email: email.trim(), role: role as (typeof ROLES)[number] });
    setEmail('');
  };

  const copyLink = async (invitationEmail: string) => {
    await navigator.clipboard.writeText(
      `${registerLink}?email=${encodeURIComponent(invitationEmail)}`,
    );
    setCopied(invitationEmail);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <>
      <PageHeader
        title="Team"
        description={`Members of ${membership?.organizationName ?? 'your organization'} — roles are permission bundles, checked per action.`}
      />

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Members</CardTitle>
          </CardHeader>
          <CardContent>
            {members.isPending ? (
              <Skeleton className="h-24 w-full" />
            ) : members.isError ? (
              <EmptyState
                icon={<Users />}
                title="Could not load members"
                description={members.error.message}
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {(members.data ?? []).map((member) => (
                  <li
                    key={member.membershipId}
                    className="flex items-center justify-between gap-2 rounded-md border border-border p-3"
                  >
                    <div>
                      <p className="text-sm font-medium">{member.user.name}</p>
                      <p className="text-xs text-muted-foreground">{member.user.email}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{member.role}</Badge>
                      <Badge variant={member.status === 'ACTIVE' ? 'success' : 'muted'}>
                        {member.status}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          {canManage ? (
            <Card>
              <CardHeader>
                <CardTitle>Invite a teammate</CardTitle>
                <p className="text-xs text-muted-foreground">
                  No email is sent yet (SMTP arrives later) — share the sign-up link; creating an
                  account with the invited email joins this organization automatically.
                </p>
              </CardHeader>
              <CardContent>
                <form onSubmit={submitInvite} className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="invite-email">Email</Label>
                    <Input
                      id="invite-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="teammate@company.com"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="invite-role">Role</Label>
                    <select
                      id="invite-role"
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      className="h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {ROLES.filter((r) => r !== 'ORG_OWNER').map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>
                  {invite.isError ? (
                    <p role="alert" className="text-xs text-destructive">
                      {invite.error.message}
                    </p>
                  ) : null}
                  <Button type="submit" disabled={invite.isPending || !email.trim()}>
                    {invite.isPending ? 'Inviting…' : 'Create invitation'}
                  </Button>
                </form>
              </CardContent>
            </Card>
          ) : null}

          {canManage ? (
            <Card>
              <CardHeader>
                <CardTitle>Pending invitations</CardTitle>
              </CardHeader>
              <CardContent>
                {invitations.isPending ? (
                  <Skeleton className="h-16 w-full" />
                ) : (invitations.data ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No pending invitations.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {(invitations.data ?? []).map((inv) => (
                      <li
                        key={inv.id}
                        className="flex items-center justify-between gap-2 rounded-md border border-border p-3"
                      >
                        <div>
                          <p className="text-sm">{inv.email}</p>
                          <p className="text-xs text-muted-foreground">
                            {inv.role} · expires {new Date(inv.expiresAt).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => copyLink(inv.email)}
                            aria-label={`Copy sign-up link for ${inv.email}`}
                          >
                            <Copy aria-hidden="true" />
                            {copied === inv.email ? 'Copied!' : 'Copy link'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Revoke invitation for ${inv.email}`}
                            disabled={revoke.isPending}
                            onClick={() => revoke.mutate(inv.id)}
                          >
                            <X aria-hidden="true" />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Invitations</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Only organization owners and admins can invite members.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
