/**
 * Deterministic signal → component math feeding the trend scoring engine.
 * All outputs are normalized to [0, 1].
 */

const MS_PER_DAY = 86_400_000;

/** Exponential decay: 1.0 when fresh, ~0.5 at the half-life, → 0 with age. */
export function freshnessScore(publishedAt: Date | null, now: Date, halfLifeDays = 7): number {
  if (!publishedAt) return 0.3; // unknown date: conservative, not zero
  const ageDays = Math.max(0, (now.getTime() - publishedAt.getTime()) / MS_PER_DAY);
  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}

/** Share of window activity landing in the recent slice (7d of 30d). */
export function velocityScore(recentCount: number, windowCount: number): number {
  if (windowCount <= 0) return 0;
  // 7/30 ≈ 0.23 is "steady"; scale so steady ≈ 0.5 and all-recent = 1.
  const share = recentCount / windowCount;
  return Math.min(1, share / 0.47);
}

/** Distinct publishers relative to finding count. */
export function sourceDiversityScore(distinctPublishers: number, findingCount: number): number {
  if (findingCount <= 0) return 0;
  return Math.min(1, distinctPublishers / Math.min(findingCount, 5));
}

/** Domain credibility: vertical trust lists move a neutral prior. */
export function credibilityScore(domain: string, trustedDomains: readonly string[]): number {
  const normalized = domain.toLowerCase();
  const trusted = trustedDomains.some(
    (t) => normalized === t.toLowerCase() || normalized.endsWith(`.${t.toLowerCase()}`),
  );
  return trusted ? 0.9 : 0.5;
}

export function domainOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}
