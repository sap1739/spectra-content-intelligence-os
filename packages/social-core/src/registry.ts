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
  private readonly wired = new Set<SocialPlatform>();

  register(publisher: SocialPublisher): void {
    this.publishers.set(publisher.platform, publisher);
    this.wired.add(publisher.platform);
  }

  getPublisher(platform: SocialPlatform): SocialPublisher | undefined {
    return this.publishers.get(platform);
  }

  /**
   * Marks a platform as having a real adapter available. Used for the "wired"
   * UI signal by adapters (like WordPress) that build a per-account instance at
   * publish time rather than registering a shared credential-less publisher.
   */
  markWired(platform: SocialPlatform): void {
    this.wired.add(platform);
  }

  isWired(platform: SocialPlatform): boolean {
    return this.wired.has(platform);
  }

  wiredPlatforms(): SocialPlatform[] {
    return [...this.wired];
  }
}

/** Shared empty registry — no adapters wired in this phase. */
export const socialPublisherRegistry = new SocialPublisherRegistry();
