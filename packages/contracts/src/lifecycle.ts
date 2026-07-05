import { z } from 'zod';

/**
 * Canonical content lifecycle. Single source of truth — no scattered strings.
 * See docs/DOMAIN_MODEL.md for the state machine diagram.
 */
export const CONTENT_LIFECYCLE_STATES = [
  'IDEA',
  'RESEARCHING',
  'RESEARCH_READY',
  'BRIEF',
  'STRATEGY',
  'DRAFT',
  'GENERATED',
  'EDITING',
  'REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
  'FAILED',
  'ARCHIVED',
] as const;

export const contentLifecycleStateSchema = z.enum(CONTENT_LIFECYCLE_STATES);
export type ContentLifecycleState = z.infer<typeof contentLifecycleStateSchema>;

/** Allowed forward transitions. Anything not listed here is rejected. */
export const CONTENT_LIFECYCLE_TRANSITIONS: Record<
  ContentLifecycleState,
  readonly ContentLifecycleState[]
> = {
  IDEA: ['RESEARCHING', 'BRIEF', 'ARCHIVED'],
  RESEARCHING: ['RESEARCH_READY', 'IDEA', 'ARCHIVED'],
  RESEARCH_READY: ['BRIEF', 'RESEARCHING', 'ARCHIVED'],
  BRIEF: ['STRATEGY', 'ARCHIVED'],
  STRATEGY: ['DRAFT', 'ARCHIVED'],
  DRAFT: ['GENERATED', 'EDITING', 'ARCHIVED'],
  GENERATED: ['EDITING', 'REVIEW', 'ARCHIVED'],
  EDITING: ['REVIEW', 'ARCHIVED'],
  REVIEW: ['CHANGES_REQUESTED', 'APPROVED', 'ARCHIVED'],
  CHANGES_REQUESTED: ['EDITING', 'ARCHIVED'],
  APPROVED: ['SCHEDULED', 'EDITING', 'ARCHIVED'],
  SCHEDULED: ['PUBLISHING', 'APPROVED', 'ARCHIVED'],
  PUBLISHING: ['PUBLISHED', 'PARTIALLY_PUBLISHED', 'FAILED'],
  PUBLISHED: ['ARCHIVED'],
  PARTIALLY_PUBLISHED: ['PUBLISHING', 'FAILED', 'ARCHIVED'],
  FAILED: ['PUBLISHING', 'ARCHIVED'],
  ARCHIVED: [],
};

export function canTransitionContent(
  from: ContentLifecycleState,
  to: ContentLifecycleState,
): boolean {
  return CONTENT_LIFECYCLE_TRANSITIONS[from].includes(to);
}

export class InvalidLifecycleTransitionError extends Error {
  constructor(
    public readonly from: ContentLifecycleState,
    public readonly to: ContentLifecycleState,
  ) {
    super(`Invalid content lifecycle transition: ${from} → ${to}`);
    this.name = 'InvalidLifecycleTransitionError';
  }
}

export function assertTransitionContent(
  from: ContentLifecycleState,
  to: ContentLifecycleState,
): void {
  if (!canTransitionContent(from, to)) {
    throw new InvalidLifecycleTransitionError(from, to);
  }
}
