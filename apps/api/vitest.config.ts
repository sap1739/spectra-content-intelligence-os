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
     * no wall-clock worth having.
     *
     * Retuned in 7D as the suite reached 26 files: 3 workers began failing
     * under load, 2 runs green in ~21s, and 1 is both slower (~220s, because
     * nothing overlaps) and still fails on timeouts. Revisit when the suite
     * grows again.
     */
    maxWorkers: 2,
    minWorkers: 1,
    setupFiles: ['test/setup-env.ts'],
    environment: 'node',
    // Generous ceilings, not expectations: these suites boot a real Nest app
    // and several wait on real work (sharp, ffmpeg, a BullMQ worker) while
    // sharing one machine. A timeout here should mean "stuck", not "busy".
    hookTimeout: 60000,
    testTimeout: 90000,
  },
  plugins: [
    // NestJS dependency injection relies on emitDecoratorMetadata, which
    // esbuild does not support — SWC handles the test transform instead.
    // ESM output: Vitest cannot be require()d from CJS-transformed modules.
    swc.vite({ module: { type: 'es6' } }),
  ],
});
