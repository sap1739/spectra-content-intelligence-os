import { Card, CardContent, CardHeader, CardTitle } from '@spectra/ui';
import {
  BarChart3,
  CalendarClock,
  CheckCircle2,
  FileWarning,
  FlaskConical,
  Image,
  PackageSearch,
  Share2,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import type { Metadata } from 'next';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'Home' };

interface DashboardArea {
  title: string;
  icon: LucideIcon;
  emptyTitle: string;
  emptyDescription: string;
}

/**
 * Dashboard areas render honest empty states only — no fabricated analytics,
 * trends or activity. Real data appears as the corresponding phases ship.
 */
const AREAS: DashboardArea[] = [
  {
    title: 'Trending topics',
    icon: TrendingUp,
    emptyTitle: 'No trending topics yet',
    emptyDescription: 'Trends appear after research providers are connected in Phase 2.',
  },
  {
    title: 'Active research',
    icon: FlaskConical,
    emptyTitle: 'No active research',
    emptyDescription: 'Research runs will show progress here once the pipeline ships.',
  },
  {
    title: 'Recent evidence packs',
    icon: PackageSearch,
    emptyTitle: 'No evidence packs yet',
    emptyDescription: 'Validated findings are bundled into evidence packs for content creation.',
  },
  {
    title: 'Content awaiting approval',
    icon: CheckCircle2,
    emptyTitle: 'Nothing awaiting approval',
    emptyDescription: 'Items in review appear here once content workflows ship in Phase 3.',
  },
  {
    title: 'Scheduled content',
    icon: CalendarClock,
    emptyTitle: 'Nothing scheduled',
    emptyDescription: 'Approved content scheduled for publishing will be listed here.',
  },
  {
    title: 'Failed publications',
    icon: FileWarning,
    emptyTitle: 'No failed publications',
    emptyDescription: 'Publishing failures surface here with retry options in Phase 4.',
  },
  {
    title: 'Recent assets',
    icon: Image,
    emptyTitle: 'No media assets yet',
    emptyDescription: 'Generated and uploaded media will appear in this library.',
  },
  {
    title: 'Connected platforms',
    icon: Share2,
    emptyTitle: 'No platforms connected',
    emptyDescription: 'Social account connections open with official API integrations in Phase 4.',
  },
  {
    title: 'Usage summary',
    icon: BarChart3,
    emptyTitle: 'No usage recorded yet',
    emptyDescription: 'Research, generation and publishing usage will be summarized here.',
  },
];

export default function HomePage() {
  return (
    <>
      <PageHeader
        title="Home"
        description="Your research-to-publishing command centre. Phase 1 establishes the foundation; data appears as capabilities come online."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {AREAS.map((area) => {
          const Icon = area.icon;
          return (
            <Card key={area.title}>
              <CardHeader className="flex-row items-center gap-2 space-y-0">
                <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
                <CardTitle>{area.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-center">
                  <p className="text-sm font-medium">{area.emptyTitle}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{area.emptyDescription}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
