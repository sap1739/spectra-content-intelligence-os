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
import { AlertTriangle, ArrowLeft, Download, Film, Lock, X } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { usePermissions, useWorkspace } from '@/lib/auth';
import {
  RENDER_STATUS_VARIANT,
  formatBytes,
  formatDuration,
  useCancelVideoRender,
  useStartVideoRender,
  useVideoCapabilities,
  useVideoProject,
  useVideoRenderUrl,
  type VideoRenderRow,
} from '@/lib/video';

/**
 * One storyboard: its scenes, what a render would warn about, and the renders
 * themselves. A render that is queued or running shows real progress from the
 * encoder; one that failed shows why, in words.
 */
export default function VideoProjectPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;
  const { can } = usePermissions();
  const canWrite = can('video:write');

  const detail = useVideoProject(workspaceId, projectId);
  const capabilities = useVideoCapabilities(workspaceId);
  const startRender = useStartVideoRender(workspaceId, projectId);
  const cancelRender = useCancelVideoRender(workspaceId);
  const renderUrl = useVideoRenderUrl(workspaceId);

  const [captions, setCaptions] = React.useState<'NONE' | 'SRT' | 'VTT'>('SRT');
  const [crf, setCrf] = React.useState(23);
  const [playing, setPlaying] = React.useState<{
    id: string;
    url: string;
    captionUrl: string | null;
  } | null>(null);

  async function play(render: VideoRenderRow) {
    const signed = await renderUrl.mutateAsync({ renderId: render.id });
    // A render that has a caption sidecar plays with it attached, rather than
    // only offering it as a download.
    const captions = render.captionAssetId
      ? await renderUrl.mutateAsync({ renderId: render.id, file: 'captions' }).catch(() => null)
      : null;
    setPlaying({ id: render.id, url: signed.url, captionUrl: captions?.url ?? null });
  }

  async function download(renderId: string, file: 'video' | 'captions' | 'poster') {
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

  const { project, renders, plan, problems } = detail.data!;

  return (
    <div className="space-y-6">
      <Link
        href="/video"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft aria-hidden className="size-4" /> Back to video
      </Link>
      <PageHeader title={project.name} description={project.description ?? undefined} />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Storyboard</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {problems.length > 0 ? (
                <div role="alert" className="space-y-1 text-sm text-destructive">
                  <p className="font-medium">This storyboard cannot be rendered yet:</p>
                  <ul className="list-inside list-disc">
                    {problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {plan?.scenes} scenes · {formatDuration(plan?.totalDurationMs ?? 0)} ·{' '}
                  {project.formatKey}
                </p>
              )}
              {(plan?.warnings.length ?? 0) > 0 ? (
                <div className="space-y-1 text-sm">
                  <p className="flex items-center gap-2 font-medium">
                    <AlertTriangle aria-hidden className="size-4" /> What a render would do
                    differently
                  </p>
                  <ul className="list-inside list-disc text-muted-foreground">
                    {plan?.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <ol className="divide-y divide-border text-sm">
                {project.storyboard.scenes.map((scene, index) => (
                  <li key={scene.id} className="flex items-start justify-between gap-4 py-2">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {index + 1}. {scene.heading?.text ?? scene.id}
                      </p>
                      <p className="truncate text-muted-foreground">
                        {scene.background.kind === 'IMAGE' ? 'Image' : 'Colour'} ·{' '}
                        {formatDuration(scene.durationMs)}
                        {scene.caption ? ` · “${scene.caption}”` : ''}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Renders</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {renders.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No renders yet. A render is queued, encoded by the worker, and appears here with
                  its real duration and size.
                </p>
              ) : (
                <ul className="space-y-4">
                  {renders.map((render) => (
                    <li key={render.id} className="space-y-2 rounded-md border border-border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Badge variant={RENDER_STATUS_VARIANT[render.status]}>
                          {render.status}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {render.formatKey} · planned {formatDuration(render.plannedDurationMs)}
                        </span>
                      </div>

                      {render.status === 'RUNNING' || render.status === 'QUEUED' ? (
                        <div className="space-y-1">
                          <div
                            role="progressbar"
                            aria-valuenow={render.progressPercent}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-label="Render progress"
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
                              : `Encoding — ${render.progressPercent}%`}
                          </p>
                        </div>
                      ) : null}

                      {render.status === 'SUCCEEDED' ? (
                        <div className="space-y-2 text-sm">
                          <p className="text-muted-foreground">
                            {render.widthPx}×{render.heightPx} · {render.videoCodec} ·{' '}
                            {formatDuration(render.durationMs ?? 0)} ·{' '}
                            {formatBytes(render.sizeBytes ?? 0)}
                          </p>
                          {playing?.id === render.id ? (
                            <video
                              controls
                              src={playing.url}
                              className="w-full rounded-md"
                              aria-label={`${project.name} render`}
                            >
                              {playing.captionUrl ? (
                                <track
                                  kind="captions"
                                  label="Captions"
                                  src={playing.captionUrl}
                                  default
                                />
                              ) : null}
                            </video>
                          ) : null}
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="outline" onClick={() => void play(render)}>
                              <Film aria-hidden className="size-4" /> Play
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void download(render.id, 'video')}
                            >
                              <Download aria-hidden className="size-4" /> MP4
                            </Button>
                            {render.captionAssetId ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void download(render.id, 'captions')}
                              >
                                <Download aria-hidden className="size-4" /> Captions
                              </Button>
                            ) : null}
                            {render.thumbnailAssetId ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void download(render.id, 'poster')}
                              >
                                <Download aria-hidden className="size-4" /> Poster
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
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">Render</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {!canWrite ? (
              <p className="flex items-start gap-2 text-muted-foreground">
                <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
                Rendering needs the <code className="rounded bg-muted px-1">video:write</code>{' '}
                permission.
              </p>
            ) : !capabilities.data?.available ? (
              <p role="status" className="text-destructive">
                {capabilities.data?.reason ?? 'No video engine is configured in this deployment.'}
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="render-captions">Captions</Label>
                  <select
                    id="render-captions"
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={captions}
                    onChange={(event) => setCaptions(event.target.value as typeof captions)}
                  >
                    <option value="NONE">No caption file</option>
                    <option value="SRT">SRT sidecar</option>
                    <option value="VTT">WebVTT sidecar</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="render-crf">Quality (CRF {crf})</Label>
                  <input
                    id="render-crf"
                    type="range"
                    min={18}
                    max={34}
                    value={crf}
                    onChange={(event) => setCrf(Number(event.target.value))}
                    className="w-full"
                  />
                  <p className="text-xs text-muted-foreground">
                    Lower is better quality and a bigger file.
                  </p>
                </div>
                {startRender.isError ? (
                  <p role="alert" className="text-destructive">
                    {startRender.error.message}
                  </p>
                ) : null}
                {startRender.data && !startRender.data.created ? (
                  <p className="text-muted-foreground">
                    These inputs were already rendered, so the existing file was reused.
                  </p>
                ) : null}
                <Button
                  disabled={startRender.isPending || problems.length > 0}
                  onClick={() => startRender.mutate({ captions, thumbnail: true, crf })}
                >
                  Render video
                </Button>
                <p className="text-xs text-muted-foreground">
                  Rendering is queued and runs in the worker. Identical inputs reuse the file
                  already made rather than encoding it twice.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
