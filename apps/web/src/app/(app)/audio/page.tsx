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
} from '@spectra/ui';
import { Info, Lock, Mic, ShieldCheck, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { usePermissions, useWorkspace } from '@/lib/auth';
import {
  CONSENT_STATUS_VARIANT,
  useAudioCapabilities,
  useCreateEpisode,
  useCreateVoice,
  useEpisodes,
  useVoices,
} from '@/lib/audio';

/**
 * Audio studio (Phase 7C, ADR-0042).
 *
 * Two things this page refuses to leave implicit: Spectra mixes audio it is
 * given and generates none, and a voice that imitates a real person cannot be
 * used until that person's consent is on record.
 */
export default function AudioPage() {
  const router = useRouter();
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;
  const { can } = usePermissions();
  const canWrite = can('audio:write');
  const canConsent = can('voice:consent');

  const capabilities = useAudioCapabilities(workspaceId);
  const voices = useVoices(workspaceId);
  const episodes = useEpisodes(workspaceId);
  const createEpisode = useCreateEpisode(workspaceId);
  const createVoice = useCreateVoice(workspaceId);

  const [title, setTitle] = React.useState('');
  const [voiceName, setVoiceName] = React.useState('');
  const [voiceKind, setVoiceKind] = React.useState<'STOCK' | 'CLONED' | 'CUSTOM_SYNTHETIC'>(
    'STOCK',
  );
  const [subjectName, setSubjectName] = React.useState('');

  async function submitEpisode(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    const created = await createEpisode.mutateAsync({
      title: title.trim(),
      consentScope: 'PODCAST',
      // A new episode starts with one placeholder beat the editor replaces with
      // real audio — never with invented sound.
      script: {
        schemaVersion: 1,
        normalize: true,
        targetLufs: -16,
        segments: [
          {
            id: 'segment-1',
            kind: 'INTRO',
            source: { kind: 'SILENCE', durationMs: 1000 },
            gainDb: 0,
          },
        ],
      },
    } as never);
    router.push(`/audio/${created.episode.id}`);
  }

  async function submitVoice(event: React.FormEvent) {
    event.preventDefault();
    if (!voiceName.trim()) return;
    await createVoice.mutateAsync({
      name: voiceName.trim(),
      kind: voiceKind,
      language: 'en',
      ...(voiceKind === 'CLONED' ? { subjectName: subjectName.trim() } : {}),
    } as never);
    setVoiceName('');
    setSubjectName('');
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audio"
        description="Mix, normalize and visualise audio this workspace already has."
      />

      <Card>
        <CardContent className="flex flex-col gap-3 pt-6 text-sm sm:flex-row sm:items-start">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="space-y-2">
            <p className="font-medium">Real mixing, no generated audio</p>
            <p className="text-muted-foreground">
              {capabilities.data?.generationNote ??
                'Spectra mixes, normalizes and visualises audio this workspace already has.'}
            </p>
            {capabilities.isLoading ? (
              <Skeleton className="h-4 w-72" />
            ) : capabilities.data?.engine.available ? (
              <p className="text-muted-foreground" data-testid="audio-engine">
                Engine: ffmpeg {capabilities.data.engine.engineVersion ?? ''} —{' '}
                {capabilities.data.engine.audioCodec}
                {capabilities.data.engine.features.normalization ? ', EBU R128 normalization' : ''}
              </p>
            ) : (
              <p className="text-destructive" role="status" data-testid="audio-engine-unavailable">
                {capabilities.data?.engine.reason ??
                  'No audio engine is configured in this deployment.'}
              </p>
            )}
            {/* Every synthesis provider, and why it is not available. */}
            <ul className="space-y-1 text-muted-foreground" data-testid="audio-providers">
              {capabilities.data?.providers.map((provider) => (
                <li key={provider.kind}>
                  <span className="font-medium">
                    {provider.kind.replace(/_/g, ' ').toLowerCase()}
                  </span>
                  : <Badge variant="muted">{provider.status.replace(/_/g, ' ')}</Badge>{' '}
                  {provider.reason}
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Voices</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {capabilities.data?.consentPolicy ??
              'A voice that imitates a real person cannot be used without granted, unexpired consent.'}
          </p>

          {voices.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : (voices.data?.voices.length ?? 0) === 0 ? (
            <EmptyState
              icon={<Mic aria-hidden className="size-6" />}
              title="No voices yet"
              description="Add a stock voice, or a cloned voice and the consent that permits it."
            />
          ) : (
            <ul className="divide-y divide-border">
              {voices.data?.voices.map((voice) => (
                <li
                  key={voice.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{voice.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {voice.kind === 'CLONED'
                        ? `Cloned from ${voice.subjectName ?? 'an unnamed person'}`
                        : voice.kind === 'STOCK'
                          ? 'Stock voice — imitates nobody'
                          : 'Custom synthetic — tied to no person'}
                    </p>
                    {!voice.usable && voice.message ? (
                      <p
                        className="flex items-center gap-1.5 text-sm text-destructive"
                        role="status"
                      >
                        <ShieldAlert aria-hidden className="size-4 shrink-0" />
                        {voice.message}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    {voice.consents[0] ? (
                      <Badge variant={CONSENT_STATUS_VARIANT[voice.consents[0].status]}>
                        {voice.consents[0].status}
                      </Badge>
                    ) : voice.requiresConsent ? (
                      <Badge variant="destructive">NO CONSENT</Badge>
                    ) : (
                      <Badge variant="muted">CONSENT NOT NEEDED</Badge>
                    )}
                    {voice.usable ? (
                      <ShieldCheck aria-label="Usable" className="size-4 text-emerald-600" />
                    ) : null}
                    {canConsent ? (
                      <Link
                        href={`/audio/voices/${voice.id}`}
                        className="text-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        Consent
                      </Link>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {canWrite ? (
            <form className="grid gap-3 sm:grid-cols-[1fr_12rem_auto]" onSubmit={submitVoice}>
              <div className="space-y-1.5">
                <Label htmlFor="voice-name">Voice name</Label>
                <Input
                  id="voice-name"
                  value={voiceName}
                  onChange={(event) => setVoiceName(event.target.value)}
                  placeholder="Narrator"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="voice-kind">Kind</Label>
                <select
                  id="voice-kind"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={voiceKind}
                  onChange={(event) => setVoiceKind(event.target.value as typeof voiceKind)}
                >
                  <option value="STOCK">Stock</option>
                  <option value="CLONED">Cloned (needs consent)</option>
                  <option value="CUSTOM_SYNTHETIC">Custom synthetic</option>
                </select>
              </div>
              <div className="flex items-end">
                <Button type="submit" disabled={createVoice.isPending}>
                  Add voice
                </Button>
              </div>
              {voiceKind === 'CLONED' ? (
                <div className="space-y-1.5 sm:col-span-3">
                  <Label htmlFor="voice-subject">Whose voice is this?</Label>
                  <Input
                    id="voice-subject"
                    value={subjectName}
                    onChange={(event) => setSubjectName(event.target.value)}
                    placeholder="Full name of the person"
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    A cloned voice always belongs to someone, and cannot be used until their consent
                    is recorded.
                  </p>
                </div>
              ) : null}
              {createVoice.isError ? (
                <p role="alert" className="text-sm text-destructive sm:col-span-3">
                  {createVoice.error.message}
                </p>
              ) : null}
            </form>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Episodes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {episodes.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : (episodes.data?.episodes.length ?? 0) === 0 ? (
            <EmptyState
              icon={<Mic aria-hidden className="size-6" />}
              title="No episodes yet"
              description="Create an episode, then build its segments from audio in your media library."
            />
          ) : (
            <ul className="divide-y divide-border">
              {episodes.data?.episodes.map((episode) => (
                <li key={episode.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <Link
                      href={`/audio/${episode.id}`}
                      className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {episode.title}
                    </Link>
                    <p className="text-sm text-muted-foreground">
                      {episode.script.segments.length} segments · {episode._count?.renders ?? 0}{' '}
                      render
                      {(episode._count?.renders ?? 0) === 1 ? '' : 's'}
                    </p>
                  </div>
                  <Badge variant={episode.status === 'READY' ? 'success' : 'muted'}>
                    {episode.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}

          {canWrite ? (
            <form className="flex flex-wrap items-end gap-3" onSubmit={submitEpisode}>
              <div className="min-w-56 flex-1 space-y-1.5">
                <Label htmlFor="episode-title">New episode</Label>
                <Input
                  id="episode-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Episode 1 — the long view"
                />
              </div>
              <Button type="submit" disabled={createEpisode.isPending}>
                Create episode
              </Button>
              {createEpisode.isError ? (
                <p role="alert" className="w-full text-sm text-destructive">
                  {createEpisode.error.message}
                </p>
              ) : null}
            </form>
          ) : (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
              Creating episodes and voices needs the{' '}
              <code className="rounded bg-muted px-1">audio:write</code> permission.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
