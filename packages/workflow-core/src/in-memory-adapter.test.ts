import { describe, expect, it } from 'vitest';

import { InMemoryJobQueue } from './in-memory-adapter';

describe('InMemoryJobQueue', () => {
  it('executes registered handlers with an envelope and context', async () => {
    const queue = new InMemoryJobQueue();
    const seen: string[] = [];
    queue.register<{ value: string }, void>('test.echo', async (envelope, context) => {
      seen.push(`${envelope.payload.value}:${context.attempt}`);
    });

    await queue.enqueue('test.echo', { value: 'hello' });
    await queue.drain();

    expect(seen).toEqual(['hello:1']);
  });

  it('deduplicates enqueues by idempotency key', async () => {
    const queue = new InMemoryJobQueue();
    let runs = 0;
    queue.register('test.count', async () => {
      runs += 1;
    });

    await queue.enqueue('test.count', {}, { idempotencyKey: 'once' });
    await queue.enqueue('test.count', {}, { idempotencyKey: 'once' });
    await queue.drain();

    expect(runs).toBe(1);
  });

  it('retries failures up to maxAttempts then dead-letters', async () => {
    const queue = new InMemoryJobQueue();
    let attempts = 0;
    queue.register('test.flaky', async () => {
      attempts += 1;
      throw new Error('always fails');
    });

    await queue.enqueue(
      'test.flaky',
      {},
      { retry: { maxAttempts: 3, backoff: { type: 'fixed', delayMs: 0 } } },
    );
    await queue.drain();

    expect(attempts).toBe(3);
    expect(queue.deadLetters).toHaveLength(1);
    expect(queue.deadLetters[0]?.reason).toBe('always fails');
  });

  it('recovers when a retry eventually succeeds', async () => {
    const queue = new InMemoryJobQueue();
    let attempts = 0;
    queue.register('test.recovers', async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('transient');
    });

    await queue.enqueue(
      'test.recovers',
      {},
      { retry: { maxAttempts: 5, backoff: { type: 'fixed', delayMs: 0 } } },
    );
    await queue.drain();

    expect(attempts).toBe(2);
    expect(queue.deadLetters).toHaveLength(0);
  });

  it('supports cancellation of pending jobs', async () => {
    const queue = new InMemoryJobQueue();
    let runs = 0;
    queue.register('test.cancel', async () => {
      runs += 1;
    });

    const id = await queue.enqueue('test.cancel', {});
    expect(await queue.cancel(id)).toBe(true);
    await queue.drain();

    expect(runs).toBe(0);
  });
});
