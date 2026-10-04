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
  Skeleton,
} from '@spectra/ui';
import { ArrowLeft, Lock, ShieldAlert, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { usePermissions, useWorkspace } from '@/lib/auth';
import { CONSENT_STATUS_VARIANT, useRecordConsent, useRevokeConsent, useVoices } from '@/lib/audio';

const SCOPES = [
  'INTERNAL_ONLY',
  'ORGANIC_SOCIAL',
  'PODCAST',
  'MARKETING',
  'PAID_ADVERTISING',
] as const;

/**
 * Consent for one voice: what was agreed, for what uses, until when, and the
 * full history including revocations. Recording consent is a legal act, so it
 * needs `voice:consent` and every change is audit-logged.
 */
export default function VoiceConsentPage() {
  const params = useParams<{ voiceId: string }>();
  const voiceId = params.voiceId;
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;
  const { can } = usePermissions();
  const canConsent = can('voice:consent');

  const voices = useVoices(workspaceId);
  const record = useRecordConsent(workspaceId, voiceId);
  const revoke = useRevokeConsent(workspaceId, voiceId);

  const voice = voices.data?.voices.find((candidate) => candidate.id === voiceId);

  const [subjectName, setSubjectName] = React.useState('');
  const [method, setMethod] = React.useState('SIGNED_RELEASE');
  const [reference, setReference] = React.useState('');
  const [scopes, setScopes] = React.useState<string[]>(['PODCAST']);
  const [expiresAt, setExpiresAt] = React.useState('');

  React.useEffect(() => {
    if (voice?.subjectName && !subjectName) setSubjectName(voice.subjectName);
  }, [voice?.subjectName, subjectName]);

  if (voices.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!voice) {
    return (
      <p role="alert" className="text-sm text-destructive">
        This voice is not in this workspace.
      </p>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!subjectName.trim() || !expiresAt || scopes.length === 0) return;
    await record.mutateAsync({
      subjectName: subjectName.trim(),
      method: method as never,
      reference: reference.trim() || null,
      scopes: scopes as never,
      expiresAt: new Date(expiresAt).toISOString(),
    } as never);
  }

  return (
    <div className="space-y-6">
      <Link
        href="/audio"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft aria-hidden className="size-4" /> Back to audio
      </Link>
      <PageHeader
        title={voice.name}
        description={
          voice.kind === 'CLONED'
            ? `Cloned from ${voice.subjectName ?? 'an unnamed person'}`
            : 'This voice imitates nobody, so no consent is required.'
        }
      />

      <Card>
        <CardContent className="flex items-start gap-3 pt-6 text-sm" data-testid="consent-status">
          {voice.usable ? (
            <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-600" />
          ) : (
            <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
          )}
          <p className={voice.usable ? 'text-muted-foreground' : 'text-destructive'}>
            {voice.usable
              ? voice.requiresConsent
                ? 'Consent is on record and current. This voice may be used.'
                : 'This voice imitates nobody, so it may be used without consent.'
              : voice.message}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Consent history</CardTitle>
        </CardHeader>
        <CardContent>
          {voice.consents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing recorded yet. A cloned voice cannot be used until consent is on record.
            </p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {voice.consents.map((consent) => (
                <li key={consent.id} className="space-y-1 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={CONSENT_STATUS_VARIANT[consent.status]}>{consent.status}</Badge>
                    <span className="font-medium">{consent.subjectName}</span>
                    <span className="text-muted-foreground">
                      {consent.method.replace(/_/g, ' ').toLowerCase()}
                    </span>
                  </div>
                  <p className="text-muted-foreground">
                    Covers {consent.scopes.join(', ').toLowerCase()}
                    {consent.expiresAt
                      ? ` · expires ${new Date(consent.expiresAt).toLocaleDateString()}`
                      : ''}
                    {consent.reference ? ` · ref ${consent.reference}` : ''}
                  </p>
                  {consent.revokedReason ? (
                    <p className="text-destructive">Revoked: {consent.revokedReason}</p>
                  ) : null}
                  {canConsent && consent.status === 'GRANTED' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={revoke.isPending}
                      onClick={() =>
                        revoke.mutate({
                          consentId: consent.id,
                          reason: 'Withdrawn by the subject.',
                        })
                      }
                    >
                      Revoke consent
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {voice.requiresConsent ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Record consent</CardTitle>
          </CardHeader>
          <CardContent>
            {!canConsent ? (
              <p className="flex items-start gap-2 text-sm text-muted-foreground">
                <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
                Recording or revoking consent needs the{' '}
                <code className="rounded bg-muted px-1">voice:consent</code> permission.
              </p>
            ) : (
              <form className="space-y-4" onSubmit={submit}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="consent-subject">Whose voice is this?</Label>
                    <Input
                      id="consent-subject"
                      value={subjectName}
                      onChange={(event) => setSubjectName(event.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="consent-method">How was consent obtained?</Label>
                    <select
                      id="consent-method"
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={method}
                      onChange={(event) => setMethod(event.target.value)}
                    >
                      <option value="SIGNED_RELEASE">Signed release</option>
                      <option value="WRITTEN_AGREEMENT">Written agreement</option>
                      <option value="RECORDED_STATEMENT">Recorded statement</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="consent-reference">Contract reference</Label>
                    <Input
                      id="consent-reference"
                      value={reference}
                      onChange={(event) => setReference(event.target.value)}
                      placeholder="MSA-2026-114"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="consent-expires">Expires</Label>
                    <Input
                      id="consent-expires"
                      type="date"
                      value={expiresAt}
                      onChange={(event) => setExpiresAt(event.target.value)}
                      required
                    />
                    <p className="text-xs text-muted-foreground">
                      Consent is always time-boxed; it cannot be open-ended.
                    </p>
                  </div>
                </div>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">What may it be used for?</legend>
                  <div className="flex flex-wrap gap-3">
                    {SCOPES.map((scope) => (
                      <label key={scope} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={scopes.includes(scope)}
                          onChange={(event) =>
                            setScopes((previous) =>
                              event.target.checked
                                ? [...previous, scope]
                                : previous.filter((value) => value !== scope),
                            )
                          }
                        />
                        {scope.replace(/_/g, ' ').toLowerCase()}
                      </label>
                    ))}
                  </div>
                </fieldset>
                {record.isError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {record.error.message}
                  </p>
                ) : null}
                <Button type="submit" disabled={record.isPending || scopes.length === 0}>
                  Record consent
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
