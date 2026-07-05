import { Share2 } from 'lucide-react';
import type { Metadata } from 'next';

import { PlaceholderPage } from '@/components/placeholder-page';

export const metadata: Metadata = { title: 'Social Accounts' };

export default function SocialAccountsPage() {
  return (
    <PlaceholderPage
      title="Social Accounts"
      description="Connect LinkedIn, Instagram, Facebook, YouTube, TikTok, Threads, X, Pinterest, WordPress and email platforms through official APIs."
      emptyTitle="No platforms connected"
      emptyDescription="OAuth connections with encrypted token storage and per-platform capability discovery ship in Phase 4. No integration is active today — nothing here pretends otherwise."
      phase={4}
      icon={Share2}
    />
  );
}
