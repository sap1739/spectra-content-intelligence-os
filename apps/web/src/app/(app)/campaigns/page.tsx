import { Megaphone } from 'lucide-react';
import type { Metadata } from 'next';

import { PlaceholderPage } from '@/components/placeholder-page';

export const metadata: Metadata = { title: 'Campaigns' };

export default function CampaignsPage() {
  return (
    <PlaceholderPage
      title="Campaigns"
      description="Multi-channel campaigns with briefs, calendars and research references."
      emptyTitle="No campaigns yet"
      emptyDescription="Campaigns tie strategy, content items and channel variants together. They arrive with the content workflows in Phase 3."
      phase={3}
      icon={Megaphone}
    />
  );
}
