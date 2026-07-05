import { Layers } from 'lucide-react';
import type { Metadata } from 'next';

import { PlaceholderPage } from '@/components/placeholder-page';

export const metadata: Metadata = { title: 'Brands' };

export default function BrandsPage() {
  return (
    <PlaceholderPage
      title="Brands"
      description="Brand profiles: voice, tone, guidelines, languages and do-nots that steer research relevance and generation."
      emptyTitle="No brands configured yet"
      emptyDescription="The Brand entity ships in this foundation (see the database schema); management screens arrive with authentication in Phase 2."
      phase={2}
      icon={Layers}
    />
  );
}
