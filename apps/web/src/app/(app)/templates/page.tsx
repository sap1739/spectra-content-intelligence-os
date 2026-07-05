import { LayoutTemplate } from 'lucide-react';
import type { Metadata } from 'next';

import { PlaceholderPage } from '@/components/placeholder-page';

export const metadata: Metadata = { title: 'Templates' };

export default function TemplatesPage() {
  return (
    <PlaceholderPage
      title="Templates"
      description="Reusable content and design templates aligned to your brand voice."
      emptyTitle="No templates yet"
      emptyDescription="Prompt templates (versioned) and visual templates for images and video ship alongside the generation pipeline in Phase 3."
      phase={3}
      icon={LayoutTemplate}
    />
  );
}
