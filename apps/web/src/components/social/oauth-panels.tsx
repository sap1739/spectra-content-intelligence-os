'use client';

import { Badge, Button, Card, CardContent, CardHeader, CardTitle, cn } from '@spectra/ui';
import { CircleCheck, KeyRound, TriangleAlert, X } from 'lucide-react';
import * as React from 'react';

import { describeExpiry, type OAuthResultMessage } from '@/lib/oauth-results';

import { AccountCapabilityBadges, LinkedInSetupGuide } from './capabilities';
import type { OAuthPlatformEntry, OAuthPlatformsResponse, SocialConnectionRow } from '@/lib/social';

/**
 * OAuth connection panels (Phase 6C, ADR-0034). Presentational: data in,
 * callbacks out, so every state — unconfigured, storage off, approval needed,
 * connected, expired — can be rendered and tested without a network.
 */

type BadgeVariant = 'success' | 'warning' | 'muted' | 'destructive';

const CONNECTION_STATUS: Record<
  SocialConnectionRow['status'],
  { label: string; variant: BadgeVariant }
> = {
  CONNECTED: { label: 'connected', variant: 'success' },
  EXPIRED: { label: 'token expired', variant: 'warning' },
  REAUTH_REQUIRED: { label: 'reconnect required', variant: 'destructive' },
  REVOKED: { label: 'revoked', variant: 'muted' },
  ERROR: { label: 'error', variant: 'destructive' },
};

