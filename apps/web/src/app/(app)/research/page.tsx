import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@spectra/ui';
import { FlaskConical } from 'lucide-react';
import type { Metadata } from 'next';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'Research' };

const PIPELINE_PREVIEW: ReadonlyArray<{ stage: string; detail: string }> = [
  { stage: 'Plan & expand queries', detail: 'From your vertical, brand and research objective' },
  { stage: 'Discover & retrieve sources', detail: 'Web, news, RSS, communities, video, documents' },
  { stage: 'Extract & normalize', detail: 'Content, metadata, language, geography, dates' },
  { stage: 'Deduplicate & cluster', detail: 'Exact and near-duplicate removal, topic clusters' },
  { stage: 'Validate claims', detail: 'Cross-source corroboration with citations retained' },
  { stage: 'Score & review', detail: 'Explainable trend scores, human review, evidence packs' },
];

export default function ResearchPage() {
  return (
    <>
      <PageHeader
        title="Research"
        description="Research projects turn a business question into validated, cited findings."
        phase={2}
        actions={
          <Button disabled title="Research runs require providers configured in Phase 2">
            New research project
          </Button>
        }
      />

      <EmptyState
        icon={<FlaskConical />}
        title="No research projects yet"
        description="Once research providers are configured, you will create projects like “Latest developments in AI-powered quality engineering in India and globally” and receive validated findings with full citations."
        hint={<Badge variant="outline">Research providers arrive in Phase 2</Badge>}
      />

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>How research will work</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {PIPELINE_PREVIEW.map((step, index) => (
              <li key={step.stage} className="rounded-md border border-border p-3">
                <p className="text-xs font-medium text-muted-foreground">Step {index + 1}</p>
                <p className="mt-0.5 text-sm font-medium">{step.stage}</p>
                <p className="mt-1 text-xs text-muted-foreground">{step.detail}</p>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </>
  );
}
