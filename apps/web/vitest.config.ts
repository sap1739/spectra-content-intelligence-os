import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Web unit tests (Phase 6A). The app had zero of them: 8k+ lines of UI with no
 * coverage below the Playwright layer, which is slow and cannot reach
 * pure-logic branches like permission gating or form validation.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // Playwright specs live in e2e/ and run under a different runner.
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