export function OAuthResultBanner({
  message,
  platformName,
  onDismiss,
}: {
  message: OAuthResultMessage;
  platformName: string | null;
  onDismiss?: () => void;
}) {
  const success = message.tone === 'success';
  return (
    <div
      role={success ? 'status' : 'alert'}
      className={cn(
        'mb-6 flex items-start gap-3 rounded-lg border p-4 text-sm',
        success
          ? 'border-emerald-500/40 bg-emerald-500/5'
          : 'border-destructive/40 bg-destructive/5',
      )}
    >
      {success ? (
        <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-emerald-600" />
      ) : (
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-destructive" />
      )}
      <div className="flex-1">
        <p className="font-medium">
          {message.title}
          {platformName ? ` — ${platformName}` : ''}
        </p>
        <p className="text-muted-foreground">{message.description}</p>
      </div>
      {onDismiss ? (
        <Button variant="ghost" size="icon" aria-label="Dismiss" onClick={onDismiss}>
          <X aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

function PlatformCard({
  entry,
  storageConfigured,
  canManage,
  pending,
  onConnect,
}: {
  entry: OAuthPlatformEntry;
  storageConfigured: boolean;
  canManage: boolean;
  pending: boolean;
  onConnect: (platform: string) => void;
}) {
  const state: { label: string; variant: BadgeVariant } = !entry.configured
    ? { label: 'not configured', variant: 'muted' }
    : !storageConfigured
      ? { label: 'storage off', variant: 'warning' }
      : { label: 'ready to connect', variant: 'success' };

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{entry.displayName}</span>
        <Badge variant={state.variant}>{state.label}</Badge>
      </div>

      {!entry.configured ? (
        <p className="text-xs text-muted-foreground">
          Not configured in this deployment. Set{' '}
          {entry.missingConfiguration.map((key, index) => (
            <React.Fragment key={key}>
              {index > 0 ? ', ' : ''}
              <code className="rounded bg-muted px-1">{key}</code>
            </React.Fragment>
          ))}
          .
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">{entry.limitation}</p>

      {entry.approval.required ? (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium text-amber-700 dark:text-amber-400">
            Platform approval required
          </summary>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
            {entry.approval.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {entry.redirectUri ? (
        <p className="break-all text-[11px] text-muted-foreground">
          Redirect URI to register: <code>{entry.redirectUri}</code>
        </p>
      ) : null}

      {entry.platform === 'LINKEDIN' ? (
        <LinkedInSetupGuide redirectUri={entry.redirectUri} />
      ) : null}

      {canManage ? (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          disabled={!entry.canConnect || pending}
          onClick={() => onConnect(entry.platform)}
        >
          {pending ? 'Redirecting…' : `Connect ${entry.displayName}`}
        </Button>
      ) : null}
    </li>
  );
}

export function ConnectPlatforms({
  data,
  canManage,
  pendingPlatform,
  onConnect,
  error,
}: {
  data: OAuthPlatformsResponse;
  canManage: boolean;
  pendingPlatform: string | null;
  onConnect: (platform: string) => void;
  error: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect a platform</CardTitle>
        <p className="text-xs text-muted-foreground">
          A connection stores the platform&rsquo;s authorization, sealed. Endpoints come from each
          platform&rsquo;s public documentation (recorded {data.definitionsRecordedAt}) and are not
          verified live.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!data.credentialStorageConfigured ? (
          <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
            <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <span>
              Credential storage is off — set{' '}
              <code className="rounded bg-muted px-1">SOCIAL_TOKEN_ENCRYPTION_KEY</code>. Connecting
              is refused until tokens can be stored sealed.
            </span>
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <ul className="grid gap-3 md:grid-cols-2">
          {data.platforms.map((entry) => (
            <PlatformCard
              key={entry.platform}
              entry={entry}
              storageConfigured={data.credentialStorageConfigured}
              canManage={canManage}
              pending={pendingPlatform === entry.platform}
              onConnect={onConnect}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ConnectionItem({
  connection,
  canManage,
  busy,
  onRefresh,
  onReconnect,
  onDisconnect,
}: {
  connection: SocialConnectionRow;
  canManage: boolean;
  busy: boolean;
  onRefresh: (id: string) => void;
  onReconnect: (id: string) => void;
  onDisconnect: (id: string) => void;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const missingProducts = (connection.permissions ?? []).filter((p) => p.status === 'MISSING');
  const status = CONNECTION_STATUS[connection.status] ?? {
    label: connection.status.toLowerCase(),
    variant: 'muted' as const,
  };

  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {connection.label}{' '}
            <span className="text-xs font-normal text-muted-foreground">
              {connection.platformDisplayName}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {describeExpiry(connection.accessTokenExpiresAt)}
          </p>
        </div>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>

      <dl className="mt-2 grid gap-1 text-xs">
        <div className="flex flex-wrap gap-1">
          <dt className="text-muted-foreground">Granted scopes:</dt>
          <dd>
            {connection.grantedScopes === null
              ? 'not reported by the platform'
              : connection.grantedScopes.length > 0
                ? connection.grantedScopes.join(', ')
                : 'none'}
          </dd>
        </div>
        <div className="flex flex-wrap gap-1">
          <dt className="text-muted-foreground">Accounts:</dt>
          <dd>{connection.discovery.note}</dd>
        </div>
        <div className="flex flex-wrap gap-1">
          <dt className="text-muted-foreground">Publishing:</dt>
          <dd>{connection.publishing.note}</dd>
        </div>
      </dl>

      {missingProducts.length > 0 ? (
        <div
          role="note"
          className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs"
        >
          <p className="font-medium">Missing {connection.platformDisplayName} products</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {missingProducts.map((product) => (
              <li key={product.id}>
                <span className="font-medium">{product.name}</span>
                {product.reviewRequired ? ' (reviewed by the platform)' : ''} — {product.enables}{' '}
                {product.anyOf ? 'Needs one of' : 'Needs'} {product.missingScopes.join(', ')}.
              </li>
            ))}
          </ul>
          <p className="mt-1 text-muted-foreground">Add the product to the app, then reconnect.</p>
        </div>
      ) : null}

      {connection.accounts.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-2 text-xs">
          {connection.accounts.map((account) => (
            <li key={account.id} className="rounded border border-border/60 p-2">
              <p>
                {account.displayName}{' '}
                <span className="text-muted-foreground">
                  {account.kind === 'PAGE' ? 'page' : account.kind.toLowerCase()} ·{' '}
                  {account.externalAccountId}
                </span>
              </p>
              <div className="mt-1">
                <AccountCapabilityBadges value={account.capabilities} />
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {canManage ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {connection.refresh.available ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onRefresh(connection.id)}
            >
              Refresh token
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onReconnect(connection.id)}
          >
            Reconnect
          </Button>
          {confirming ? (
            <>
              <span className="text-xs">Disconnect and delete the stored credential?</span>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  onDisconnect(connection.id);
                }}
              >
                Confirm disconnect
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              Disconnect
            </Button>
          )}
        </div>
      ) : null}
      {canManage && !connection.refresh.available ? (
        <p className="mt-1 text-[11px] text-muted-foreground">{connection.refresh.reason}</p>
      ) : null}
    </li>
  );
}

export function ConnectionsList({
  connections,
  canManage,
  busyId,
  onRefresh,
  onReconnect,
  onDisconnect,
  feedback,
}: {
  connections: SocialConnectionRow[];
  canManage: boolean;
  busyId: string | null;
  onRefresh: (id: string) => void;
  onReconnect: (id: string) => void;
  onDisconnect: (id: string) => void;
  feedback: { tone: 'success' | 'error'; text: string } | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connections</CardTitle>
        <p className="text-xs text-muted-foreground">
          Authorizations granted by a platform. Tokens are sealed (AES-256-GCM) and never shown or
          logged.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {feedback ? (
          <p
            role={feedback.tone === 'error' ? 'alert' : 'status'}
            className={cn(
              'text-xs',
              feedback.tone === 'error'
                ? 'text-destructive'
                : 'text-emerald-600 dark:text-emerald-400',
            )}
          >
            {feedback.text}
          </p>
        ) : null}
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No platform connected yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {connections.map((connection) => (
              <ConnectionItem
                key={connection.id}
                connection={connection}
                canManage={canManage}
                busy={busyId === connection.id}
                onRefresh={onRefresh}
                onReconnect={onReconnect}
                onDisconnect={onDisconnect}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
