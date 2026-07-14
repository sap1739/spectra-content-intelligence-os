'use client';

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
  cn,
} from '@spectra/ui';
import { CircleCheck, Share2, TriangleAlert, X } from 'lucide-react';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { useWorkspace } from '@/lib/auth';
import {
  useDisconnectSocialAccount,
  usePlatforms,
  useRegisterSocialAccount,
  useSocialAccounts,
  useValidateVariant,
  type PlatformCapability,
} from '@/lib/social';

const PLATFORMS = [
  'LINKEDIN',
  'INSTAGRAM',
  'FACEBOOK',
  'YOUTUBE',
  'TIKTOK',
  'THREADS',
  'X',
  'PINTEREST',
  'WORDPRESS',
  'EMAIL',
] as const;

const KINDS = ['PROFILE', 'PAGE', 'CHANNEL', 'BUSINESS_ACCOUNT', 'SITE'] as const;

const fieldClass = cn(
  'w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm shadow-sm',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
);

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'muted' | 'destructive'> = {
  CONNECTED: 'success',
  PENDING: 'warning',
  EXPIRED: 'muted',
  REVOKED: 'muted',
  ERROR: 'destructive',
};

function limitText(cap: PlatformCapability): string {
  const parts: string[] = [];
  if (cap.limits.maxCharacters != null) parts.push(`${cap.limits.maxCharacters} chars`);
  if (cap.limits.maxMediaPerPost != null) parts.push(`${cap.limits.maxMediaPerPost} media`);
  if (cap.limits.maxHashtags != null) parts.push(`${cap.limits.maxHashtags} hashtags`);
  return parts.length ? parts.join(' · ') : 'no declared limits';
}

