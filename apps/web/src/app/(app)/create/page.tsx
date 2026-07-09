'use client';

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Skeleton,
  cn,
} from '@spectra/ui';
import { X } from 'lucide-react';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { useWorkspace } from '@/lib/auth';
import {
  useCreatePersona,
  useCreatePillar,
  useCreateTopicIdea,
  useDeletePersona,
  useDeletePillar,
  useDeleteTopicIdea,
  usePersonas,
  usePillars,
  useSetTopicStatus,
  useTopicIdeas,
} from '@/lib/strategy';

const fieldClass = cn(
  'w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm shadow-sm',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
);

const csv = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const TOPIC_STATUSES = ['PROPOSED', 'SHORTLISTED', 'IN_USE', 'DISCARDED'] as const;
const TOPIC_VARIANT: Record<string, 'secondary' | 'success' | 'warning' | 'muted'> = {
  PROPOSED: 'secondary',
  SHORTLISTED: 'warning',
  IN_USE: 'success',
  DISCARDED: 'muted',
};

function DeleteButton({
  label,
  pending,
  onClick,
}: {
  label: string;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <Button variant="ghost" size="icon" aria-label={label} disabled={pending} onClick={onClick}>
      <X aria-hidden="true" />
    </Button>
  );
}

function PersonasCard({ workspaceId }: { workspaceId: string }) {
  const personas = usePersonas(workspaceId);
  const create = useCreatePersona(workspaceId);
  const remove = useDeletePersona(workspaceId);
  const [name, setName] = React.useState('');
  const [roles, setRoles] = React.useState('');
  const [painPoints, setPainPoints] = React.useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await create.mutateAsync({
      name: name.trim(),
      roles: csv(roles),
      painPoints: csv(painPoints),
      industries: [],
      goals: [],
      preferredPlatforms: [],
      languages: [],
    });
    setName('');
    setRoles('');
    setPainPoints('');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audience personas</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form onSubmit={submit} className="flex flex-col gap-2">
          <Input
            placeholder="Persona name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            placeholder="Roles (comma-separated)"
            value={roles}
            onChange={(e) => setRoles(e.target.value)}
          />
          <Input
            placeholder="Pain points (comma-separated)"
            value={painPoints}
            onChange={(e) => setPainPoints(e.target.value)}
          />
          {create.isError ? (
            <p role="alert" className="text-xs text-destructive">
              {create.error.message}
            </p>
          ) : null}
          <Button type="submit" size="sm" disabled={create.isPending || !name.trim()}>
            Add persona
          </Button>
        </form>
        {personas.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : (personas.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No personas yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {(personas.data ?? []).map((p) => (
              <li
                key={p.id}
                className="flex items-start justify-between gap-2 rounded-md border border-border p-2.5"
              >
                <div>
                  <p className="text-sm font-medium">{p.name}</p>
                  {p.roles.length > 0 ? (
                    <p className="text-xs text-muted-foreground">{p.roles.join(', ')}</p>
                  ) : null}
                </div>
                <DeleteButton
                  label={`Delete ${p.name}`}
                  pending={remove.isPending}
                  onClick={() => remove.mutate(p.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function PillarsCard({ workspaceId }: { workspaceId: string }) {
  const pillars = usePillars(workspaceId);
  const create = useCreatePillar(workspaceId);
  const remove = useDeletePillar(workspaceId);
  const [name, setName] = React.useState('');
  const [keywords, setKeywords] = React.useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await create.mutateAsync({ name: name.trim(), keywords: csv(keywords) });
    setName('');
    setKeywords('');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Content pillars</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form onSubmit={submit} className="flex flex-col gap-2">
          <Input placeholder="Pillar name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input
            placeholder="Keywords (comma-separated)"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
          />
          {create.isError ? (
            <p role="alert" className="text-xs text-destructive">
              {create.error.message}
            </p>
          ) : null}
          <Button type="submit" size="sm" disabled={create.isPending || !name.trim()}>
            Add pillar
          </Button>
        </form>
        {pillars.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : (pillars.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No pillars yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {(pillars.data ?? []).map((p) => (
              <li
                key={p.id}
                className="flex items-start justify-between gap-2 rounded-md border border-border p-2.5"
              >
                <div>
                  <p className="text-sm font-medium">{p.name}</p>
                  {p.keywords.length > 0 ? (
                    <p className="text-xs text-muted-foreground">{p.keywords.join(', ')}</p>
                  ) : null}
                </div>
                <DeleteButton
                  label={`Delete ${p.name}`}
                  pending={remove.isPending}
                  onClick={() => remove.mutate(p.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function TopicIdeasCard({ workspaceId }: { workspaceId: string }) {
  const topics = useTopicIdeas(workspaceId);
  const create = useCreateTopicIdea(workspaceId);
  const setStatus = useSetTopicStatus(workspaceId);
  const remove = useDeleteTopicIdea(workspaceId);
  const [title, setTitle] = React.useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    await create.mutateAsync({
      title: title.trim(),
      findingIds: [],
      trendCandidateIds: [],
      citationIds: [],
    });
    setTitle('');
  };

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Topic ideas</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form onSubmit={submit} className="flex gap-2">
          <Input
            placeholder="Topic idea title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Button type="submit" disabled={create.isPending || !title.trim()}>
            Add
          </Button>
        </form>
        {topics.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : (topics.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No topic ideas yet. Add one to start shaping content.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {(topics.data ?? []).map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border p-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{t.title}</p>
                  {t.evidencePackId ? (
                    <p className="text-[11px] text-muted-foreground">grounded in research</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={TOPIC_VARIANT[t.status] ?? 'secondary'}>{t.status}</Badge>
                  <select
                    aria-label={`Set status for ${t.title}`}
                    className={cn(fieldClass, 'h-8 w-auto')}
                    value={t.status}
                    onChange={(e) =>
                      setStatus.mutate({ id: t.id, status: e.target.value as never })
                    }
                  >
                    {TOPIC_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <DeleteButton
                    label={`Delete ${t.title}`}
                    pending={remove.isPending}
                    onClick={() => remove.mutate(t.id)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function StrategyPage() {
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;

  return (
    <>
      <PageHeader
        title="Strategy"
        description="Define who you're speaking to (personas), the themes you own (pillars), and the topic ideas — many traced back to your research — that become content."
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <PersonasCard workspaceId={workspaceId} />
        <PillarsCard workspaceId={workspaceId} />
        <TopicIdeasCard workspaceId={workspaceId} />
      </div>
    </>
  );
}
