import * as React from 'react';

import { cn } from './cn';

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  /** Optional call-to-action area (buttons, links). */
  action?: React.ReactNode;
  /** Optional badge/label, e.g. "Planned — Phase 2". */
  hint?: React.ReactNode;
}

/**
 * Honest empty state: used everywhere data does not exist yet. Never renders
 * placeholder numbers or fabricated content.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  hint,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center',
        className,
      )}
      {...props}
    >
      {icon ? (
        <div aria-hidden="true" className="mb-1 text-muted-foreground [&_svg]:size-8">
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
      {hint ? <div className="mt-1">{hint}</div> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
