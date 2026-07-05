import { FileText } from 'lucide-react';
import type { Metadata } from 'next';

import { PlaceholderPage } from '@/components/placeholder-page';

export const metadata: Metadata = { title: 'Content' };

export default function ContentPage() {
  return (
    <PlaceholderPage
      title="Content"
      description="Every content item, its lifecycle state, citations and approval history."
      emptyTitle="No content items yet"
      emptyDescription="Content follows the IDEA → RESEARCH → BRIEF → DRAFT → REVIEW → APPROVED → PUBLISHED lifecycle with complete provenance. Editing and review ship in Phase 3."
      phase={3}
      icon={FileText}
    />
  );
}
