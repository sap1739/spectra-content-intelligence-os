'use client';

import type { DesignOutputFormat, TemplateField } from '@spectra/contracts';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Label,
  Skeleton,
  Spinner,
  buttonVariants,
} from '@spectra/ui';
import { ArrowLeft, Download, Image as ImageIcon, Lock, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { usePermissions, useWorkspace } from '@/lib/auth';
import { useBrands } from '@/lib/brands';
import { useMediaAssets } from '@/lib/media';
import {
  DESIGN_STATUS_VARIANT,
  formatBytes,
  useDesign,
  useDesignFormats,
  useDesignPreview,
  useDesignWorkflow,
  useExportDesign,
  useRenderUrl,
  useUpdateDesign,
} from '@/lib/studio';

/**
 * The design editor (ADR-0040). The preview is a real render of the same plan
 * the export uses — only scaled — so what is on screen is what the file will
 * contain, and anything the renderer had to do differently (a missing logo,
 * text that had to shrink) is listed under it rather than hidden.
 */
export default function DesignEditorPage() {
  const params = useParams<{ designId: string }>();
  const designId = params.designId;
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;
  const { can } = usePermissions();
  const canWrite = can('design:write');
  const canApprove = can('content:approve');

  const design = useDesign(workspaceId, designId);
  const formats = useDesignFormats(workspaceId);
  const brands = useBrands(workspaceId);
  const media = useMediaAssets(workspaceId);
  const update = useUpdateDesign(workspaceId, designId);
  const exportDesign = useExportDesign(workspaceId, designId);
  const workflow = useDesignWorkflow(workspaceId, designId);
  const renderUrl = useRenderUrl(workspaceId);

  const [page, setPage] = React.useState(0);
  const [values, setValues] = React.useState<Record<string, string> | null>(null);
  const [images, setImages] = React.useState<Record<string, string> | null>(null);
  const [savedAt, setSavedAt] = React.useState<string | null>(null);
  const preview = useDesignPreview(workspaceId, designId, page, savedAt ?? design.data?.updatedAt);

  React.useEffect(() => {
    if (design.data && values === null) {
      setValues(design.data.values ?? {});
      setImages(design.data.images ?? {});
    }
  }, [design.data, values]);

  if (design.isPending) return <Skeleton className="h-96 w-full" />;
  if (design.isError) {
    return (
      <EmptyState
        icon={<ImageIcon />}
        title="Could not load this design"
        description={design.error.message}
      />
    );
  }

  const data = design.data;
  const fields = data.layout.fields;
  const pageCount = data.layout.pages.length;
  const imageAssets = (media.data ?? []).filter((asset) =>
    ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType),
  );
  const formatLabel = (key: string) =>
    formats.data?.find((format) => format.key === key)?.label ?? key;

  async function save(extra: Record<string, unknown> = {}) {
    await update.mutateAsync({ values: values ?? {}, images: images ?? {}, ...extra });
    setSavedAt(new Date().toISOString());
  }

  const textField = (field: TemplateField) => (
    <div key={field.key}>
      <Label htmlFor={`field-${field.key}`}>
        {field.label}
        {field.required ? ' *' : ''}
      </Label>
      <textarea
        id={`field-${field.key}`}
        className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm"
        rows={field.maxLength > 120 ? 3 : 1}
        maxLength={field.maxLength}
        disabled={!canWrite}
        value={values?.[field.key] ?? ''}
        placeholder={field.defaultValue ?? ''}
        onChange={(event) => setValues({ ...(values ?? {}), [field.key]: event.target.value })}
      />
      <p className="text-[11px] text-muted-foreground">
        {field.help ?? `Up to ${field.maxLength} characters.`}
        {field.defaultValue?.includes('{{') ? ' Leave empty to use the brand placeholder.' : ''}
      </p>
    </div>
  );

  const imageField = (field: TemplateField) => (
    <div key={field.key}>
      <Label htmlFor={`field-${field.key}`}>
        {field.label}
        {field.required ? ' *' : ''}
      </Label>
      <select
        id={`field-${field.key}`}
        className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm"
        disabled={!canWrite}
        value={images?.[field.key] ?? ''}
        onChange={(event) => {
          const next = { ...(images ?? {}) };
          if (event.target.value) next[field.key] = event.target.value;
          else delete next[field.key];
          setImages(next);
        }}
      >
        <option value="">None</option>
        {imageAssets.map((asset) => (
          <option key={asset.id} value={asset.id}>
            {asset.mimeType} · {asset.widthPx ?? '?'}×{asset.heightPx ?? '?'} ·{' '}
            {asset.id.slice(0, 8)}
          </option>
        ))}
      </select>
      <p className="text-[11px] text-muted-foreground">
        From this workspace’s media library (PNG, JPEG or WebP).
      </p>
    </div>
  );

  return (
    <>
      <Link
        href="/studio"
        className={`mb-3 inline-flex ${buttonVariants({ variant: 'ghost', size: 'sm' })}`}
      >
        <ArrowLeft aria-hidden="true" className="size-4" /> Design Studio
      </Link>
      <PageHeader
        title={data.name}
        description={`${formatLabel(data.formatKey)} · ${pageCount} page${pageCount > 1 ? 's' : ''} · ${
          data.templateBuiltInKey ?? 'workspace template'
        }`}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={DESIGN_STATUS_VARIANT[data.status]}>
              {data.status.replace('_', ' ')}
            </Badge>
            {data.brand ? (
              <Badge variant="muted">{data.brand.name}</Badge>
            ) : (
              <Badge variant="outline">no brand</Badge>
            )}
          </span>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle>Preview</CardTitle>
            {pageCount > 1 ? (
              <span className="flex items-center gap-1">
                {data.layout.pages.map((templatePage, index) => (
                  <Button
                    key={templatePage.id}
                    size="sm"
                    variant={index === page ? 'default' : 'ghost'}
                    onClick={() => setPage(index)}
                  >
                    {index + 1}
                  </Button>
                ))}
              </span>
            ) : null}
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {preview.loading ? (
              <div className="flex h-64 items-center justify-center rounded-md border border-border">
                <Spinner />
              </div>
            ) : preview.error ? (
              <p role="alert" className="text-sm text-destructive">
                {preview.error}
              </p>
            ) : preview.url ? (
              // A blob URL of a real render; next/image cannot optimize one.
              <img
                src={preview.url}
                alt={`${data.name}, page ${page + 1}`}
                className="w-full rounded-md border border-border"
              />
            ) : null}
            {preview.warnings.length > 0 ? (
              <ul className="flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                {preview.warnings.map((warning) => (
                  <li key={warning} className="flex items-start gap-2">
                    <TriangleAlert
                      aria-hidden="true"
                      className="mt-0.5 size-3.5 shrink-0 text-amber-600"
                    />
                    <span className="text-muted-foreground">{warning}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-[11px] text-muted-foreground">
              This preview is the export, rendered at a smaller size — not a mock-up.
            </p>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Content</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {!canWrite ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Lock aria-hidden="true" className="size-3.5 shrink-0" />
                  Editing designs requires the{' '}
                  <code className="rounded bg-muted px-1">design:write</code> permission.
                </p>
              ) : null}
              {fields.map((field) =>
                field.kind === 'TEXT' ? textField(field) : imageField(field),
              )}
              <div>
                <Label htmlFor="design-format">Size</Label>
                <select
                  id="design-format"
                  className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm"
                  disabled={!canWrite}
                  value={data.formatKey}
                  onChange={(event) => void save({ formatKey: event.target.value })}
                >
                  {(formats.data ?? []).map((format) => (
                    <option key={format.key} value={format.key}>
                      {format.label} · {format.width}×{format.height}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="design-brand">Brand</Label>
                <select
                  id="design-brand"
                  className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm"
                  disabled={!canWrite}
                  value={data.brandId ?? ''}
                  onChange={(event) => void save({ brandId: event.target.value || null })}
                >
                  <option value="">No brand (neutral colours)</option>
                  {(brands.data ?? []).map((brand) => (
                    <option key={brand.id} value={brand.id}>
                      {brand.name}
                    </option>
                  ))}
                </select>
              </div>
              {update.isError ? (
                <p role="alert" className="text-xs text-destructive">
                  {update.error.message}
                </p>
              ) : null}
              {canWrite ? (
                <Button onClick={() => void save()} disabled={update.isPending}>
                  {update.isPending ? 'Saving…' : 'Save and re-render preview'}
                </Button>
              ) : null}
              {data.status === 'APPROVED' || data.status === 'IN_REVIEW' ? (
                <p className="text-[11px] text-muted-foreground">
                  Saving a change to the visuals returns this design to draft — an approval covers
                  the files that were reviewed.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Export</CardTitle>
              <p className="text-xs text-muted-foreground">
                Exports are stored in this workspace’s media library, ready to schedule on the
                calendar.
              </p>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {canWrite ? (
                <div className="flex flex-wrap gap-2">
                  {(['PNG', 'JPEG', 'PDF'] as DesignOutputFormat[]).map((output) => (
                    <Button
                      key={output}
                      size="sm"
                      variant="outline"
                      disabled={exportDesign.isPending}
                      onClick={() => exportDesign.mutate({ outputFormat: output })}
                    >
                      Export {output}
                    </Button>
                  ))}
                </div>
              ) : null}
              {exportDesign.isError ? (
                <p role="alert" className="text-xs text-destructive">
                  {exportDesign.error.message}
                </p>
              ) : null}
              {exportDesign.data?.reused ? (
                <p className="text-xs text-muted-foreground">
                  Nothing changed since the last export, so the same files were returned.
                </p>
              ) : null}
              {data.renders.length === 0 ? (
                <p className="text-sm text-muted-foreground">No exports yet.</p>
              ) : (
                <ul className="flex flex-col gap-2 text-xs">
                  {data.renders.map((render) => (
                    <li
                      key={render.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2"
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">{render.outputFormat}</Badge>
                        <span className="text-muted-foreground">
                          {render.pageIndex === null
                            ? `${render.pageCount} pages`
                            : `page ${render.pageIndex + 1}`}{' '}
                          · {render.widthPx}×{render.heightPx} ·{' '}
                          {formatBytes(render.mediaAsset.sizeBytes)}
                        </span>
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          const link = await renderUrl.mutateAsync(render.id);
                          window.open(link.url, '_blank', 'noopener,noreferrer');
                        }}
                      >
                        <Download aria-hidden="true" className="size-3.5" /> Open
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Review</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-xs">
              <p className="text-muted-foreground">
                Only an approved design can be scheduled on the calendar. Publishing a post that
                uses an export marks the design published.
              </p>
              {data.reviewNote ? (
                <p className="text-muted-foreground">Note: {data.reviewNote}</p>
              ) : null}
              {workflow.isError ? (
                <p role="alert" className="text-destructive">
                  {workflow.error.message}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {canWrite && data.status === 'DRAFT' ? (
                  <Button
                    size="sm"
                    disabled={workflow.isPending}
                    onClick={() => workflow.mutate({ action: 'submit' })}
                  >
                    Submit for review
                  </Button>
                ) : null}
                {canApprove && data.status === 'IN_REVIEW' ? (
                  <Button
                    size="sm"
                    disabled={workflow.isPending}
                    onClick={() => workflow.mutate({ action: 'approve' })}
                  >
                    Approve
                  </Button>
                ) : null}
                {canApprove && (data.status === 'IN_REVIEW' || data.status === 'APPROVED') ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={workflow.isPending}
                    onClick={() =>
                      workflow.mutate({ action: 'request-changes', note: 'Changes requested.' })
                    }
                  >
                    Request changes
                  </Button>
                ) : null}
                {!canApprove && data.status === 'IN_REVIEW' ? (
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <Lock aria-hidden="true" className="size-3.5 shrink-0" />
                    Approving needs <code className="rounded bg-muted px-1">content:approve</code>.
                  </span>
                ) : null}
              </div>
              {data.contentItem ? (
                <p className="text-muted-foreground">
                  Attached to content: <span className="font-medium">{data.contentItem.title}</span>
                </p>
              ) : null}
              {data.campaign ? (
                <p className="text-muted-foreground">
                  Campaign: <span className="font-medium">{data.campaign.name}</span>
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
