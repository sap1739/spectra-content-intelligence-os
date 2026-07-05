import { BadgeIndianRupee } from 'lucide-react';
import type { Metadata } from 'next';

import { PlaceholderPage } from '@/components/placeholder-page';

export const metadata: Metadata = { title: 'Billing' };

export default function BillingPage() {
  return (
    <PlaceholderPage
      title="Billing"
      description="Subscription, usage-based charges and invoices for your organization."
      emptyTitle="Billing is not set up yet"
      emptyDescription="Plans and metering are defined after usage-bearing features (research runs, generation, publishing) exist. Planned for Phase 4."
      phase={4}
      icon={BadgeIndianRupee}
    />
  );
}
