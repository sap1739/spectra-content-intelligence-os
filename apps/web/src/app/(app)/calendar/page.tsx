'use client';

import { SOCIAL_PLATFORMS } from '@spectra/contracts';
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
import { Calendar, X } from 'lucide-react';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { useWorkspace } from '@/lib/auth';
import {
  useCalendar,
  useCancelEntry,
  useScheduleEntry,
  type CalendarEntryRow,
} from '@/lib/calendar';
import { useContentItems } from '@/lib/content';

const fieldClass = cn(
  'w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm shadow-sm',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
);

const STATUS_VARIANT: Record<string, 'success' | 'muted' | 'secondary' | 'destructive'> = {
  SCHEDULED: 'secondary',
  PUBLISHED: 'success',
  CANCELLED: 'muted',
  FAILED: 'destructive',
};

function groupByDay(entries: CalendarEntryRow[]): Array<[string, CalendarEntryRow[]]> {
  const map = new Map<string, CalendarEntryRow[]>();
  for (const e of entries) {
    const day = new Date(e.scheduledAt).toLocaleDateString();
    (map.get(day) ?? map.set(day, []).get(day)!).push(e);
  }
  return [...map.entries()];
}

export default function CalendarPage() {
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;

  const calendar = useCalendar(workspaceId);
  const items = useContentItems(workspaceId);
  const schedule = useScheduleEntry(workspaceId);
  const cancel = useCancelEntry(workspaceId);

  const approved = (items.data ?? []).filter((i) =>
    ['APPROVED', 'SCHEDULED'].includes(i.lifecycleState),
  );

  const [contentItemId, setContentItemId] = React.useState('');
  const [platform, setPlatform] = React.useState<string>('LINKEDIN');
  const [when, setWhen] = React.useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!contentItemId || !when) return;
    await schedule.mutateAsync({
      contentItemId,
      platform: platform as never,
      scheduledAt: new Date(when).toISOString(),
    });
    setWhen('');
  };

  const days = groupByDay(calendar.data ?? []);

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Schedule approved content across channels. Times are stored in UTC and shown in your local timezone. Publishing itself arrives in Phase 4."
      />

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Schedule content</CardTitle>
          </CardHeader>
          <CardContent>
            {approved.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No approved content yet. Approve a content item in the Studio to schedule it.
              </p>
            ) : (
              <form onSubmit={submit} className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cal-item">Content item</Label>
                  <select
                    id="cal-item"
                    className={fieldClass}
                    value={contentItemId}
                    onChange={(e) => setContentItemId(e.target.value)}
                  >
                    <option value="">Select…</option>
                    {approved.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cal-platform">Platform</Label>
                  <select
                    id="cal-platform"
                    className={fieldClass}
                    value={platform}
                    onChange={(e) => setPlatform(e.target.value)}
                  >
                    {SOCIAL_PLATFORMS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cal-when">When (local time)</Label>
                  <Input
                    id="cal-when"
                    type="datetime-local"
                    value={when}
                    onChange={(e) => setWhen(e.target.value)}
                  />
                </div>
                {schedule.isError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {schedule.error.message}
                  </p>
                ) : null}
                <Button type="submit" disabled={schedule.isPending || !contentItemId || !when}>
                  {schedule.isPending ? 'Scheduling…' : 'Schedule'}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        <div>
          {calendar.isPending ? (
            <Skeleton className="h-48 w-full" />
          ) : calendar.isError ? (
            <EmptyState
              icon={<Calendar />}
              title="Could not load the calendar"
              description={calendar.error.message}
            />
          ) : days.length === 0 ? (
            <EmptyState
              icon={<Calendar />}
              title="Nothing scheduled yet"
              description="Schedule an approved content item to see it here."
            />
          ) : (
            <div className="flex flex-col gap-5">
              {days.map(([day, entries]) => (
                <div key={day}>
                  <p className="mb-2 text-sm font-semibold">{day}</p>
                  <ul className="flex flex-col gap-2">
                    {entries.map((e) => (
                      <li
                        key={e.id}
                        className="flex items-center justify-between gap-2 rounded-md border border-border p-3"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{e.contentItem.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(e.scheduledAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}{' '}
                            · {e.platform}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Badge variant={STATUS_VARIANT[e.status] ?? 'secondary'}>
                            {e.status}
                          </Badge>
                          {e.status === 'SCHEDULED' ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Cancel ${e.contentItem.title} on ${e.platform}`}
                              disabled={cancel.isPending}
                              onClick={() => cancel.mutate(e.id)}
                            >
                              <X aria-hidden="true" />
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
