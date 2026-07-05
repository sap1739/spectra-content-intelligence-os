import { Badge, EmptyState } from '@spectra/ui';
import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

import { PageHeader } from './page-header';

export interface PlaceholderPageProps {
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  phase: 2 | 3 | 4;
  icon: LucideIcon;
}

/**
 * Honest placeholder for areas whose functionality ships in later phases.
 * States clearly what will exist and when — no fake data, no dead buttons
 * pretending to work.
 */
export function PlaceholderPage({
  title,
  description,
  emptyTitle,
  emptyDescription,
  phase,
  icon: Icon,
}: PlaceholderPageProps) {
  return (
    <>
      <PageHeader title={title} description={description} phase={phase} />
      <EmptyState
        icon={<Icon />}
        title={emptyTitle}
        description={emptyDescription}
        hint={<Badge variant="outline">Planned — Phase {phase}</Badge>}
      />
    </>
  );
}
