import { Calendar } from 'lucide-react';
import type { Metadata } from 'next';

import { PlaceholderPage } from '@/components/placeholder-page';

export const metadata: Metadata = { title: 'Calendar' };

export default function CalendarPage() {
  return (
    <PlaceholderPage
      title="Calendar"
      description="Plan and visualize scheduled content across channels, in your workspace timezone."
      emptyTitle="Nothing scheduled yet"
      emptyDescription="The calendar shows scheduled and published content per channel. Scheduling ships with content workflows in Phase 3; publishing with platform integrations in Phase 4."
      phase={3}
      icon={Calendar}
    />
  );
}
