import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    /**
     * These suites share one Postgres, one Redis and one MinIO, and several do
     * real work (sharp renders, ffmpeg encodes, a BullMQ worker that waits for
     * its own job). Unbounded parallelism oversubscribes the machine: hooks and
     * interactive transactions time out, tenants end up half-created, and the
     * failures surface far from the cause — as foreign-key violations in
     * unrelated specs. Capping workers keeps the suite deterministic and costs
     * no wall-clock worth having (the whole run is ~12s either way).
     */
    maxWorkers: 3,
    minWorkers: 1,
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
