'use client';

import {
  Badge,
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
import { Image as ImageIcon } from 'lucide-react';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { useWorkspace } from '@/lib/auth';
import {
  mediaContentUrl,
  useMediaAssets,
  useMediaStatus,
  useProcessImage,
  type MediaAssetRow,
} from '@/lib/media';

const fieldClass = cn(
  'w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm shadow-sm',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
);

/** Loads asset bytes with the session cookie and renders them as an object URL. */
function MediaThumb({ workspaceId, asset }: { workspaceId: string; asset: MediaAssetRow }) {
  const [url, setUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    let revoked: string | null = null;
    let active = true;
    fetch(mediaContentUrl(workspaceId, asset.id), { credentials: 'include' })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((blob) => {
        if (!active) return;
        revoked = URL.createObjectURL(blob);
        setUrl(revoked);
      })
      .catch(() => setUrl(null));
    return () => {
      active = false;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [workspaceId, asset.id]);

  if (asset.mimeType === 'application/octet-stream') {
    return (
      <div className="grid h-24 w-24 place-items-center rounded-md bg-muted text-[10px] text-muted-foreground">
        source
      </div>
    );
  }
  return url ? (
    <img src={url} alt="" className="h-24 w-24 rounded-md object-cover" />
  ) : (
    <Skeleton className="h-24 w-24" />
  );
}

export default function MediaPage() {
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;

  const status = useMediaStatus(workspaceId);
  const assets = useMediaAssets(workspaceId);
  const process = useProcessImage(workspaceId);

  const [width, setWidth] = React.useState('1080');
  const [height, setHeight] = React.useState('1080');
  const [format, setFormat] = React.useState('webp');
  const [error, setError] = React.useState<string | null>(null);

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const file = event.target.files?.[0];
    if (!file) return;
    const buffer = await file.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    try {
      await process.mutateAsync({
        imageBase64: base64,
        operations: [
          { kind: 'resize', width: Number(width), height: Number(height), fit: 'cover' },
        ],
        outputFormat: format as never,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Processing failed');
    } finally {
      event.target.value = '';
    }
  };

  return (
    <>
      <PageHeader
        title="Media"
        description="Process images into platform-ready sizes and formats. Rendering runs on sharp; video and audio pipelines are honestly disabled until their engines are wired."
      />

      {status.data ? (
        <div className="mb-6 flex flex-wrap gap-2 text-xs">
          <Badge variant={status.data.image ? 'success' : 'muted'}>
            Image {status.data.image ? 'ready' : 'off'}
          </Badge>
          <Badge variant="muted">Video not available yet</Badge>
          <Badge variant="muted">Audio not available yet</Badge>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Process an image</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="m-w">Width</Label>
                <Input
                  id="m-w"
                  type="number"
                  value={width}
                  onChange={(e) => setWidth(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="m-h">Height</Label>
                <Input
                  id="m-h"
                  type="number"
                  value={height}
                  onChange={(e) => setHeight(e.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="m-fmt">Output format</Label>
              <select
                id="m-fmt"
                className={fieldClass}
                value={format}
                onChange={(e) => setFormat(e.target.value)}
              >
                {['webp', 'jpeg', 'png', 'avif'].map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="m-file">Upload &amp; resize</Label>
              <input
                id="m-file"
                type="file"
                accept="image/*"
                onChange={onFile}
                disabled={process.isPending}
                className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-primary-foreground"
              />
            </div>
            {process.isPending ? (
              <p className="text-xs text-muted-foreground">Processing…</p>
            ) : null}
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <div>
          {assets.isPending ? (
            <Skeleton className="h-48 w-full" />
          ) : assets.isError ? (
            <EmptyState
              icon={<ImageIcon />}
              title="Could not load media"
              description={assets.error.message}
            />
          ) : assets.data.length === 0 ? (
            <EmptyState
              icon={<ImageIcon />}
              title="No media assets yet"
              description="Upload an image to resize and convert it into a platform-ready asset."
            />
          ) : (
            <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {assets.data.map((a) => (
                <li key={a.id} className="flex flex-col gap-2 rounded-md border border-border p-3">
                  <MediaThumb workspaceId={workspaceId} asset={a} />
                  <div className="text-[11px] text-muted-foreground">
                    <p className="font-medium text-foreground">{a.mimeType}</p>
                    {a.widthPx ? (
                      <p>
                        {a.widthPx}×{a.heightPx} · {(a.sizeBytes / 1024).toFixed(0)} KB
                      </p>
                    ) : (
                      <p>{(a.sizeBytes / 1024).toFixed(0)} KB source</p>
                    )}
                    {a.engine ? <p>engine: {a.engine}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
