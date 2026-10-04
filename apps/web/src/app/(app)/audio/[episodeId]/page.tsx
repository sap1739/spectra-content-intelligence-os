'use client';

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Label,
  Skeleton,
} from '@spectra/ui';
import { AlertTriangle, ArrowLeft, Download, Lock, Play, ShieldAlert, X } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { usePermissions, useWorkspace } from '@/lib/auth';
import {
  AUDIO_STATUS_VARIANT,
  formatBytes,
  formatDuration,
  useAudioCapabilities,
  useAudioRenderUrl,
  useCancelAudioRender,
  useEpisode,
  useStartAudioRender,
  useUpdateEpisode,
  type AudioRenderRow,
} from '@/lib/audio';

/**
 * One episode: its segments, its host notes, the consent state of every voice
 * it speaks with, and the mixes themselves. A mix that failed says why; a mix
 * that succeeded reports what was actually encoded, including its measured
 * loudness.
 */
export default function EpisodePage() {
  const params = useParams<{ episodeId: string }>();
  const episodeId = params.episodeId;
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;
  const { can } = usePermissions();
  const canWrite = can('audio:write');

  const detail = useEpisode(workspaceId, episodeId);
  const capabilities = useAudioCapabilities(workspaceId);
  const startRender = useStartAudioRender(workspaceId, episodeId);
  const cancelRender = useCancelAudioRender(workspaceId);
  const renderUrl = useAudioRenderUrl(workspaceId);
  const update = useUpdateEpisode(workspaceId, episodeId);

  const [showNotes, setShowNotes] = React.useState<string | null>(null);
  const [playing, setPlaying] = React.useState<{ id: string; url: string } | null>(null);

  async function play(render: AudioRenderRow) {
    const signed = await renderUrl.mutateAsync({ renderId: render.id });
    setPlaying({ id: render.id, url: signed.url });
  }

  async function download(renderId: string, file: 'audio' | 'waveform') {
    const signed = await renderUrl.mutateAsync({ renderId, file });
    window.open(signed.url, '_blank', 'noopener,noreferrer');
  }

  if (detail.isLoading) return <Skeleton className="h-64 w-full" />;
  if (detail.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {detail.error.message}
      </p>
    );
  }

  const { episode, renders, transcripts, plan, problems, voices } = detail.data!;
  const blockedVoices = voices.filter((voice) => !voice.usable);
  const notes = showNotes ?? episode.showNotes ?? '';

  return (
    <div className="space-y-6">
      <Link
        href="/audio"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft aria-hidden className="size-4" /> Back to audio
      </Link>
      <PageHeader title={episode.title} description={episode.summary ?? undefined} />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          {blockedVoices.length > 0 ? (
            <Card>
              <CardContent className="space-y-2 pt-6 text-sm" data-testid="consent-blockers">
                <p className="flex items-center gap-2 font-medium text-destructive">
                  <ShieldAlert aria-hidden className="size-4" /> This episode cannot be rendered yet
                </p>
                <ul className="space-y-1">
                  {blockedVoices.map((voice) => (
                    <li key={voice.id} className="text-muted-foreground">
                      <span className="font-medium">{voice.name}</span>: {voice.message}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Segments</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {problems.length > 0 ? (
                <div role="alert" className="space-y-1 text-sm text-destructive">
                  <p className="font-medium">This script cannot be rendered yet:</p>
                  <ul className="list-inside list-disc">
                    {problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {plan?.segments} segments · normalized to {episode.script.targetLufs} LUFS · for{' '}
                  {episode.consentScope.replace(/_/g, ' ').toLowerCase()}
                </p>
              )}
              {(plan?.warnings.length ?? 0) > 0 ? (
                <div className="space-y-1 text-sm">
                  <p className="flex items-center gap-2 font-medium">
                    <AlertTriangle aria-hidden className="size-4" /> Worth knowing
                  </p>
                  <ul className="list-inside list-disc text-muted-foreground">
                    {plan?.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <ol className="divide-y divide-border text-sm">
                {episode.script.segments.map((segment, index) => (
                  <li key={segment.id} className="space-y-1 py-2">
                    <p className="font-medium">
                      {index + 1}. {segment.title ?? segment.id}{' '}
                      <Badge variant="muted">{segment.kind}</Badge>
                    </p>
                    <p className="text-muted-foreground">
                      {segment.source.kind === 'UPLOADED'
                        ? 'Uploaded audio'
                        : segment.source.kind === 'SILENCE'
                          ? `Silence · ${formatDuration(segment.source.durationMs)}`
                          : 'Spoken by a voice — needs a synthesis provider'}
                      {segment.gainDb !== 0 ? ` · ${segment.gainDb} dB` : ''}
                    </p>
                    {segment.hostNotes ? (
                      // Production direction: never spoken, never rendered.
                      <p className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                        Host note (not spoken): {segment.hostNotes}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Show notes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Label htmlFor="show-notes" className="sr-only">
                Show notes
              </Label>
              <textarea
                id="show-notes"
                className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={notes}
                disabled={!canWrite}
                onChange={(event) => setShowNotes(event.target.value)}
                placeholder="Published alongside the audio."
              />
              {canWrite ? (
                <Button
                  size="sm"
                  disabled={update.isPending || showNotes === null}
                  onClick={() => update.mutate({ showNotes: notes })}
                >
                  Save notes
                </Button>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Mixes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {renders.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No mixes yet. A mix is queued, encoded by the worker, and appears here with its
                  real duration, size and measured loudness.
                </p>
              ) : (
                <ul className="space-y-4">
                  {renders.map((render) => (
                    <li key={render.id} className="space-y-2 rounded-md border border-border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Badge variant={AUDIO_STATUS_VARIANT[render.status]}>{render.status}</Badge>
                        <span className="text-xs text-muted-foreground">{render.kind}</span>
                      </div>

                      {render.status === 'RUNNING' || render.status === 'QUEUED' ? (
                        <div className="space-y-1">
                          <div
                            role="progressbar"
                            aria-valuenow={render.progressPercent}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-label="Mix progress"
                            className="h-2 w-full overflow-hidden rounded-full bg-muted"
                          >
                            <div
                              className="h-full bg-primary transition-all"
                              style={{ width: `${render.progressPercent}%` }}
                            />
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {render.status === 'QUEUED'
                              ? 'Queued — waiting for a worker.'
                              : `Mixing — ${render.progressPercent}%`}
                          </p>
                        </div>
                      ) : null}

                      {render.status === 'SUCCEEDED' ? (
                        <div className="space-y-2 text-sm">
                          <p className="text-muted-foreground">
                            {formatDuration(render.durationMs ?? 0)} ·{' '}
                            {formatBytes(render.sizeBytes ?? 0)}
                            {render.integratedLufs !== null
                              ? ` · measured ${render.integratedLufs.toFixed(1)} LUFS`
                              : ''}
                          </p>
                          {playing?.id === render.id ? (
                            <audio controls src={playing.url} className="w-full" />
                          ) : null}
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="outline" onClick={() => void play(render)}>
                              <Play aria-hidden className="size-4" /> Play
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void download(render.id, 'audio')}
                            >
                              <Download aria-hidden className="size-4" /> MP3
                            </Button>
                            {render.waveformAssetId ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void download(render.id, 'waveform')}
                              >
                                <Download aria-hidden className="size-4" /> Waveform
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      ) : null}

                      {render.failureReason ? (
                        <div role="alert" className="space-y-1 text-sm text-destructive">
                          <p>
                            {capabilities.data?.failureReasons[render.failureReason] ??
                              render.failureReason}
                          </p>
                          {render.failureDetail ? (
                            <p className="text-xs text-muted-foreground">{render.failureDetail}</p>
                          ) : null}
                        </div>
                      ) : null}

                      {render.warnings.length > 0 ? (
                        <ul className="list-inside list-disc text-xs text-muted-foreground">
                          {render.warnings.map((warning) => (
                            <li key={warning}>{warning}</li>
                          ))}
                        </ul>
                      ) : null}

                      {canWrite && (render.status === 'QUEUED' || render.status === 'RUNNING') ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={cancelRender.isPending}
                          onClick={() => cancelRender.mutate(render.id)}
                        >
                          <X aria-hidden className="size-4" /> Cancel
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {transcripts.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Transcript</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {transcripts.map((transcript) => (
                  <p key={transcript.id} className="text-muted-foreground">
                    <Badge variant="muted">{transcript.source.replace(/_/g, ' ')}</Badge>{' '}
                    {transcript.cues.length} cues
                    {transcript.source === 'SCRIPT_DERIVED'
                      ? ' — the words come from the script and the timings from the mix. Nothing listened to the audio.'
                      : ''}
                  </p>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">Render</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {!canWrite ? (
              <p className="flex items-start gap-2 text-muted-foreground">
                <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
                Rendering needs the <code className="rounded bg-muted px-1">audio:write</code>{' '}
                permission.
              </p>
            ) : !capabilities.data?.engine.available ? (
              <p role="status" className="text-destructive">
                {capabilities.data?.engine.reason ?? 'No audio engine is configured.'}
              </p>
            ) : (
              <>
                {startRender.isError ? (
                  <p role="alert" className="text-destructive">
                    {startRender.error.message}
                  </p>
                ) : null}
                {startRender.data && !startRender.data.created ? (
                  <p className="text-muted-foreground">
                    These inputs were already mixed, so the existing file was reused.
                  </p>
                ) : null}
                <Button
                  disabled={
                    startRender.isPending || problems.length > 0 || blockedVoices.length > 0
                  }
                  onClick={() => startRender.mutate({ waveform: true })}
                >
                  Render mix
                </Button>
                <p className="text-xs text-muted-foreground">
                  Mixing is queued and runs in the worker. The result is normalized to{' '}
                  {episode.script.targetLufs} LUFS and its real loudness is measured and shown.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
