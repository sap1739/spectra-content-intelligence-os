import { Sparkles } from 'lucide-react';
import type { Metadata } from 'next';

import { PlaceholderPage } from '@/components/placeholder-page';

export const metadata: Metadata = { title: 'Intelligence' };

export default function IntelligencePage() {
  return (
    <PlaceholderPage
      title="Intelligence"
      description="A cross-vertical view of research findings, validated claims and evidence packs."
      emptyTitle="No intelligence gathered yet"
      emptyDescription="This overview aggregates research findings, claims and evidence packs across your workspaces once the research pipeline is live."
      phase={2}
      icon={Sparkles}
    />
  );
}
