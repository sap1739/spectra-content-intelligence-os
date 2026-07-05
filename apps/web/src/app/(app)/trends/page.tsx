import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@spectra/ui';
import { TrendingUp } from 'lucide-react';
import type { Metadata } from 'next';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'Trends' };

const TREND_STATES: ReadonlyArray<{ state: string; meaning: string }> = [
  { state: 'EMERGING', meaning: 'Early signals from a small set of credible sources' },
  { state: 'ACCELERATING', meaning: 'Velocity and coverage growing across sources' },
  { state: 'PEAKING', meaning: 'Maximum attention — act fast or skip' },
  { state: 'STABLE', meaning: 'Sustained, steady interest' },
  { state: 'DECLINING', meaning: 'Attention falling off' },
  { state: 'SEASONAL', meaning: 'Recurs around events or seasons' },
  { state: 'EVERGREEN', meaning: 'Consistently relevant to your audience' },
  { state: 'UNVERIFIED', meaning: 'Insufficient evidence — needs more sources' },
  { state: 'REJECTED', meaning: 'Ruled out by review or risk checks' },
];

export default function TrendsPage() {
  return (
    <>
      <PageHeader
        title="Trends"
        description="Explainable trend intelligence for your verticals — every score shows exactly why it was assigned."
        phase={2}
      />

      <EmptyState
        icon={<TrendingUp />}
        title="No trends detected yet"
        description="Trend candidates are produced by research runs and scored with a configurable, versioned formula. Nothing is shown here until real research data exists — no fabricated market trends."
        hint={<Badge variant="outline">Requires research providers — Phase 2</Badge>}
      />

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Trend lifecycle states</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {TREND_STATES.map((item) => (
              <li
                key={item.state}
                className="flex items-start gap-2 rounded-md border border-border p-3"
              >
                <Badge variant="secondary" className="mt-0.5 shrink-0">
                  {item.state}
                </Badge>
                <span className="text-xs text-muted-foreground">{item.meaning}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
