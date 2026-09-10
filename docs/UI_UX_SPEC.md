## Honest UI states (Phase 6A)

The three stale placeholder pages are gone. Each had claimed an already-shipped
capability was a future phase — Brands said "arrives with authentication in Phase 2" while a
five-route Brand CRUD API had existed since Phase 2. The `PlaceholderPage` component itself was
deleted, so the pattern cannot silently return.

Rules the UI now follows:

- **A page states what exists, not what is planned.** Templates has no user-editable template
  store, so it says exactly that and shows the one real thing — the versioned prompt template every
  draft is attributed to — instead of an empty list implying one is coming.
- **A control that cannot be saved is not shown.** Settings offers organization name, workspace
  name and timezone, and personal name and timezone, because those are the columns the backend
  persists. There is deliberately no organization-wide timezone: the table has no such column, and
  a control that silently does nothing is worse than its absence.
- **Missing data renders as an em dash**, never as `0`, `—unknown—` or an invented default.
- **Permission gating names the missing permission** (`brand:write`, `org:manage`) rather than
  hiding a control with no explanation. Gating uses server-resolved effective permissions, never
  role names.
- **Every state is reachable and distinct**: loading (skeleton), empty (what to do next), error
  (the real message from the API), and read-only (why).

### Accessibility baseline

Every form control has a `<label for>` or an `aria-label`; errors use `role="alert"` and are linked
via `aria-describedby`; expand/collapse controls carry `aria-expanded` and `aria-controls`; focus
is always visible (`focus-visible:ring-2`); destructive actions require an explicit confirm step.
Two Playwright tests assert keyboard reachability and that every visible control on Settings has an
accessible name.
