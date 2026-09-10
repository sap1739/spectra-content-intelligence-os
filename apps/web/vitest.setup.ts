import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// React Testing Library does not auto-clean when `globals` is on for every
// runner version — do it explicitly so tests cannot leak DOM into each other.
afterEach(() => {
  cleanup();
});
