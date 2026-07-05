import { Image } from 'lucide-react';
import type { Metadata } from 'next';

import { PlaceholderPage } from '@/components/placeholder-page';

export const metadata: Metadata = { title: 'Media' };

export default function MediaPage() {
  return (
    <PlaceholderPage
      title="Media"
      description="Your tenant-scoped library of uploaded and generated images, video and audio."
      emptyTitle="No media assets yet"
      emptyDescription="Uploads with validation and signed URLs, plus rendering pipelines (resize, aspect-ratio variants, subtitles, audiograms), arrive in Phase 3."
      phase={3}
      icon={Image}
    />
  );
}
