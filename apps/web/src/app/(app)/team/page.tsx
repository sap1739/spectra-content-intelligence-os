import { Users } from 'lucide-react';
import type { Metadata } from 'next';

import { PlaceholderPage } from '@/components/placeholder-page';

export const metadata: Metadata = { title: 'Team' };

export default function TeamPage() {
  return (
    <PlaceholderPage
      title="Team"
      description="Invite teammates and assign permission-based roles — from Researcher to Approver to Client Reviewer."
      emptyTitle="Team management is not available yet"
      emptyDescription="Thirteen roles with permission-oriented authorization are defined in this foundation; invitations and member management arrive with authentication in Phase 2."
      phase={2}
      icon={Users}
    />
  );
}
