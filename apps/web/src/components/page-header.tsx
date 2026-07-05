import { Badge } from '@spectra/ui';
import * as React from 'react';

export interface PageHeaderProps {
  title: string;
  description?: string;
  phase?: 1 | 2 | 3 | 4;
  actions?: React.ReactNode;
}

export function PageHeader({ title, description, phase, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="max-w-2xl">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {phase && phase > 1 ? <Badge variant="muted">Planned — Phase {phase}</Badge> : null}
        </div>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
