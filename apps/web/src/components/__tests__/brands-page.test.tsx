import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import BrandsPage from '@/app/(app)/brands/page';

/**
 * Brands page (Phase 6A) — the page that replaced a stale placeholder claiming
 * an already-built API was a future feature.
 *
 * Hooks are mocked so these exercise the component's own behaviour: permission
 * gating, form validation, and honest empty/error states.
 */

const mocks = vi.hoisted(() => ({
  can: vi.fn((_p: string) => true),
  brands: {
    data: [] as unknown[],
    isPending: false,
    isError: false,
    error: null as { message: string } | null,
  },
  createMutate: vi.fn(async (_input: Record<string, unknown>) => ({})),
}));

vi.mock('@/lib/auth', () => ({
  useWorkspace: () => ({
    activeWorkspace: { id: 'ws-1', organizationId: 'org-1', name: 'WS', timezone: 'UTC' },
    me: { user: {}, memberships: [], workspaces: [] },
    setActiveWorkspaceId: vi.fn(),
  }),
  usePermissions: () => ({ can: mocks.can, permissions: [] }),
}));

vi.mock('@/lib/brands', () => ({
  useBrands: () => mocks.brands,
  useCreateBrand: () => ({
    mutateAsync: mocks.createMutate,
    isPending: false,
    error: null,
  }),
  useUpdateBrand: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useArchiveBrand: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null }),
}));

function resetMocks() {
  mocks.can.mockImplementation(() => true);
  mocks.brands = { data: [], isPending: false, isError: false, error: null };
  mocks.createMutate.mockClear();
}

describe('BrandsPage permissions', () => {
  it('shows the create form when the user has brand:write', () => {
    resetMocks();
    render(<BrandsPage />);
    expect(screen.getByRole('button', { name: /create brand/i })).toBeInTheDocument();
  });

  it('hides editing controls and says why without brand:write', () => {
    resetMocks();
    mocks.can.mockImplementation((p: string) => p !== 'brand:write');
    render(<BrandsPage />);

    expect(screen.queryByRole('button', { name: /create brand/i })).not.toBeInTheDocument();
    // Says WHICH permission is missing rather than silently hiding the control.
    expect(screen.getByText(/brand:write/)).toBeInTheDocument();
  });
});

describe('BrandsPage states', () => {
  it('renders an honest empty state', () => {
    resetMocks();
    render(<BrandsPage />);
    expect(screen.getByText(/no brands yet/i)).toBeInTheDocument();
  });

  it('surfaces a load error with the real message', () => {
    resetMocks();
    mocks.brands = {
      data: [],
      isPending: false,
      isError: true,
      error: { message: 'Upstream unavailable' },
    };
    render(<BrandsPage />);
    // The actual failure, not a generic "something went wrong".
    expect(screen.getByText('Upstream unavailable')).toBeInTheDocument();
  });

  it('shows a loading state while fetching', () => {
    resetMocks();
    mocks.brands = { data: [], isPending: true, isError: false, error: null };
    const { container } = render(<BrandsPage />);
    expect(container.querySelector('[class*="animate-pulse"]')).toBeTruthy();
  });
});

describe('BrandsPage form validation', () => {
  it('rejects a malformed website without calling the API', async () => {
    resetMocks();
    const user = userEvent.setup();
    render(<BrandsPage />);

    await user.type(screen.getByLabelText(/^name$/i), 'Acme');
    await user.type(screen.getByLabelText(/website/i), 'not-a-url');
    await user.click(screen.getByRole('button', { name: /create brand/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/full http\(s\) URL/i);
    expect(mocks.createMutate).not.toHaveBeenCalled();
  });

  it('submits tone and do-nots as trimmed lists', async () => {
    resetMocks();
    const user = userEvent.setup();
    render(<BrandsPage />);

    await user.type(screen.getByLabelText(/^name$/i), 'Acme');
    await user.type(screen.getByLabelText(/tone/i), ' pragmatic , precise ,, ');
    await user.click(screen.getByRole('button', { name: /create brand/i }));

    expect(mocks.createMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Acme',
        voice: { tone: ['pragmatic', 'precise'], doNots: [], examplePhrases: [] },
      }),
    );
  });

  it('omits voice entirely when no voice fields are filled in', async () => {
    resetMocks();
    const user = userEvent.setup();
    render(<BrandsPage />);

    await user.type(screen.getByLabelText(/^name$/i), 'Plain');
    await user.click(screen.getByRole('button', { name: /create brand/i }));

    const payload = mocks.createMutate.mock.calls[0]?.[0];
    expect(payload).toBeDefined();
    // Omitted, not an empty object: "no voice defined" differs from "a voice
    // defined with nothing in it".
    expect(payload).not.toHaveProperty('voice');
  });
});