/** Compact validator: paste text, pick a platform, see if it fits. */
function VariantValidator({ workspaceId }: { workspaceId: string }) {
  const validate = useValidateVariant(workspaceId);
  const [platform, setPlatform] = React.useState<string>('X');
  const [text, setText] = React.useState('');

  return (
    <Card>
      <CardHeader>
        <CardTitle>Content fit check</CardTitle>
        <p className="text-xs text-muted-foreground">
          Validate copy against a platform’s declared limits. Real, deterministic — no platform
          connection required.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex gap-2">
          <select
            aria-label="Platform"
            className={cn(fieldClass, 'max-w-40')}
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          >
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            disabled={validate.isPending}
            onClick={() => validate.mutate({ platform: platform as never, text })}
          >
            {validate.isPending ? 'Checking…' : 'Check'}
          </Button>
        </div>
        <textarea
          className={cn(fieldClass, 'min-h-20 resize-y')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste post copy…"
        />
        {validate.data ? (
          validate.data.ok ? (
            <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
              <CircleCheck aria-hidden="true" className="size-4" /> Fits {validate.data.platform}.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {validate.data.issues.map((issue) => (
                <li key={issue.code} className="text-sm text-destructive">
                  {issue.message}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function SocialAccountsPage() {
  const { me, activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;
  const membership = me.memberships.find(
    (m) => m.organizationId === activeWorkspace.organizationId,
  );
  const canConnect =
    membership?.role === 'ORG_OWNER' ||
    membership?.role === 'ORG_ADMIN' ||
    membership?.role === 'PUBLISHER';

  const platforms = usePlatforms(workspaceId);
  const accounts = useSocialAccounts(workspaceId);
  const register = useRegisterSocialAccount(workspaceId);
  const disconnect = useDisconnectSocialAccount(workspaceId);

  const [platform, setPlatform] = React.useState<string>('LINKEDIN');
  const [displayName, setDisplayName] = React.useState('');
  const [handle, setHandle] = React.useState('');
  const [kind, setKind] = React.useState<string>('PROFILE');

  const credConfigured = platforms.data?.credentialStorageConfigured ?? false;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!displayName.trim() || !handle.trim()) return;
    await register.mutateAsync({
      platform: platform as never,
      displayName: displayName.trim(),
      externalAccountId: handle.trim(),
      kind: kind as never,
      scopes: [],
    });
    setDisplayName('');
    setHandle('');
  };

  return (
    <>
      <PageHeader
        title="Social Accounts"
        description="Register publishing targets and validate content against each platform’s capabilities. Live posting activates when a platform adapter is configured."
      />

      <Card className="mb-6 border-amber-500/40 bg-amber-500/5">
        <CardContent className="flex items-start gap-3 py-4">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-amber-600" />
          <div className="text-sm">
            <p className="font-medium">Live publishing is not wired yet</p>
            <p className="text-muted-foreground">
              No platform adapter is connected, so no post ever goes out from here. You can register
              targets (stored as <span className="font-medium">PENDING</span>) and check content fit
              against real platform limits now; OAuth and posting activate when an adapter is
              configured. Credential storage is{' '}
              {credConfigured ? (
                <span className="font-medium text-emerald-600 dark:text-emerald-400">enabled</span>
              ) : (
                <span className="font-medium">
                  disabled (set SOCIAL_TOKEN_ENCRYPTION_KEY to store tokens)
                </span>
              )}
              .
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        <div className="flex flex-col gap-6">
          {canConnect ? (
            <Card>
              <CardHeader>
                <CardTitle>Register a target</CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={submit} className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sa-platform">Platform</Label>
                    <select
                      id="sa-platform"
                      className={fieldClass}
                      value={platform}
                      onChange={(e) => setPlatform(e.target.value)}
                    >
                      {PLATFORMS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sa-name">Display name</Label>
                    <Input
                      id="sa-name"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Acme on LinkedIn"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sa-handle">Handle / account id / URL</Label>
                    <Input
                      id="sa-handle"
                      value={handle}
                      onChange={(e) => setHandle(e.target.value)}
                      placeholder="@acme or https://…"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sa-kind">Kind</Label>
                    <select
                      id="sa-kind"
                      className={fieldClass}
                      value={kind}
                      onChange={(e) => setKind(e.target.value)}
                    >
                      {KINDS.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </div>
                  {register.isError ? (
                    <p role="alert" className="text-xs text-destructive">
                      {register.error.message}
                    </p>
                  ) : null}
                  <Button type="submit" disabled={register.isPending || !displayName.trim()}>
                    {register.isPending ? 'Registering…' : 'Register target'}
                  </Button>
                </form>
              </CardContent>
            </Card>
          ) : null}

          <VariantValidator workspaceId={workspaceId} />
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Registered targets</CardTitle>
            </CardHeader>
            <CardContent>
              {accounts.isPending ? (
                <Skeleton className="h-20 w-full" />
              ) : accounts.isError ? (
                <EmptyState
                  icon={<Share2 />}
                  title="Could not load accounts"
                  description={accounts.error.message}
                />
              ) : accounts.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No targets registered yet. Add one to plan publishing.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {accounts.data.map((acct) => (
                    <li
                      key={acct.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-border p-3"
                    >
                      <div>
                        <p className="text-sm font-medium">
                          {acct.displayName}{' '}
                          <span className="text-xs font-normal text-muted-foreground">
                            {acct.platform} · {acct.kind}
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground">{acct.externalAccountId}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={STATUS_VARIANT[acct.status] ?? 'muted'}>
                          {acct.status}
                        </Badge>
                        {canConnect ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Disconnect ${acct.displayName}`}
                            disabled={disconnect.isPending}
                            onClick={() => disconnect.mutate(acct.id)}
                          >
                            <X aria-hidden="true" />
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Platform capabilities</CardTitle>
              <p className="text-xs text-muted-foreground">
                Declared reference constraints (not live-fetched). No publisher is wired.
              </p>
            </CardHeader>
            <CardContent>
              {platforms.isPending ? (
                <Skeleton className="h-24 w-full" />
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2">
                  {(platforms.data?.platforms ?? []).map((entry) => (
                    <li
                      key={entry.capability.platform}
                      className="rounded-md border border-border p-2.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{entry.capability.platform}</span>
                        <Badge variant={entry.publisherWired ? 'success' : 'muted'}>
                          {entry.publisherWired ? 'wired' : 'not wired'}
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {limitText(entry.capability)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
