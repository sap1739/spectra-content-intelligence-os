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
import { Layers, Lock } from 'lucide-react';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { usePermissions, useWorkspace } from '@/lib/auth';
import {
  useArchiveBrand,
  useBrands,
  useCreateBrand,
  useUpdateBrand,
  type BrandRow,
} from '@/lib/brands';

const STATUS_VARIANT: Record<BrandRow['status'], 'success' | 'warning' | 'muted'> = {
  ACTIVE: 'success',
  DRAFT: 'warning',
  ARCHIVED: 'muted',
};

interface BrandFormValues {
  name: string;
  description: string;
  websiteUrl: string;
  tone: string;
  doNots: string;
}

const EMPTY_FORM: BrandFormValues = {
  name: '',
  description: '',
  websiteUrl: '',
  tone: '',
  doNots: '',
};

function toFormValues(brand: BrandRow): BrandFormValues {
  return {
    name: brand.name,
    description: brand.description ?? '',
    websiteUrl: brand.websiteUrl ?? '',
    tone: (brand.voice?.tone ?? []).join(', '),
    doNots: (brand.voice?.doNots ?? []).join(', '),
  };
}

/** Splits a comma-separated field into trimmed, non-empty entries. */
function toList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Brand create/edit form.
 *
 * `voice` is sent only when the operator actually filled something in — an
 * empty object would record "we defined a voice with nothing in it", which is
 * different from having defined none.
 */
