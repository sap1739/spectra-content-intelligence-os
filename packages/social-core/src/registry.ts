import type { SocialPlatform } from '@spectra/contracts';

import type { SocialPublisher } from './publisher';

/**
 * Registry of live platform publishers. In Phase 4A NONE are registered — no
 * social platform is wired — so `getPublisher` returns undefined and callers
 * surface an honest "live publishing is not enabled for <platform>" state
 * rather than pretending a post went out. A later phase registers real
 * adapters here (env-gated on platform credentials).
 */
export class SocialPublisherRegistry {
  private readonly publishers = new Map<SocialPlatform, SocialPublisher>();

  register(publisher: SocialPublisher): void {
    this.publishers.set(publisher.platform, publisher);
  }

  getPublisher(platform: SocialPlatform): SocialPublisher | undefined {
    return this.publishers.get(platform);
  }

  isWired(platform: SocialPlatform): boolean {
    return this.publishers.has(platform);
  }

  wiredPlatforms(): SocialPlatform[] {
    return [...this.publishers.keys()];
  }
}

/** Shared empty registry — no adapters wired in this phase. */
export const socialPublisherRegistry = new SocialPublisherRegistry();
