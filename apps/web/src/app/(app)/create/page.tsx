import { Search } from 'lucide-react';
import type { Metadata } from 'next';

import { PlaceholderPage } from '@/components/placeholder-page';

export const metadata: Metadata = { title: 'Create' };

export default function CreatePage() {
  return (
    <PlaceholderPage
      title="Create"
      description="Start research-backed content: from an objective to strategy, drafts and platform variants."
      emptyTitle="Creation flows are not available yet"
      emptyDescription="Creation starts from validated research and trends, so this area unlocks after the research pipeline (Phase 2) and generation providers (Phase 3)."
      phase={3}
      icon={Search}
    />
  );
}
