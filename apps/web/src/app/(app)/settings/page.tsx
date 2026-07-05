import { Settings } from 'lucide-react';
import type { Metadata } from 'next';

import { PlaceholderPage } from '@/components/placeholder-page';

export const metadata: Metadata = { title: 'Settings' };

export default function SettingsPage() {
  return (
    <PlaceholderPage
      title="Settings"
      description="Workspace preferences: timezone, languages, provider configuration and security controls."
      emptyTitle="Settings are not available yet"
      emptyDescription="Workspace and organization settings (timezones are explicit; storage is always UTC) become editable with authentication in Phase 2."
      phase={2}
      icon={Settings}
    />
  );
}
