import { BarChart3 } from 'lucide-react';
import type { Metadata } from 'next';

import { PlaceholderPage } from '@/components/placeholder-page';

export const metadata: Metadata = { title: 'Analytics' };

export default function AnalyticsPage() {
  return (
    <PlaceholderPage
      title="Analytics"
      description="Post and campaign performance retrieved from connected platforms — feeding back into trend scoring."
      emptyTitle="No analytics yet"
      emptyDescription="Analytics require published content and platform integrations (Phase 4). This product never displays fabricated metrics."
      phase={4}
      icon={BarChart3}
    />
  );
}
