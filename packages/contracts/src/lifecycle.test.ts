import { describe, expect, it } from 'vitest';

import {
  CONTENT_LIFECYCLE_STATES,
  CONTENT_LIFECYCLE_TRANSITIONS,
  InvalidLifecycleTransitionError,
  assertTransitionContent,
  canTransitionContent,
} from './lifecycle';

describe('content lifecycle', () => {
  it('defines transitions for every state', () => {
    for (const state of CONTENT_LIFECYCLE_STATES) {
      expect(CONTENT_LIFECYCLE_TRANSITIONS[state]).toBeDefined();
    }
  });

  it('allows the happy path from idea to published', () => {
    const path = [
      'IDEA',
      'RESEARCHING',
      'RESEARCH_READY',
      'BRIEF',
      'STRATEGY',
      'DRAFT',
      'GENERATED',
      'REVIEW',
      'APPROVED',
      'SCHEDULED',
      'PUBLISHING',
      'PUBLISHED',
    ] as const;
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransitionContent(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('supports the changes-requested loop', () => {
    expect(canTransitionContent('REVIEW', 'CHANGES_REQUESTED')).toBe(true);
    expect(canTransitionContent('CHANGES_REQUESTED', 'EDITING')).toBe(true);
    expect(canTransitionContent('EDITING', 'REVIEW')).toBe(true);
  });

  it('rejects illegal jumps', () => {
    expect(canTransitionContent('IDEA', 'PUBLISHED')).toBe(false);
    expect(canTransitionContent('PUBLISHED', 'DRAFT')).toBe(false);
    expect(canTransitionContent('ARCHIVED', 'IDEA')).toBe(false);
    expect(() => assertTransitionContent('IDEA', 'PUBLISHED')).toThrow(
      InvalidLifecycleTransitionError,
    );
  });
});
