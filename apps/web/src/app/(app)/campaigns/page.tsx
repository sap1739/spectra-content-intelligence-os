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
import { Megaphone } from 'lucide-react';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { useWorkspace } from '@/lib/auth';
import { useCampaigns, useCreateCampaign, useUpsertBrief, type CampaignRow } from '@/lib/strategy';

const fieldClass = cn(
  'w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm shadow-sm',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
);

const CAMPAIGN_STATUS = ['DRAFT', 'PLANNED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'] as const;

/** Splits a textarea into a trimmed, non-empty list (one item per line). */
function toList(raw: string): string[] {
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function BriefEditor({ workspaceId, campaign }: { workspaceId: string; campaign: CampaignRow }) {
  const upsert = useUpsertBrief(workspaceId, campaign.id);
  const b = campaign.brief;
  const [background, setBackground] = React.useState(b?.background ?? '');
  const [objectives, setObjectives] = React.useState((b?.objectives ?? []).join('\n'));
  const [keyMessages, setKeyMessages] = React.useState((b?.keyMessages ?? []).join('\n'));
  const [mandatories, setMandatories] = React.useState((b?.mandatories ?? []).join('\n'));
  const [doNots, setDoNots] = React.useState((b?.doNots ?? []).join('\n'));
  const [tone, setTone] = React.useState(b?.tone ?? '');

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    await upsert.mutateAsync({
      background: background.trim() || undefined,
      objectives: toList(objectives),
      keyMessages: toList(keyMessages),
      mandatories: toList(mandatories),
      doNots: toList(doNots),
      tone: tone.trim() || undefined,
    });
  };

  const areas: Array<[string, string, (v: string) => void, string]> = [
    ['Objectives (one per line)', objectives, setObjectives, 'obj'],
    ['Key messages', keyMessages, setKeyMessages, 'key'],
    ['Mandatories', mandatories, setMandatories, 'man'],
    ['Do-nots', doNots, setDoNots, 'dnt'],
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Brief · {campaign.name}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="brief-bg">Background</Label>
            <textarea
              id="brief-bg"
              className={cn(fieldClass, 'min-h-16 resize-y')}
              value={background}
              onChange={(e) => setBackground(e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {areas.map(([label, value, setter, key]) => (
              <div key={key} className="flex flex-col gap-1.5">
                <Label htmlFor={`brief-${key}`}>{label}</Label>
                <textarea
                  id={`brief-${key}`}
                  className={cn(fieldClass, 'min-h-20 resize-y')}
                  value={value}
                  onChange={(e) => setter(e.target.value)}
                />
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="brief-tone">Tone</Label>
            <Input id="brief-tone" value={tone} onChange={(e) => setTone(e.target.value)} />
          </div>
          {upsert.isError ? (
            <p role="alert" className="text-xs text-destructive">
              {upsert.error.message}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={upsert.isPending}>
              {upsert.isPending ? 'Saving…' : 'Save brief'}
            </Button>
            {upsert.isSuccess ? (
              <span className="text-xs text-muted-foreground">Saved.</span>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export default function CampaignsPage() {
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;
  const campaigns = useCampaigns(workspaceId);
  const create = useCreateCampaign(workspaceId);

  const [name, setName] = React.useState('');
  const [status, setStatus] = React.useState('DRAFT');
  const [description, setDescription] = React.useState('');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const selected = (campaigns.data ?? []).find((c) => c.id === selectedId) ?? null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    const created = await create.mutateAsync({
      name: name.trim(),
      status: status as never,
      timezone: 'UTC',
      ...(description.trim() ? { description: description.trim() } : {}),
    });
    setName('');
    setDescription('');
    setSelectedId(created.id);
  };

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Plan campaigns and their briefs. Content items attach to a campaign; briefs carry the background, objectives, mandatories and do-nots that guide drafting."
      />

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>New campaign</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="c-name">Name</Label>
                  <Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="c-status">Status</Label>
                  <select
                    id="c-status"
                    className={fieldClass}
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    {CAMPAIGN_STATUS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="c-desc">Description</Label>
                  <textarea
                    id="c-desc"
                    className={cn(fieldClass, 'min-h-16 resize-y')}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
                {create.isError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {create.error.message}
                  </p>
                ) : null}
                <Button type="submit" disabled={create.isPending || !name.trim()}>
                  {create.isPending ? 'Creating…' : 'Create campaign'}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Campaigns</CardTitle>
            </CardHeader>
            <CardContent>
              {campaigns.isPending ? (
                <Skeleton className="h-24 w-full" />
              ) : campaigns.isError ? (
                <EmptyState
                  icon={<Megaphone />}
                  title="Could not load campaigns"
                  description={campaigns.error.message}
                />
              ) : campaigns.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">No campaigns yet.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {campaigns.data.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(c.id)}
                        className={cn(
                          'w-full rounded-md border border-transparent px-2.5 py-2 text-left text-sm transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          selectedId === c.id ? 'border-border bg-accent' : 'hover:bg-accent/60',
                        )}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium">{c.name}</span>
                          <Badge variant="secondary">{c.status}</Badge>
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {c._count.contentItems} content item(s) ·{' '}
                          {c.brief ? 'brief set' : 'no brief'}
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
          {selected ? (
            <BriefEditor key={selected.id} workspaceId={workspaceId} campaign={selected} />
          ) : (
            <EmptyState
              icon={<Megaphone />}
              title="Select a campaign"
              description="Pick a campaign to edit its brief."
            />
          )}
        </div>
      </div>
    </>
  );
}