function BrandForm({
  workspaceId,
  editing,
  onDone,
}: {
  workspaceId: string;
  editing: BrandRow | null;
  onDone: () => void;
}) {
  const create = useCreateBrand(workspaceId);
  const update = useUpdateBrand(workspaceId);
  const [values, setValues] = React.useState<BrandFormValues>(
    editing ? toFormValues(editing) : EMPTY_FORM,
  );
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setValues(editing ? toFormValues(editing) : EMPTY_FORM);
    setError(null);
  }, [editing]);

  const pending = create.isPending || update.isPending;
  const mutationError = create.error?.message ?? update.error?.message ?? null;

  const set = (key: keyof BrandFormValues) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const name = values.name.trim();
    if (!name) {
      setError('A brand name is required.');
      return;
    }
    const website = values.websiteUrl.trim();
    if (website && !/^https?:\/\/.+/i.test(website)) {
      setError('The website must be a full http(s) URL.');
      return;
    }

    const tone = toList(values.tone);
    const doNots = toList(values.doNots);
    const payload = {
      name,
      ...(values.description.trim() ? { description: values.description.trim() } : {}),
      ...(website ? { websiteUrl: website } : {}),
      // Send the full voice shape. Empty arrays are accurate — the operator
      // supplied none — and differ from omitting `voice`, which means no voice
      // was defined at all.
      ...(tone.length > 0 || doNots.length > 0
        ? { voice: { tone, doNots, examplePhrases: [] } }
        : {}),
    };

    try {
      if (editing) {
        await update.mutateAsync({ id: editing.id, input: payload });
      } else {
        await create.mutateAsync(payload);
      }
      setValues(EMPTY_FORM);
      onDone();
    } catch {
      // The mutation error is rendered below; nothing to add here.
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{editing ? `Edit ${editing.name}` : 'Create a brand'}</CardTitle>
        <p className="text-xs text-muted-foreground">
          Brand voice steers generation: tone and do-nots are passed to the model as trusted
          guidance.
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="brand-name">Name</Label>
            <Input
              id="brand-name"
              value={values.name}
              onChange={set('name')}
              placeholder="Acme Cloud"
              required
              aria-describedby={error ? 'brand-form-error' : undefined}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="brand-description">Description</Label>
            <Input
              id="brand-description"
              value={values.description}
              onChange={set('description')}
              placeholder="What this brand is for"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="brand-website">Website</Label>
            <Input
              id="brand-website"
              type="url"
              value={values.websiteUrl}
              onChange={set('websiteUrl')}
              placeholder="https://acme.example.com"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="brand-tone">Tone (comma separated)</Label>
            <Input
              id="brand-tone"
              value={values.tone}
              onChange={set('tone')}
              placeholder="pragmatic, precise, warm"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="brand-donots">Do-nots (comma separated)</Label>
            <Input
              id="brand-donots"
              value={values.doNots}
              onChange={set('doNots')}
              placeholder="no hype, no emoji"
            />
          </div>

          {(error ?? mutationError) ? (
            <p id="brand-form-error" role="alert" className="text-xs text-destructive">
              {error ?? mutationError}
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button type="submit" disabled={pending || !values.name.trim()}>
              {pending ? 'Saving…' : editing ? 'Save changes' : 'Create brand'}
            </Button>
            {editing ? (
              <Button type="button" variant="outline" onClick={onDone}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function BrandDetail({ brand }: { brand: BrandRow }) {
  const tone = brand.voice?.tone ?? [];
  const doNots = brand.voice?.doNots ?? [];
  return (
    <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2 text-xs">
      {brand.description ? <p className="text-muted-foreground">{brand.description}</p> : null}
      {brand.websiteUrl ? (
        <a
          href={brand.websiteUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="w-fit text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {brand.websiteUrl}
        </a>
      ) : null}
      <dl className="mt-1 flex flex-col gap-1">
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-muted-foreground">Tone</dt>
          {/* A dash, never an invented default, when nothing was defined. */}
          <dd>{tone.length > 0 ? tone.join(', ') : '—'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-muted-foreground">Do-nots</dt>
          <dd>{doNots.length > 0 ? doNots.join(', ') : '—'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-muted-foreground">Languages</dt>
          <dd>{brand.languages.length > 0 ? brand.languages.join(', ') : '—'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-muted-foreground">Updated</dt>
          <dd>{new Date(brand.updatedAt).toISOString().slice(0, 10)}</dd>
        </div>
      </dl>
    </div>
  );
}

export default function BrandsPage() {
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;
  // Permission, not role name (CLAUDE.md). The API re-checks every request.
  const { can } = usePermissions();
  const canWrite = can('brand:write');

  const brands = useBrands(workspaceId);
  const archive = useArchiveBrand(workspaceId);

  const [editing, setEditing] = React.useState<BrandRow | null>(null);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [confirmingId, setConfirmingId] = React.useState<string | null>(null);

  const rows = brands.data ?? [];

  return (
    <>
      <PageHeader
        title="Brands"
        description="Brand profiles: voice, tone and do-nots that steer research relevance and generated content. Scoped to this workspace."
      />

      {!canWrite ? (
        <Card className="mb-6">
          <CardContent className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <Lock aria-hidden="true" className="size-4 shrink-0" />
            You have read-only access to brands. Editing requires the{' '}
            <code className="rounded bg-muted px-1">brand:write</code> permission.
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        {canWrite ? (
          <BrandForm workspaceId={workspaceId} editing={editing} onDone={() => setEditing(null)} />
        ) : null}

        <Card className={canWrite ? undefined : 'lg:col-span-2'}>
          <CardHeader>
            <CardTitle>Brands</CardTitle>
          </CardHeader>
          <CardContent>
            {brands.isPending ? (
              <Skeleton className="h-24 w-full" />
            ) : brands.isError ? (
              <EmptyState
                icon={<Layers />}
                title="Could not load brands"
                description={brands.error.message}
              />
            ) : rows.length === 0 ? (
              <EmptyState
                icon={<Layers />}
                title="No brands yet"
                description={
                  canWrite
                    ? 'Create a brand to give generated content a consistent voice.'
                    : 'No brands have been created in this workspace.'
                }
              />
            ) : (
              <ul className="flex flex-col gap-3">
                {rows.map((brand) => {
                  const open = expandedId === brand.id;
                  return (
                    <li key={brand.id} className="rounded-md border border-border p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => setExpandedId(open ? null : brand.id)}
                          aria-expanded={open}
                          aria-controls={`brand-detail-${brand.id}`}
                          className="rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="text-sm font-medium">{brand.name}</span>
                          <span className="ml-2 text-xs text-muted-foreground">{brand.slug}</span>
                        </button>
                        <span className="flex items-center gap-2">
                          <Badge variant={STATUS_VARIANT[brand.status]}>
                            {brand.status.toLowerCase()}
                          </Badge>
                          {canWrite ? (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setEditing(brand)}
                                aria-label={`Edit ${brand.name}`}
                              >
                                Edit
                              </Button>
                              {brand.status !== 'ARCHIVED' ? (
                                confirmingId === brand.id ? (
                                  <span className="flex items-center gap-1">
                                    <Button
                                      size="sm"
                                      variant="destructive"
                                      disabled={archive.isPending}
                                      onClick={async () => {
                                        await archive.mutateAsync(brand.id);
                                        setConfirmingId(null);
                                        if (editing?.id === brand.id) setEditing(null);
                                      }}
                                    >
                                      Confirm archive
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => setConfirmingId(null)}
                                    >
                                      Cancel
                                    </Button>
                                  </span>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setConfirmingId(brand.id)}
                                    aria-label={`Archive ${brand.name}`}
                                  >
                                    {/* "Archive", not "Delete": the API
                                        soft-deletes so content lineage survives. */}
                                    Archive
                                  </Button>
                                )
                              ) : null}
                            </>
                          ) : null}
                        </span>
                      </div>
                      {open ? (
                        <div id={`brand-detail-${brand.id}`}>
                          <BrandDetail brand={brand} />
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {archive.isError ? (
              <p role="alert" className="mt-3 text-xs text-destructive">
                {archive.error.message}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
