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
import { ArrowRight, FlaskConical, Plus, X } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { useForm } from 'react-hook-form';

import { PageHeader } from '@/components/page-header';
import { useWorkspace } from '@/lib/auth';
import { useCreateResearchProject, useResearchProjects } from '@/lib/research';
import { useVerticals } from '@/lib/verticals';

const projectFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(300),
  objective: z.string().max(5000).optional(),
  verticalId: z.string().uuid().optional().or(z.literal('')),
});
type ProjectFormValues = z.infer<typeof projectFormSchema>;

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'muted' | 'warning'> = {
  ACTIVE: 'success',
  DRAFT: 'secondary',
  PAUSED: 'warning',
  COMPLETED: 'muted',
  ARCHIVED: 'muted',
};

export default function ResearchPage() {
  const { activeWorkspace } = useWorkspace();
  const projects = useResearchProjects(activeWorkspace.id);
  const verticals = useVerticals(activeWorkspace.id);
  const createProject = useCreateResearchProject(activeWorkspace.id);
  const [showForm, setShowForm] = React.useState(false);

  const form = useForm<ProjectFormValues>({
    resolver: zodResolver(projectFormSchema),
    defaultValues: { name: '', verticalId: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    await createProject.mutateAsync({
      name: values.name,
      objective: values.objective || undefined,
      verticalId: values.verticalId || undefined,
    });
    form.reset({ name: '', verticalId: '' });
    setShowForm(false);
  });

  return (
    <>
      <PageHeader
        title="Research"
        description="Research projects monitor the RSS/Atom feeds you choose and turn them into validated, cited findings."
        actions={
          <Button onClick={() => setShowForm((v) => !v)} aria-expanded={showForm}>
            {showForm ? <X aria-hidden="true" /> : <Plus aria-hidden="true" />}
            {showForm ? 'Cancel' : 'New research project'}
          </Button>
        }
      />

      {showForm ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Create a research project</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="p-name">Name *</Label>
                <Input
                  id="p-name"
                  placeholder="e.g. AI quality engineering — landscape scan"
                  aria-invalid={!!form.formState.errors.name}
                  {...form.register('name')}
                />
                {form.formState.errors.name ? (
                  <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="p-objective">Objective</Label>
                <Input
                  id="p-objective"
                  placeholder="What should this research answer?"
                  {...form.register('objective')}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="p-vertical">Vertical (steers topics & source trust)</Label>
                <select
                  id="p-vertical"
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  {...form.register('verticalId')}
                >
                  <option value="">No vertical</option>
                  {(verticals.data ?? []).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </div>
              {createProject.isError ? (
                <p role="alert" className="text-xs text-destructive sm:col-span-2">
                  {createProject.error.message}
                </p>
              ) : null}
              <div className="sm:col-span-2">
                <Button type="submit" disabled={createProject.isPending}>
                  {createProject.isPending ? 'Creating…' : 'Create project'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {projects.isPending ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : projects.isError ? (
        <EmptyState
          icon={<FlaskConical />}
          title="Could not load research projects"
          description={projects.error.message}
          action={
            <Button variant="outline" onClick={() => projects.refetch()}>
              Retry
            </Button>
          }
        />
      ) : projects.data.length === 0 ? (
        <EmptyState
          icon={<FlaskConical />}
          title="No research projects yet"
          description="Create a project, point it at the RSS/Atom feeds of publications you trust, and run it. Findings arrive with full provenance — source, publication date, retrieval date, credibility and freshness."
          action={
            <Button onClick={() => setShowForm(true)}>
              <Plus aria-hidden="true" /> New research project
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {projects.data.map((project) => (
            <li key={project.id}>
              <Card>
                <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
                  <CardTitle>{project.name}</CardTitle>
                  <Badge variant={STATUS_VARIANT[project.status] ?? 'muted'}>
                    {project.status}
                  </Badge>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {project.objective ? (
                    <p className="line-clamp-2 text-sm text-muted-foreground">
                      {project.objective}
                    </p>
                  ) : null}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      Created {new Date(project.createdAt).toLocaleDateString()}
                    </span>
                    <Link
                      href={`/research/${project.id}`}
                      className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                    >
                      Open <ArrowRight aria-hidden="true" className="size-3.5" />
                    </Link>
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
