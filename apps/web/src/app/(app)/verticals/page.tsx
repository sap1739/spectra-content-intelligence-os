'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
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
import { Boxes, Plus, X } from 'lucide-react';
import * as React from 'react';
import { useForm } from 'react-hook-form';

import { PageHeader } from '@/components/page-header';
import { useWorkspace } from '@/lib/auth';
import { useArchiveVertical, useCreateVertical, useVerticals } from '@/lib/verticals';

/** Form shape: list fields captured as comma-separated text, split on submit. */
const verticalFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  industry: z.string().max(200).optional(),
  description: z.string().max(5000).optional(),
  keywords: z.string().max(2000).optional(),
  geographies: z.string().max(1000).optional(),
  languages: z.string().max(500).optional(),
});
type VerticalFormValues = z.infer<typeof verticalFormSchema>;

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export default function VerticalsPage() {
  const { activeWorkspace } = useWorkspace();
  const verticals = useVerticals(activeWorkspace.id);
  const createVertical = useCreateVertical(activeWorkspace.id);
  const archiveVertical = useArchiveVertical(activeWorkspace.id);
  const [showForm, setShowForm] = React.useState(false);

  const form = useForm<VerticalFormValues>({
    resolver: zodResolver(verticalFormSchema),
    defaultValues: { name: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    await createVertical.mutateAsync({
      name: values.name,
      industry: values.industry || undefined,
      description: values.description || undefined,
      keywords: splitList(values.keywords),
      geographies: splitList(values.geographies),
      languages: splitList(values.languages),
    });
    form.reset({ name: '' });
    setShowForm(false);
  });

  return (
    <>
      <PageHeader
        title="Verticals"
        description={`User-defined market niches steering research for “${activeWorkspace.name}”. No industry list is hard-coded.`}
        actions={
          <Button onClick={() => setShowForm((v) => !v)} aria-expanded={showForm}>
            {showForm ? <X aria-hidden="true" /> : <Plus aria-hidden="true" />}
            {showForm ? 'Cancel' : 'New vertical'}
          </Button>
        }
      />

      {showForm ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Create a custom vertical</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="v-name">Name *</Label>
                <Input
                  id="v-name"
                  placeholder="e.g. AI-powered software testing"
                  aria-invalid={!!form.formState.errors.name}
                  {...form.register('name')}
                />
                {form.formState.errors.name ? (
                  <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="v-industry">Industry (free text)</Label>
                <Input
                  id="v-industry"
                  placeholder="e.g. Quality engineering"
                  {...form.register('industry')}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="v-keywords">Keywords (comma-separated)</Label>
                <Input
                  id="v-keywords"
                  placeholder="AI testing, test automation"
                  {...form.register('keywords')}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="v-geographies">Geographies (comma-separated)</Label>
                <Input
                  id="v-geographies"
                  placeholder="India, Global"
                  {...form.register('geographies')}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="v-languages">Languages (comma-separated)</Label>
                <Input id="v-languages" placeholder="en, bn, hi" {...form.register('languages')} />
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="v-description">Description</Label>
                <Input
                  id="v-description"
                  placeholder="What this niche covers and why it matters to you"
                  {...form.register('description')}
                />
              </div>
              {createVertical.isError ? (
                <p role="alert" className="text-xs text-destructive sm:col-span-2">
                  {createVertical.error.message}
                </p>
              ) : null}
              <div className="sm:col-span-2">
                <Button type="submit" disabled={createVertical.isPending}>
                  {createVertical.isPending ? 'Creating…' : 'Create vertical'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {verticals.isPending ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : verticals.isError ? (
        <EmptyState
          icon={<Boxes />}
          title="Could not load verticals"
          description={verticals.error.message}
          action={
            <Button variant="outline" onClick={() => verticals.refetch()}>
              Retry
            </Button>
          }
        />
      ) : verticals.data.length === 0 ? (
        <EmptyState
          icon={<Boxes />}
          title="No custom verticals yet"
          description="A vertical captures the niche you want researched — audiences, keywords, geographies, languages, trusted sources. Create your first one to steer future research runs."
          action={
            <Button onClick={() => setShowForm(true)}>
              <Plus aria-hidden="true" /> New vertical
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {verticals.data.map((vertical) => (
            <li key={vertical.id}>
              <Card>
                <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
                  <div>
                    <CardTitle>{vertical.name}</CardTitle>
                    {vertical.industry ? (
                      <p className="mt-1 text-xs text-muted-foreground">{vertical.industry}</p>
                    ) : null}
                  </div>
                  <Badge variant={vertical.status === 'ACTIVE' ? 'success' : 'muted'}>
                    {vertical.status}
                  </Badge>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {vertical.description ? (
                    <p className="text-sm text-muted-foreground">{vertical.description}</p>
                  ) : null}
                  {vertical.keywords.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {vertical.keywords.slice(0, 6).map((keyword) => (
                        <Badge key={keyword} variant="secondary">
                          {keyword}
                        </Badge>
                      ))}
                      {vertical.keywords.length > 6 ? (
                        <Badge variant="outline">+{vertical.keywords.length - 6} more</Badge>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      Created {new Date(vertical.createdAt).toLocaleDateString()} ·{' '}
                      {vertical.languages.length > 0
                        ? vertical.languages.join(', ')
                        : 'no languages set'}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={archiveVertical.isPending}
                      onClick={() => archiveVertical.mutate(vertical.id)}
                      aria-label={`Archive ${vertical.name}`}
                    >
                      Archive
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
