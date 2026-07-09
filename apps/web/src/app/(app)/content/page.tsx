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
import { FileText, Sparkles, TriangleAlert } from 'lucide-react';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { useWorkspace } from '@/lib/auth';
import {
  useAiStatus,
  useContentItem,
  useContentItems,
  useCreateContentItem,
  useGenerateDraft,
  useWorkspaceEvidencePacks,
  type ContentDraftRow,
} from '@/lib/content';

const CONTENT_TYPES = [
  'POST',
  'ARTICLE',
  'THREAD',
  'VIDEO_SCRIPT',
  'SHORT_VIDEO',
  'CAROUSEL',
  'EMAIL',
  'OTHER',
] as const;

const fieldClass = cn(
  'w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm shadow-sm',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
);

const DRAFT_STATUS_VARIANT: Record<string, 'success' | 'warning' | 'destructive'> = {
  READY: 'success',
  GENERATING: 'warning',
  FAILED: 'destructive',
};

function DraftCard({ draft }: { draft: ContentDraftRow }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <Badge variant={DRAFT_STATUS_VARIANT[draft.status] ?? 'muted'}>{draft.status}</Badge>
        <span className="text-[11px] text-muted-foreground">
          {new Date(draft.createdAt).toLocaleString()}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {draft.status === 'GENERATING' ? (
          <p className="text-sm text-muted-foreground">Generating a grounded draft…</p>
        ) : draft.status === 'FAILED' ? (
          <p role="alert" className="text-sm text-destructive">
            {draft.failureReason ?? 'Generation failed.'}
          </p>
        ) : (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{draft.body}</p>
        )}

        {draft.citationValidation ? (
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <Badge variant={draft.citationValidation.allCitedSupported ? 'success' : 'destructive'}>
              {draft.citationValidation.supportedMarkers.length}/
              {draft.citationValidation.markersFound} citation markers verified
            </Badge>
            {draft.citationValidation.unsupportedMarkers.length > 0 ? (
              <span className="text-destructive">
                {draft.citationValidation.unsupportedMarkers.length} unsupported marker(s):{' '}
                {draft.citationValidation.unsupportedMarkers.map((n) => `[${n}]`).join(' ')} — not
                backed by a supplied source.
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2 text-[11px] text-muted-foreground">
          <span>
            Grounded on {draft.citationIds.length} citation(s) · {draft.findingIds.length}{' '}
            finding(s)
          </span>
          {draft.modelProvider ? (
            <span>
              {draft.modelProvider}/{draft.modelName}
              {draft.promptVersion ? ` · prompt ${draft.promptVersion}` : ''}
            </span>
          ) : null}
          {draft.usageOutputTokens != null ? (
            <span>
              {draft.usageInputTokens ?? 0} in / {draft.usageOutputTokens} out tokens
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function ItemDetail({ workspaceId, itemId }: { workspaceId: string; itemId: string }) {
  const item = useContentItem(workspaceId, itemId);
  const generate = useGenerateDraft(workspaceId, itemId);
  const aiStatus = useAiStatus(workspaceId);
  const configured = aiStatus.data?.configured ?? false;

  if (item.isPending) return <Skeleton className="h-64 w-full" />;
  if (item.isError) {
    return (
      <EmptyState
        icon={<FileText />}
        title="Could not load item"
        description={item.error.message}
      />
    );
  }

  const data = item.data;
  const canGenerate = configured && Boolean(data.evidencePackId);
  const generateHint = !configured
    ? 'AI generation is not configured'
    : !data.evidencePackId
      ? 'Attach an evidence pack to ground the draft'
      : undefined;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <CardTitle>{data.title}</CardTitle>
            <Badge variant="secondary">{data.lifecycleState}</Badge>
          </div>
          <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>{data.contentType}</span>
            {data.funnelStage ? <span>· {data.funnelStage}</span> : null}
            {data.topicKey ? <span>· topic: {data.topicKey}</span> : null}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {data.objective ? (
            <p className="text-sm text-muted-foreground">{data.objective}</p>
          ) : null}
          {data.evidencePackId ? (
            <p className="text-xs text-muted-foreground">
              Grounded on an evidence pack: {data.findingIds.length} finding(s),{' '}
              {data.citationIds.length} citation(s).
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Not grounded on research. Attach an evidence pack when creating an item to enable
              cited drafting.
            </p>
          )}
          <div>
            <Button
              disabled={!canGenerate || generate.isPending}
              title={generateHint}
              onClick={() => generate.mutate({})}
            >
              <Sparkles aria-hidden="true" />
              {generate.isPending ? 'Generating…' : 'Generate cited draft'}
            </Button>
          </div>
          {generate.isError ? (
            <p role="alert" className="text-xs text-destructive">
              {generate.error.message}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {(data.drafts ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No drafts yet. {canGenerate ? 'Generate one above.' : generateHint}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {(data.drafts ?? []).map((draft) => (
            <li key={draft.id}>
              <DraftCard draft={draft} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ContentStudioPage() {
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;

  const items = useContentItems(workspaceId);
  const create = useCreateContentItem(workspaceId);
  const aiStatus = useAiStatus(workspaceId);
  const packs = useWorkspaceEvidencePacks(workspaceId);

  const [title, setTitle] = React.useState('');
  const [contentType, setContentType] = React.useState<string>('POST');
  const [objective, setObjective] = React.useState('');
  const [evidencePackId, setEvidencePackId] = React.useState('');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    const item = await create.mutateAsync({
      title: title.trim(),
      contentType: contentType as never,
      ...(objective.trim() ? { objective: objective.trim() } : {}),
      ...(evidencePackId ? { evidencePackId } : {}),
    });
    setTitle('');
    setObjective('');
    setEvidencePackId('');
    setSelectedId(item.id);
  };

  return (
    <>
      <PageHeader
        title="Content Studio"
        description="Draft content grounded in your research evidence. Every draft records the exact citations it was built on — nothing is fabricated."
      />

      {aiStatus.data && !aiStatus.data.configured ? (
        <Card className="mb-6 border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-start gap-3 py-4">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-amber-600" />
            <div className="text-sm">
              <p className="font-medium">AI generation is not configured</p>
              <p className="text-muted-foreground">
                Set <code className="rounded bg-muted px-1">ANTHROPIC_API_KEY</code> on the API to
                enable drafting. You can still create and organize content items — generation stays
                disabled until a provider is configured.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : aiStatus.data?.configured ? (
        <p className="mb-6 text-xs text-muted-foreground">
          Generation ready · {aiStatus.data.provider}/{aiStatus.data.model}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>New content item</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="ci-title">Title</Label>
                  <Input
                    id="ci-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Why enterprises are adopting AI testing"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="ci-type">Content type</Label>
                  <select
                    id="ci-type"
                    className={fieldClass}
                    value={contentType}
                    onChange={(e) => setContentType(e.target.value)}
                  >
                    {CONTENT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="ci-objective">Objective (optional)</Label>
                  <textarea
                    id="ci-objective"
                    className={cn(fieldClass, 'min-h-16 resize-y')}
                    value={objective}
                    onChange={(e) => setObjective(e.target.value)}
                    placeholder="What should this piece achieve?"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="ci-pack">Ground on evidence pack</Label>
                  <select
                    id="ci-pack"
                    className={fieldClass}
                    value={evidencePackId}
                    onChange={(e) => setEvidencePackId(e.target.value)}
                  >
                    <option value="">None (ungrounded — cannot generate)</option>
                    {(packs.data ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title} ({p.citationIds.length} citations)
                      </option>
                    ))}
                  </select>
                  {(packs.data ?? []).length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">
                      No READY evidence packs yet. Run research to build one.
                    </p>
                  ) : null}
                </div>
                {create.isError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {create.error.message}
                  </p>
                ) : null}
                <Button type="submit" disabled={create.isPending || !title.trim()}>
                  {create.isPending ? 'Creating…' : 'Create content item'}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Content items</CardTitle>
            </CardHeader>
            <CardContent>
              {items.isPending ? (
                <Skeleton className="h-24 w-full" />
              ) : items.isError ? (
                <EmptyState
                  icon={<FileText />}
                  title="Could not load content"
                  description={items.error.message}
                />
              ) : items.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No content items yet. Create one to start drafting.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {items.data.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(item.id)}
                        className={cn(
                          'w-full rounded-md border border-transparent px-2.5 py-2 text-left text-sm transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          selectedId === item.id ? 'border-border bg-accent' : 'hover:bg-accent/60',
                        )}
                      >
                        <span className="block truncate font-medium">{item.title}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {item.contentType} · {item.lifecycleState}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div>
          {selectedId ? (
            <ItemDetail workspaceId={workspaceId} itemId={selectedId} />
          ) : (
            <EmptyState
              icon={<FileText />}
              title="Select a content item"
              description="Pick an item on the left to view its drafts and generate a cited draft grounded in your research evidence."
            />
          )}
        </div>
      </div>
    </>
  );
}
