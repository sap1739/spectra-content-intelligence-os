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
import { Image as ImageIcon, Info, Lock, Palette } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { usePermissions, useWorkspace } from '@/lib/auth';
import { useBrands } from '@/lib/brands';
import {
  DESIGN_STATUS_VARIANT,
  useCreateDesign,
  useDesignFormats,
  useDesignTemplates,
  useDesigns,
  useStudioCapabilities,
  type TemplateSummary,
} from '@/lib/studio';

/**
 * Design studio gallery (Phase 7A, ADR-0040): the templates that exist, the
 * designs made from them, and one honest sentence about what the renderer is —
 * local rendering of your own images and brand kit, not image generation.
 */
export default function StudioPage() {
  const router = useRouter();
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;
  const { can } = usePermissions();
  const canWrite = can('design:write');

  const capabilities = useStudioCapabilities(workspaceId);
  const templates = useDesignTemplates(workspaceId);
  const formats = useDesignFormats(workspaceId);
  const designs = useDesigns(workspaceId);
  const brands = useBrands(workspaceId);
  const create = useCreateDesign(workspaceId);

  const [selected, setSelected] = React.useState<TemplateSummary | null>(null);
  const [name, setName] = React.useState('');
  const [formatKey, setFormatKey] = React.useState('');
  const [brandId, setBrandId] = React.useState('');

  const all = [...(templates.data?.workspace ?? []), ...(templates.data?.builtIn ?? [])];
  const formatLabel = (key: string) =>
    formats.data?.find((format) => format.key === key)?.label ?? key;

  function choose(template: TemplateSummary) {
    setSelected(template);
    setName(template.name);
    setFormatKey(template.defaultFormat);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    const design = await create.mutateAsync({
      name: name.trim() || selected.name,
      template:
        selected.source === 'BUILT_IN'
          ? { builtInKey: selected.key as string }
          : { templateId: selected.id as string },
      formatKey,
      ...(brandId ? { brandId } : {}),
      values: {},
      images: {},
    });
    router.push(`/studio/${design.id}`);
  }

  return (
    <>
      <PageHeader
        title="Design Studio"
        description="Flyers, posters, social images, carousels and thumbnails — rendered locally from a template, your brand kit and your own images."
      />

      {capabilities.data ? (
        <Card className="mb-6">
          <CardContent className="flex items-start gap-3 py-4 text-sm">
            <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div>
              <p className="font-medium">Real rendering, no image generation</p>
              <p className="text-muted-foreground">{capabilities.data.note}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Engine {capabilities.data.engine} {capabilities.data.engineVersion} · exports{' '}
                {capabilities.data.outputs.join(', ')} · {capabilities.data.pdf}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Templates</CardTitle>
            <p className="text-xs text-muted-foreground">
              Pick a template to start a design. Built-in templates are read-only; a workspace copy
              can be edited through the API.
            </p>
          </CardHeader>
          <CardContent>
            {templates.isPending ? (
              <Skeleton className="h-40 w-full" />
            ) : templates.isError ? (
              <EmptyState
                icon={<Palette />}
                title="Could not load templates"
                description={templates.error.message}
              />
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2">
                {all.map((template) => (
                  <li key={template.key ?? template.id}>
                    <button
                      type="button"
                      onClick={() => choose(template)}
                      disabled={!canWrite}
                      className={cn(
                        'w-full rounded-md border p-3 text-left transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60',
                        selected && (selected.key ?? selected.id) === (template.key ?? template.id)
                          ? 'border-border bg-accent'
                          : 'border-border hover:bg-accent/60',
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-medium">{template.name}</span>
                        <Badge variant={template.source === 'BUILT_IN' ? 'muted' : 'secondary'}>
                          {template.source === 'BUILT_IN' ? 'built-in' : 'workspace'}
                        </Badge>
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {template.description}
                      </span>
                      <span className="mt-2 flex flex-wrap gap-1">
                        <Badge variant="outline">
                          {template.category.toLowerCase().replace('_', ' ')}
                        </Badge>
                        <Badge variant="outline">
                          {template.layout.pages.length} page
                          {template.layout.pages.length > 1 ? 's' : ''}
                        </Badge>
                        <Badge variant="outline">{template.layout.fields.length} fields</Badge>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>New design</CardTitle>
          </CardHeader>
          <CardContent>
            {!canWrite ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Lock aria-hidden="true" className="size-3.5 shrink-0" />
                Creating designs requires the{' '}
                <code className="rounded bg-muted px-1">design:write</code> permission.
              </p>
            ) : !selected ? (
              <p className="text-sm text-muted-foreground">Choose a template to start.</p>
            ) : (
              <form className="flex flex-col gap-3" onSubmit={submit}>
                <div>
                  <Label htmlFor="design-name">Name</Label>
                  <Input
                    id="design-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={120}
                  />
                </div>
                <div>
                  <Label htmlFor="design-format">Size</Label>
                  <select
                    id="design-format"
                    className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm"
                    value={formatKey}
                    onChange={(event) => setFormatKey(event.target.value)}
                  >
                    {selected.formats.map((key) => (
                      <option key={key} value={key}>
                        {formatLabel(key)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="design-brand">Brand</Label>
                  <select
                    id="design-brand"
                    className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm"
                    value={brandId}
                    onChange={(event) => setBrandId(event.target.value)}
                  >
                    <option value="">No brand (neutral colours)</option>
                    {(brands.data ?? []).map((brand) => (
                      <option key={brand.id} value={brand.id}>
                        {brand.name}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Colours, logo, fonts and product details come from the brand kit on Brands.
                  </p>
                </div>
                {create.isError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {create.error.message}
                  </p>
                ) : null}
                <Button type="submit" disabled={create.isPending}>
                  {create.isPending ? 'Creating…' : 'Create design'}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Designs</CardTitle>
        </CardHeader>
        <CardContent>
          {designs.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : designs.isError ? (
            <EmptyState
              icon={<ImageIcon />}
              title="Could not load designs"
              description={designs.error.message}
            />
          ) : designs.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No designs yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {designs.data.map((design) => (
                <li key={design.id} className="rounded-md border border-border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      className="font-medium underline underline-offset-2"
                      href={`/studio/${design.id}`}
                    >
                      {design.name}
                    </Link>
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge variant={DESIGN_STATUS_VARIANT[design.status]}>
                        {design.status.replace('_', ' ')}
                      </Badge>
                      <Badge variant="outline">{formatLabel(design.formatKey)}</Badge>
                      {design.brand ? <Badge variant="muted">{design.brand.name}</Badge> : null}
                      <span className="text-xs text-muted-foreground">
                        {design.renders.length} export{design.renders.length === 1 ? '' : 's'}
                      </span>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
