import { domainOf } from './signals';

/**
 * Fetch concurrency and per-domain politeness (ADR-0030).
 *
 * Discovery previously fetched pages one at a time, which is slow, and with no
 * per-host spacing, which is impolite: a run that discovers twenty pages on one
 * site would hit it twenty times as fast as it could.
 *
 * This bounds total in-flight fetches AND enforces a minimum gap between
 * requests to the same host, honouring a `Crawl-delay` when robots.txt states
 * one. Politeness is per-host; parallelism is across hosts.
 */

export interface FetchSchedulerOptions {
  /** Total simultaneous fetches across all hosts. */
  concurrency?: number;
  /** Minimum gap between two requests to the same host. */
  perDomainDelayMs?: number;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PER_DOMAIN_DELAY_MS = 1_000;

export class FetchScheduler {
  private readonly concurrency: number;
  private readonly perDomainDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Host → time the next request to it may start. */
  private readonly nextAllowedAt = new Map<string, number>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: FetchSchedulerOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.perDomainDelayMs = Math.max(0, options.perDomainDelayMs ?? DEFAULT_PER_DOMAIN_DELAY_MS);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Runs `task` under the concurrency cap, after any per-host wait.
   * `crawlDelaySeconds` (from robots.txt) overrides the default gap when larger
   * — a site asking for more space gets it.
   */
  async run<T>(url: string, task: () => Promise<T>, crawlDelaySeconds?: number | null): Promise<T> {
    await this.acquire();
    try {
      const host = domainOf(url);
      const gap = Math.max(
        this.perDomainDelayMs,
        crawlDelaySeconds != null ? crawlDelaySeconds * 1000 : 0,
      );
      const earliest = this.nextAllowedAt.get(host) ?? 0;
      const waitMs = earliest - this.now();
      if (waitMs > 0) await this.sleep(waitMs);
      // Reserve this host's next slot before running, so parallel tasks for the
      // same host queue behind each other rather than all passing the check.
      this.nextAllowedAt.set(host, Math.max(this.now(), earliest) + gap);
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }
}
