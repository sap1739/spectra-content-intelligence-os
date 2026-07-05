import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    setupFiles: ['test/setup-env.ts'],
    environment: 'node',
    hookTimeout: 30000,
    testTimeout: 30000,
  },
  plugins: [
    // NestJS dependency injection relies on emitDecoratorMetadata, which
    // esbuild does not support — SWC handles the test transform instead.
    // ESM output: Vitest cannot be require()d from CJS-transformed modules.
    swc.vite({ module: { type: 'es6' } }),
  ],
});
