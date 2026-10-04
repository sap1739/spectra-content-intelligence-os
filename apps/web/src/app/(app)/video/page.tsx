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
import { Clapperboard, Film, Info, Lock } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { usePermissions, useWorkspace } from '@/lib/auth';
import {
  formatDuration,
  scriptToStoryboard,
  useCreateVideoProject,
  useVideoCapabilities,
  useVideoFormats,
  useVideoProjects,
} from '@/lib/video';

/**
 * Video creation (Phase 7B, ADR-0041). The page's first job is to be honest
 * about two things a user would otherwise assume: Spectra composes video from
 * assets this workspace already has — it does not generate any — and rendering
 * depends on an engine the deployment installed, which may not be there.
 */

const KINDS = [
  { value: 'SLIDESHOW', label: 'Slideshow', format: 'SQUARE_1080x1080' },
  { value: 'VERTICAL_SHORT', label: 'Vertical short', format: 'VERTICAL_1080x1920' },
  { value: 'SQUARE_SOCIAL', label: 'Square social', format: 'SQUARE_1080x1080' },
  { value: 'LANDSCAPE', label: 'Landscape', format: 'LANDSCAPE_1920x1080' },
  { value: 'CAPTIONED', label: 'Captioned', format: 'VERTICAL_1080x1920' },
] as const;

export default function VideoPage() {
  const router = useRouter();
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;
  const { can } = usePermissions();
  const canWrite = can('video:write');

  const capabilities = useVideoCapabilities(workspaceId);
  const formats = useVideoFormats(workspaceId);
  const projects = useVideoProjects(workspaceId);
  const create = useCreateVideoProject(workspaceId);

  const [name, setName] = React.useState('');
  const [kind, setKind] = React.useState<(typeof KINDS)[number]['value']>('SLIDESHOW');
  const [script, setScript] = React.useState('');

  const formatFor = (value: string) =>
    KINDS.find((k) => k.value === value)?.format ?? 'SQUARE_1080x1080';
  const formatLabel = (key: string) =>
    formats.data?.formats.find((format) => format.key === key)?.label ?? key;

  const storyboard = React.useMemo(() => scriptToStoryboard(script), [script]);
  const plannedMs = storyboard.scenes.reduce((sum, scene) => sum + scene.durationMs, 0);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || storyboard.scenes.length === 0) return;
    const created = await create.mutateAsync({
      name: name.trim(),
      kind,
      formatKey: formatFor(kind),
      storyboard,
    } as never);
    router.push(`/video/${created.project.id}`);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Video"
        description="Compose video from the images, text and audio in this workspace, and render it locally."
      />

      {/* The two things a user would otherwise have to guess at. */}
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6 text-sm sm:flex-row sm:items-start">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="space-y-2">
            <p className="font-medium">Real rendering, no generated video</p>
            <p className="text-muted-foreground">
              {capabilities.data?.generationNote ??
                'Spectra composes video from the images, text and audio in this workspace. There is no generative-video provider wired.'}
            </p>
            {capabilities.isLoading ? (
              <Skeleton className="h-4 w-72" />
            ) : capabilities.data?.available ? (
              <p className="text-muted-foreground" data-testid="video-engine">
                Engine: {capabilities.data.engine} {capabilities.data.engineVersion ?? ''} —{' '}
                {capabilities.data.videoCodec}
              </p>
            ) : (
              <p className="text-destructive" role="status" data-testid="video-engine-unavailable">
                {capabilities.data?.reason ??
                  'No video engine is configured in this deployment, so nothing can be rendered yet.'}
              </p>
            )}
            {(capabilities.data?.missing.length ?? 0) > 0 ? (
              <ul className="list-inside list-disc text-muted-foreground">
                {capabilities.data?.missing.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {canWrite ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New video</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={submit}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="video-name">Name</Label>
                  <Input
                    id="video-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Launch announcement"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="video-kind">Type</Label>
                  <select
                    id="video-kind"
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={kind}
                    onChange={(event) => setKind(event.target.value as typeof kind)}
                  >
                    {KINDS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label} — {formatLabel(option.format)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="video-script">Script</Label>
                <textarea
                  id="video-script"
                  className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={script}
                  onChange={(event) => setScript(event.target.value)}
                  placeholder={'One line per scene.\nEach line becomes a caption too.'}
                />
                <p className="text-xs text-muted-foreground">
                  {storyboard.scenes.length === 0
                    ? 'Each non-empty line becomes one scene.'
                    : `${storyboard.scenes.length} scene${storyboard.scenes.length === 1 ? '' : 's'}, ${formatDuration(plannedMs)} before any transitions.`}
                </p>
              </div>
              {create.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {create.error.message}
                </p>
              ) : null}
              <Button type="submit" disabled={create.isPending || storyboard.scenes.length === 0}>
                Create storyboard
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex items-start gap-3 pt-6 text-sm text-muted-foreground">
            <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
            <p>
              Creating and rendering video needs the{' '}
              <code className="rounded bg-muted px-1">video:write</code> permission.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Storyboards</CardTitle>
        </CardHeader>
        <CardContent>
          {projects.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : projects.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {projects.error.message}
            </p>
          ) : (projects.data?.projects.length ?? 0) === 0 ? (
            <EmptyState
              icon={<Clapperboard aria-hidden className="size-6" />}
              title="No video yet"
              description="Write a script above and Spectra turns each line into a scene you can edit and render."
            />
          ) : (
            <ul className="divide-y divide-border">
              {projects.data?.projects.map((project) => (
                <li key={project.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <Link
                      href={`/video/${project.id}`}
                      className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {project.name}
                    </Link>
                    <p className="truncate text-sm text-muted-foreground">
                      {formatLabel(project.formatKey)} · {project.storyboard.scenes.length} scenes ·{' '}
                      {project._count?.renders ?? 0} render
                      {(project._count?.renders ?? 0) === 1 ? '' : 's'}
                    </p>
                  </div>
                  <Badge variant={project.status === 'READY' ? 'success' : 'muted'}>
                    {project.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Output sizes</CardTitle>
        </CardHeader>
        <CardContent>
          {formats.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <ul className="space-y-2 text-sm">
              {formats.data?.formats.map((format) => (
                <li key={format.key} className="flex items-start gap-3">
                  <Film aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>
                    <span className="font-medium">{format.label}</span>{' '}
                    <span className="text-muted-foreground">
                      — {format.note} Up to {format.maxDurationSeconds}s at {format.fps}fps.
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
