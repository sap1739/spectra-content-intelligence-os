/**
 * Validates the `[n]` citation markers a model wrote against the ordered set of
 * grounding sources it was actually given. This is the check that keeps drafts
 * honest: a marker outside `[1..sourceCount]` references a source that was never
 * supplied — i.e. a fabricated citation — and is surfaced, not trusted.
 */

export interface CitationValidation {
  /** Total `[n]` marker occurrences in the body. */
  markersFound: number;
  /** Sorted distinct marker numbers referenced. */
  distinctMarkers: number[];
  /** Number of grounding sources supplied to the model. */
  sourceCount: number;
  /** Distinct markers within `[1..sourceCount]`. */
  supportedMarkers: number[];
  /** Distinct markers outside range — fabricated / dangling references. */
  unsupportedMarkers: number[];
  /** Grounding source ids actually cited (by supported markers), in order. */
  citedSourceIds: string[];
  /** True when every marker maps to a supplied source. */
  allCitedSupported: boolean;
  /** Supplied sources that were never cited (informational). */
  uncitedSourceIds: string[];
}

const MARKER = /\[(\d{1,3})\]/g;

/**
 * @param body The generated draft text.
 * @param groundedSourceOrder The 1-indexed source order supplied to the model
 *   (findings then citations — see `buildDraftPrompt`).
 */
export function validateCitations(
  body: string,
  groundedSourceOrder: readonly string[],
): CitationValidation {
  const sourceCount = groundedSourceOrder.length;
  const seen = new Set<number>();
  let markersFound = 0;

  for (const match of body.matchAll(MARKER)) {
    markersFound += 1;
    seen.add(Number(match[1]));
  }

  const distinctMarkers = [...seen].sort((a, b) => a - b);
  const supportedMarkers = distinctMarkers.filter((n) => n >= 1 && n <= sourceCount);
  const unsupportedMarkers = distinctMarkers.filter((n) => n < 1 || n > sourceCount);
  const citedSourceIds = supportedMarkers.map((n) => groundedSourceOrder[n - 1] as string);
  const citedSet = new Set(citedSourceIds);
  const uncitedSourceIds = groundedSourceOrder.filter((id) => !citedSet.has(id));

  return {
    markersFound,
    distinctMarkers,
    sourceCount,
    supportedMarkers,
    unsupportedMarkers,
    citedSourceIds,
    allCitedSupported: unsupportedMarkers.length === 0,
    uncitedSourceIds,
  };
}
