import { Boxes } from 'lucide-react';
import type { Metadata } from 'next';

import { PlaceholderPage } from '@/components/placeholder-page';

export const metadata: Metadata = { title: 'Verticals' };

export default function VerticalsPage() {
  return (
    <PlaceholderPage
      title="Verticals"
      description="User-defined market niches — from AI-powered software testing to Bengali music releases. No industry list is hard-coded."
      emptyTitle="No custom verticals yet"
      emptyDescription="A vertical captures audiences, pain points, geographies, languages, competitors, keywords, trusted/blocked domains, seasonality and relevance criteria. The entity exists in this foundation; editing screens arrive in Phase 2."
      phase={2}
      icon={Boxes}
    />
  );
}
