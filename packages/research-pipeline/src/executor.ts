import type { EmbeddingProvider } from '@spectra/ai-core';
import type { ResearchRunStats } from '@spectra/contracts';
import { PgVectorStore, type Prisma, type SpectraPrismaClient } from '@spectra/database';
import { resolveEmbedding, type VectorStoreProvider } from '@spectra/knowledge-core';
import type { Logger } from '@spectra/logging';
import { buildObjectKey, type ObjectStorageProvider } from '@spectra/storage';

import { extractClaims } from './claims';
import {
  DEFAULT_TREND_SCORING_CONFIG,
  WeightedTrendScoringEngine,
  canTransitionTrend,
} from '@spectra/trend-core';

import type { DocumentExtractionProvider, ResearchProviderRegistry } from '@spectra/research-core';

import {
  NoopUsageRecorder,
  preflight,
  reconcile,
  release,
  type UsageRecorder,
} from '@spectra/metering';

import { candidatesFromFeed, candidatesFromSearch, type CandidateItem } from './discovery';
import { FetchScheduler } from './fetch-scheduler';
import {
  SNIPPET_ONLY_CONFIDENCE_FACTOR,
  diversityWeightFor,
  evaluateDomain,
  evaluateEligibility,
  evaluateFreshness,
  type DomainPolicyEntry,
  type FreshnessDecayConfig,
} from './quality';
import { RobotsGateway } from './robots';
import { verifyProjectClaims } from './verify-claims';
import { HtmlExtractionProvider } from './extraction';
import { sha256Hex, titleKey, urlHash } from './hashing';
import { FirstPartyRssProvider } from './rss';
import { assertSafeUrl, type SafeFetchOptions } from './safe-fetch';
import { sourceDiversityScore, velocityScore } from './signals';
import { METRICS, metrics } from '@spectra/telemetry';

export const PIPELINE_VERSION = 'rss-pipeline/1.0.0';
const DEFAULT_MAX_PAGE_FETCHES = 100;
const TREND_WINDOW_DAYS = 30;
const TREND_RECENT_DAYS = 7;
const MS_PER_DAY = 86_400_000;

export interface PipelineDeps {
  prisma: SpectraPrismaClient;
  storage: ObjectStorageProvider;
  logger: Logger;
  fetchOptions?: SafeFetchOptions;
  scoringConfig?: typeof DEFAULT_TREND_SCORING_CONFIG;
  /** Defaults to the first-party lexical hashing embedder (ADR-0016). */
  embedder?: EmbeddingProvider;
  /** Defaults to the pgvector store bound to `prisma`. */
  vectorStore?: VectorStoreProvider;
  /**
   * Discovery providers (web/news search). Omitted or empty => the run uses
   * only its configured feeds; search discovery is honestly unavailable.
   */
  providerRegistry?: ResearchProviderRegistry;
  /** Fetch discovered pages for full text (default true). */
  fetchDiscoveredPages?: boolean;
  /** Records real provider spend. Defaults to discarding (no ledger). */
  usage?: UsageRecorder;
  /** Hard ceiling on pages fetched per run (default 100). */
  maxPageFetchesPerRun?: number;
  /** Simultaneous page fetches across hosts (default 4). */
  fetchConcurrency?: number;
  /** Minimum gap between requests to one host (default 1000ms). */
  perDomainDelayMs?: number;
  /** Overrides for freshness decay (ADR-0030). */
  freshnessConfig?: Partial<FreshnessDecayConfig>;
  /** Disables robots.txt checking. Test-only; never in production. */
  skipRobots?: boolean;
  /**
   * Turns discovered PDF/DOCX/TXT bytes into anchored text (ADR-0031).
   * Omitted => documents stay snippet-only, as before 5G.
   */
  documentExtractor?: DocumentExtractionProvider;
  now?: () => Date;
}

export interface ExecuteRunInput {
  runId: string;
  signal?: AbortSignal;
  onProgress?: (percent: number, note?: string) => Promise<void>;
}

export interface RunOutcome {
  status: 'SUCCEEDED' | 'PARTIALLY_SUCCEEDED' | 'FAILED';
  stats: ResearchRunStats;
}

interface QueryPlan {
  feedUrls: string[];
  /** Free-text queries run against registered discovery providers (ADR-0025). */
  searchQueries?: string[];
}

function emptyStats(): ResearchRunStats {
  return {
    queriesPlanned: 0,
    queriesExecuted: 0,
    sourcesDiscovered: 0,
    sourcesFetched: 0,
    findingsExtracted: 0,
    duplicatesRemoved: 0,
    claimsExtracted: 0,
    robotsBlocked: 0,
    snippetOnly: 0,
    documentsExtracted: 0,
    documentExtractionFailures: 0,
    claimsEligible: 0,
    claimsRequiringReview: 0,
    claimContradictions: 0,
    blockedDomainRejected: 0,
    evidenceEligible: 0,
    duplicateClusters: 0,
  };
}

function matchKeywords(text: string, keywords: readonly string[]): string[] {
  const haystack = text.toLowerCase();
  return keywords.filter((keyword) => haystack.includes(keyword.toLowerCase()));
}

/**
 * Executes one research run end-to-end: RSS discovery → retrieval + snapshot
 * → extraction + injection scan → dedup → topic tagging → findings →
 * explainable trend scoring. Idempotent: re-delivery skips already-ingested
 * sources via the per-workspace urlHash constraint.
 */
export async function executeResearchRun(
  deps: PipelineDeps,
  input: ExecuteRunInput,
): Promise<RunOutcome> {
  // Wrapped so the histogram covers the whole run, including the failure path.
  return metrics.time(METRICS.researchRunDuration, {}, () => runResearch(deps, input));
}

async function runResearch(deps: PipelineDeps, input: ExecuteRunInput): Promise<RunOutcome> {
  const now = deps.now ?? (() => new Date());
  const usage = deps.usage ?? new NoopUsageRecorder();
  const logger = deps.logger.child({ runId: input.runId });
  const rss = new FirstPartyRssProvider(deps.fetchOptions);
  const extraction = new HtmlExtractionProvider();
  const engine = new WeightedTrendScoringEngine(deps.scoringConfig ?? DEFAULT_TREND_SCORING_CONFIG);
  // Provider and collection resolve together so ingestion and search can never
  // disagree about which model's vectors live where (ADR-0023).
  const embedding = resolveEmbedding(deps.embedder);
  const embedder = embedding.provider;
  const vectorStore = deps.vectorStore ?? new PgVectorStore(deps.prisma);

  const run = await deps.prisma.researchRun.findUnique({
    where: { id: input.runId },
    include: { project: { include: { vertical: true } } },
  });
  if (!run) throw new Error(`Research run ${input.runId} not found`);
  if (run.status === 'SUCCEEDED' || run.status === 'CANCELLED') {
    logger.info({ status: run.status }, 'Run already finalized — skipping re-delivery');
    return { status: 'SUCCEEDED', stats: emptyStats() };
  }

  const tenant = { organizationId: run.organizationId, workspaceId: run.workspaceId };
  const vertical = run.project.vertical;
  const keywords = vertical?.keywords ?? [];
  const excludedKeywords = vertical?.excludedKeywords ?? [];
  const trustedDomains = vertical?.trustedDomains ?? [];
  const blockedDomains = (vertical?.blockedDomains ?? []).map((d) => d.toLowerCase());
  // Workspace-level domain policy layers over the vertical's lists and can
  // carry an explicit credibility number and an evergreen flag (ADR-0030).
  const domainPolicies: DomainPolicyEntry[] = (
    await deps.prisma.domainPolicy.findMany({
      where: { organizationId: tenant.organizationId, workspaceId: tenant.workspaceId },
      select: { domain: true, stance: true, credibilityOverride: true, evergreen: true },
    })
  ).map((p) => ({
    domain: p.domain,
    stance: p.stance,
    credibilityOverride: p.credibilityOverride,
    evergreen: p.evergreen,
  }));

  // Re-check the budget at execution time: this job may have been queued before
  // the workspace hit its ceiling. Marked FAILED and returned WITHOUT throwing,
  // because retrying cannot help until the limit is raised or the month rolls
  // over — a retry would just burn queue attempts on a run that must not spend.
  const budget = await preflight(
    deps.prisma,
    {
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      kind: 'RESEARCH_RUN',
      provider: 'spectra',
      requests: 1,
    },
    now(),
  );
  if (budget.blocked) {
    // The hold is no longer needed: this run will not spend.
    await release(deps.prisma, tenant, `research-run-${run.id}`, logger);
    await deps.prisma.researchRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', completedAt: now(), failureReason: budget.reason },
    });
    logger.warn(
      { outcome: budget.outcome, exceededReason: budget.exceededReason },
      'Research run refused — workspace budget exceeded',
    );
    return { status: 'FAILED', stats: emptyStats() };
  }

  const stats = emptyStats();
  const feedErrors: string[] = [];

  const checkAbort = () => {
    if (input.signal?.aborted) throw new Error('Run aborted (timeout or cancellation)');
  };

  const setStage = async (stage: string, percent: number) => {
    checkAbort();
    await deps.prisma.researchRun.update({
      where: { id: run.id },
      data: { currentStage: stage, stats: stats as unknown as Prisma.InputJsonValue },
    });
    await input.onProgress?.(percent, stage);
  };

  await deps.prisma.researchRun.update({
    where: { id: run.id },
    data: {
      status: 'RUNNING',
      startedAt: run.startedAt ?? now(),
      failureReason: null,
    },
  });

  try {
    // ----- QUERY_PLANNING -------------------------------------------------
    await setStage('QUERY_PLANNING', 5);
    const plan = run.queryPlan as unknown as QueryPlan;
    const feedUrls = Array.isArray(plan?.feedUrls) ? plan.feedUrls : [];
    const searchQueries = Array.isArray(plan?.searchQueries) ? plan.searchQueries : [];
    const searchable =
      searchQueries.length > 0 &&
      (deps.providerRegistry?.listByKind('web-search').length ?? 0) +
        (deps.providerRegistry?.listByKind('news-search').length ?? 0) >
        0;
    if (feedUrls.length === 0 && !searchable) {
      // Honest: a plan with search queries but no configured provider cannot
      // run, and says so rather than reporting an empty but "successful" run.
      throw new Error(
        searchQueries.length > 0
          ? 'Run has search queries but no live search provider is configured (set BRAVE_SEARCH_API_KEY), and no feed URLs to fall back on'
          : 'Run has no feed URLs in its query plan',
      );
    }
    stats.queriesPlanned = feedUrls.length + (searchable ? searchQueries.length : 0);

    // ----- SOURCE_DISCOVERY / RETRIEVAL / EXTRACTION ----------------------
    await setStage('SOURCE_DISCOVERY', 10);
    const seenTitleKeys = new Map<string, string>(); // titleKey → sourceId (near-dup in run)

    // Both feeds and search results normalize to CandidateItem so there is ONE
    // ingest path — same SSRF guard, dedup, extraction, scoring and provenance.
    const candidates: CandidateItem[] = [];

    for (const feedUrl of feedUrls) {
      checkAbort();
      try {
        candidates.push(...(await candidatesFromFeed(rss, feedUrl)));
        stats.queriesExecuted += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        feedErrors.push(`${feedUrl}: ${message}`);
        logger.warn({ feedUrl, err: message }, 'Feed processing failed');
      }
    }

    if (searchable && deps.providerRegistry) {
      const discovery = await candidatesFromSearch({
        registry: deps.providerRegistry,
        queries: searchQueries,
        tenant,
        ...(deps.fetchOptions ? { fetchOptions: deps.fetchOptions } : {}),
        ...(deps.fetchDiscoveredPages === false ? { fetchPages: false } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        logger,
        usage,
        resourceId: run.id,
        maxPageFetches: deps.maxPageFetchesPerRun ?? DEFAULT_MAX_PAGE_FETCHES,
        // Ask robots.txt before every discovered-page fetch (ADR-0030).
        // `skipRobots` exists only so fixture servers in tests need not serve
        // a robots.txt; it must never be set in production.
        ...(deps.skipRobots
          ? {}
          : {
              robots: new RobotsGateway({
                prisma: deps.prisma,
                ...(deps.fetchOptions ? { fetchOptions: deps.fetchOptions } : {}),
                logger,
              }),
            }),
        ...(deps.documentExtractor ? { documentExtractor: deps.documentExtractor } : {}),
        scheduler: new FetchScheduler({
          ...(deps.fetchConcurrency !== undefined ? { concurrency: deps.fetchConcurrency } : {}),
          ...(deps.perDomainDelayMs !== undefined
            ? { perDomainDelayMs: deps.perDomainDelayMs }
            : {}),
        }),
      });
      candidates.push(...discovery.candidates);
      stats.queriesExecuted += discovery.executed;
      // A failed search is recorded, never silently treated as "found nothing".
      feedErrors.push(...discovery.errors);
    }

    await setStage('CONTENT_EXTRACTION', 20);

    for (const [candidateIndex, candidate] of candidates.entries()) {
      {
        {
          checkAbort();
          try {
            assertSafeUrl(candidate.url, deps.fetchOptions?.allowPrivateHosts ?? false);
          } catch {
            continue; // hostile/invalid item link — skip silently
          }
          // Workspace policy beats vertical list; BLOCKED beats TRUSTED.
          const domainVerdict = evaluateDomain(candidate.url, {
            trustedDomains,
            blockedDomains,
            policies: domainPolicies,
          });
          const domain = domainVerdict.domain;
          stats.sourcesDiscovered += 1;
          if (domainVerdict.stance === 'BLOCKED') {
            // Counted and reported, not silently dropped: an operator must be
            // able to see that their block list is what removed these.
            stats.blockedDomainRejected += 1;
            continue;
          }

          // Exact duplicate: URL already ingested in this workspace.
          const uHash = urlHash(candidate.url);
          const existingByUrl = await deps.prisma.researchSource.findFirst({
            where: {
              organizationId: tenant.organizationId,
              workspaceId: tenant.workspaceId,
              urlHash: uHash,
            },
            select: { id: true },
          });
          if (existingByUrl) {
            stats.duplicatesRemoved += 1;
            continue;
          }

          const rawHtml = candidate.rawHtml;
          const extracted = await extraction.extract(
            { html: rawHtml, sourceUrl: candidate.url },
            tenant,
          );
          const text = extracted.text;
          const fullText = `${candidate.title ?? ''}\n${text}`;

          if (excludedKeywords.length > 0 && matchKeywords(fullText, excludedKeywords).length > 0) {
            continue; // vertical explicitly excludes this content
          }

          const publishedAt = candidate.publishedAt ? new Date(candidate.publishedAt) : null;
          const contentHash = sha256Hex(text || candidate.url);
          const credibility = domainVerdict.credibility;
          const freshnessResult = evaluateFreshness(publishedAt, now(), {
            evergreen: domainVerdict.evergreen,
            ...(deps.freshnessConfig ? { config: deps.freshnessConfig } : {}),
          });
          const freshness = freshnessResult.score;
          const blocked = extracted.injectionRisk?.disposition === 'BLOCK';
          if (candidate.robotsDecision === 'DISALLOWED') stats.robotsBlocked += 1;
          if (candidate.snippetOnly) stats.snippetOnly += 1;
          if (candidate.document) {
            stats.documentsExtracted += candidate.document.failureCode ? 0 : 1;
            stats.documentExtractionFailures += candidate.document.failureCode ? 1 : 0;
            // Counter-only metering so per-kind limits can bound extraction
            // volume; it is first-party work with no vendor charge.
            await usage.record(tenant, {
              kind: 'DOCUMENT_EXTRACTION',
              provider: 'first-party',
              model: candidate.document.documentType,
              requests: 1,
              resourceType: 'RESEARCH_RUN',
              resourceId: run.id,
              metadata: candidate.document.failureCode
                ? { failureCode: candidate.document.failureCode }
                : { pageCount: candidate.document.pageCount },
            });
          }

          // Near-duplicates: identical extracted content anywhere in the
          // workspace, or same normalized title within this run.
          const tKey = candidate.title ? titleKey(candidate.title) : null;
          const existingByContent = await deps.prisma.researchSource.findFirst({
            where: {
              organizationId: tenant.organizationId,
              workspaceId: tenant.workspaceId,
              contentHash,
            },
            select: { id: true },
          });
          const nearDupOfId =
            existingByContent?.id ?? (tKey ? (seenTitleKeys.get(tKey) ?? null) : null);

          const eligibility = evaluateEligibility({
            stance: domainVerdict.stance,
            snippetOnly: candidate.snippetOnly,
            robotsDecision: candidate.robotsDecision,
            injectionBlocked: blocked,
            isDuplicate: nearDupOfId !== null,
          });
          if (eligibility.eligible && !blocked && !nearDupOfId) stats.evidenceEligible += 1;

          const source = await deps.prisma.researchSource.create({
            data: {
              organizationId: tenant.organizationId,
              workspaceId: tenant.workspaceId,
              projectId: run.projectId,
              runId: run.id,
              url: candidate.url,
              urlHash: uHash,
              title: candidate.title ?? null,
              publisher: candidate.publisher ?? domain,
              author: candidate.author ?? null,
              publishedAt,
              retrievedAt: now(),
              language: candidate.language ?? null,
              category: candidate.category,
              credibilityScore: credibility,
              freshnessScore: freshness,
              contentHash,
              duplicateOfSourceId: nearDupOfId,
              duplicateClusterKey: nearDupOfId ? contentHash : null,
              provenance: {
                providerId: candidate.provenance.providerId,
                providerKind: candidate.provenance.providerKind,
                requestRef: candidate.provenance.requestRef,
                retrievedAt: now().toISOString(),
                pipelineVersion: PIPELINE_VERSION,
                // Snippet-only means the page could not be fetched — a finding
                // built from it must never look like one from the full article.
                snippetOnly: candidate.snippetOnly,
              },
              snippetOnly: candidate.snippetOnly,
              // Document provenance (ADR-0031): type, page count, and the
              // failure code when extraction was attempted and did not work.
              documentType: candidate.document?.documentType ?? null,
              documentPageCount: candidate.document?.pageCount ?? null,
              extractionFailureCode: candidate.document?.failureCode ?? null,
              robotsDecision: candidate.robotsDecision,
              robotsCheckedAt: candidate.robotsDecision === 'NOT_CHECKED' ? null : now(),
              stalenessStatus: freshnessResult.status,
              evidenceEligible: eligibility.eligible,
              evidenceExclusionReason: eligibility.reason,
              diversityWeight: nearDupOfId ? diversityWeightFor(2) : 1,
              processingStatus:
                candidate.robotsDecision === 'DISALLOWED'
                  ? 'ROBOTS_BLOCKED'
                  : blocked
                    ? 'SKIPPED'
                    : nearDupOfId
                      ? 'DEDUPLICATED'
                      : 'EXTRACTED',
              metadata: {
                ...(blocked ? { injectionRiskLevel: extracted.injectionRisk?.riskLevel } : {}),
                ...(candidate.fetchNote ? { fetchNote: candidate.fetchNote } : {}),
                domainStance: domainVerdict.stance,
                domainVerdictSource: domainVerdict.source,
                ...(freshnessResult.ageDays !== null
                  ? { ageDays: Math.round(freshnessResult.ageDays * 10) / 10 }
                  : {}),
              },
            },
          });
          if (tKey && !nearDupOfId) seenTitleKeys.set(tKey, source.id);

          // Immutable snapshot of the raw item content → object storage.
          const storageKey = buildObjectKey({
            organizationId: tenant.organizationId,
            workspaceId: tenant.workspaceId,
            domain: 'research-snapshots',
            resourceId: source.id,
            filename: 'candidate.html',
          });
          await deps.storage.putObject({
            key: storageKey,
            body: rawHtml || candidate.url,
            contentType: 'text/html; charset=utf-8',
          });
          const snapshot = await deps.prisma.sourceSnapshot.create({
            data: {
              organizationId: tenant.organizationId,
              workspaceId: tenant.workspaceId,
              sourceId: source.id,
              retrievedAt: now(),
              contentHash,
              storageKey,
              mimeType: 'text/html',
              sizeBytes: Buffer.byteLength(rawHtml || candidate.url, 'utf8'),
              extractionStatus: blocked ? 'FAILED' : 'EXTRACTED',
            },
          });
          stats.sourcesFetched += 1;

          if (blocked) {
            logger.warn(
              { sourceId: source.id, riskLevel: extracted.injectionRisk?.riskLevel },
              'Source quarantined by prompt-injection scan',
            );
            continue;
          }
          if (nearDupOfId) {
            stats.duplicatesRemoved += 1;
            continue;
          }

          const topics = matchKeywords(fullText, keywords);
          const finding = await deps.prisma.researchFinding.create({
            data: {
              organizationId: tenant.organizationId,
              workspaceId: tenant.workspaceId,
              projectId: run.projectId,
              runId: run.id,
              sourceId: source.id,
              snapshotId: snapshot.id,
              summary: candidate.title ?? text.slice(0, 180) ?? candidate.url,
              excerpt: text.slice(0, 800) || null,
              credibilityScore: credibility,
              freshnessScore: freshness,
              language: candidate.language ?? null,
              sourceCategory: 'NEWS',
              topics,
              entities: [],
              provenance: {
                providerId: candidate.provenance.providerId,
                providerKind: candidate.provenance.providerKind,
                requestRef: candidate.provenance.requestRef,
                retrievedAt: now().toISOString(),
                pipelineVersion: PIPELINE_VERSION,
                // Snippet-only means the page could not be fetched — a finding
                // built from it must never look like one from the full article.
                snippetOnly: candidate.snippetOnly,
              },
              status: 'PENDING_REVIEW',
              processingStage: 'HUMAN_REVIEW',
            },
          });
          await deps.prisma.researchSource.update({
            where: { id: source.id },
            // Keep the more specific terminal status: a source we were not
            // allowed to fetch is ROBOTS_BLOCKED even though we analysed its
            // snippet. Overwriting it would hide why the text is thin.
            data: {
              processingStatus:
                candidate.robotsDecision === 'DISALLOWED' ? 'ROBOTS_BLOCKED' : 'ANALYZED',
            },
          });
          stats.findingsExtracted += 1;

          // CLAIM_EXTRACTION: heuristic claims, corroborated across sources.
          const heuristicClaims = extractClaims(`${candidate.title ?? ''}. ${text}`);
          let firstClaimId: string | null = null;
          for (const heuristic of heuristicClaims) {
            const existingClaim = await deps.prisma.extractedClaim.findFirst({
              where: {
                organizationId: tenant.organizationId,
                projectId: run.projectId,
                normalizedKey: heuristic.normalizedKey,
              },
            });
            if (!existingClaim) {
              const created = await deps.prisma.extractedClaim.create({
                data: {
                  organizationId: tenant.organizationId,
                  workspaceId: tenant.workspaceId,
                  projectId: run.projectId,
                  text: heuristic.text,
                  normalizedKey: heuristic.normalizedKey,
                  claimType: heuristic.claimType,
                  verificationStatus: 'UNVERIFIED',
                  supportingFindingIds: [finding.id],
                  sourceCount: 1,
                },
              });
              firstClaimId ??= created.id;
              stats.claimsExtracted += 1;
            } else {
              const supportingIds = [
                ...new Set([...existingClaim.supportingFindingIds, finding.id]),
              ];
              const supporters = await deps.prisma.researchFinding.findMany({
                where: { organizationId: tenant.organizationId, id: { in: supportingIds } },
                select: { sourceId: true },
              });
              const distinctSources = new Set(supporters.map((s) => s.sourceId)).size;
              await deps.prisma.extractedClaim.update({
                where: { id: existingClaim.id },
                data: {
                  supportingFindingIds: supportingIds,
                  sourceCount: distinctSources,
                  verificationStatus:
                    existingClaim.verificationStatus === 'UNVERIFIED' && distinctSources >= 2
                      ? 'CORROBORATED'
                      : existingClaim.verificationStatus,
                },
              });
              firstClaimId ??= existingClaim.id;
            }
          }

          // CITATION_CAPTURE: the audit anchor for this finding.
          const excerptLength = Math.min(text.length, 300);
          await deps.prisma.citation.create({
            data: {
              organizationId: tenant.organizationId,
              workspaceId: tenant.workspaceId,
              projectId: run.projectId,
              findingId: finding.id,
              sourceId: source.id,
              snapshotId: snapshot.id,
              claimId: firstClaimId,
              url: candidate.url,
              title: candidate.title ?? null,
              publisher: candidate.publisher ?? domain,
              publishedAt,
              retrievedAt: now(),
              excerpt: text.slice(0, excerptLength) || null,
              startOffset: 0,
              endOffset: excerptLength,
            },
          });

          // KNOWLEDGE_BASE_STORAGE: embed → pgvector. Stored as a passage
          // ('document'), which real models encode differently from a query.
          const embedText = `${candidate.title ?? ''}\n${text.slice(0, 1500)}`.trim();
          if (embedText.length > 0) {
            const embedResult = await embedder.embed([embedText], tenant, 'document');
            const [vector] = embedResult.vectors;
            // Meter only what the provider actually reported.
            if (embedResult.usage) {
              await usage.record(tenant, {
                kind: 'AI_EMBEDDING',
                provider: embedder.modelRef.provider,
                model: embedder.modelRef.model,
                totalTokens: embedResult.usage.totalTokens,
                resourceType: 'RESEARCH_RUN',
                resourceId: run.id,
              });
            }
            await vectorStore.upsertChunks({
              tenant,
              collection: embedding.collection,
              chunks: [
                {
                  chunk: {
                    id: finding.id,
                    organizationId: tenant.organizationId,
                    workspaceId: tenant.workspaceId,
                    documentId: source.id,
                    index: 0,
                    text: `${candidate.title ?? ''} — ${text.slice(0, 500)}`.trim(),
                    headingPath: [],
                    metadata: {
                      kind: 'RESEARCH_FINDING',
                      findingId: finding.id,
                      projectId: run.projectId,
                      sourceUrl: candidate.url,
                      title: candidate.title ?? null,
                    },
                    embedding: {
                      provider: embedder.modelRef.provider,
                      model: embedder.modelRef.model,
                      dimensions: embedder.dimensions,
                      vectorId: finding.id,
                    },
                  },
                  vector: vector as number[],
                },
              ],
            });
          }
        }
      }
      if (candidates.length > 0 && (candidateIndex + 1) % 10 === 0) {
        await setStage(
          'CONTENT_EXTRACTION',
          20 + Math.round(((candidateIndex + 1) / candidates.length) * 40),
        );
      }
    }

    // ----- DUPLICATE_DETECTION marker (work happened inline above) --------
    await setStage('DUPLICATE_DETECTION', 65);

    // ----- CLAIM_VERIFICATION ----------------------------------------------
    // Assess how well each claim is actually supported BEFORE any evidence pack
    // is built from it (ADR-0032). Corroboration counts independent sources
    // only, so syndicated repetition cannot manufacture confidence.
    await setStage('CLAIM_VERIFICATION', 70);
    const verification = await verifyProjectClaims(
      deps.prisma,
      {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        projectId: run.projectId,
        now: now(),
      },
      logger,
    );
    stats.claimsEligible = verification.eligible;
    stats.claimsRequiringReview = verification.requiresReview;
    stats.claimContradictions = verification.contradictionsDetected;

    // ----- TREND_SCORING ---------------------------------------------------
    await setStage('TREND_SCORING', 75);
    if (keywords.length > 0) {
      const watchlists = await deps.prisma.trendWatchlist.findMany({
        where: { organizationId: tenant.organizationId, workspaceId: tenant.workspaceId },
      });
      const windowStart = new Date(now().getTime() - TREND_WINDOW_DAYS * MS_PER_DAY);
      const recentStart = new Date(now().getTime() - TREND_RECENT_DAYS * MS_PER_DAY);
      const findings = await deps.prisma.researchFinding.findMany({
        where: {
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId,
          projectId: run.projectId,
          status: { not: 'REJECTED' },
          deletedAt: null,
          createdAt: { gte: windowStart },
        },
        select: {
          id: true,
          topics: true,
          credibilityScore: true,
          freshnessScore: true,
          sourceId: true,
          createdAt: true,
          source: {
            select: {
              publishedAt: true,
              publisher: true,
              // 5F quality inputs: a snippet-only or syndicated source must not
              // contribute like a fully-retrieved, independent one (ADR-0030).
              snippetOnly: true,
              duplicateClusterKey: true,
              duplicateOfSourceId: true,
              evidenceEligible: true,
            },
          },
        },
      });

      for (const keyword of keywords) {
        checkAbort();
        const topicFindings = findings.filter((f) => f.topics.includes(keyword));
        if (topicFindings.length === 0) continue;

        // Only evidence-eligible findings feed a trend score. Blocked domains
        // and duplicates are already excluded upstream; this is the safety net.
        const scoreable = topicFindings.filter((f) => f.source.evidenceEligible);
        if (scoreable.length === 0) continue;

        const distinctSources = new Set(scoreable.map((f) => f.sourceId));

        // Syndication-aware diversity: one wire story republished by ten outlets
        // is ONE corroboration, not ten. Cluster members collapse to a single
        // unit before publishers are counted, so re-publication cannot inflate
        // confidence.
        const diversityUnits = new Set(
          scoreable.map(
            (f) =>
              f.source.duplicateClusterKey ??
              f.source.duplicateOfSourceId ??
              `publisher:${f.source.publisher ?? 'unknown'}`,
          ),
        );

        const observedAt = (f: (typeof scoreable)[number]) => f.source.publishedAt ?? f.createdAt;
        const recentCount = scoreable.filter((f) => observedAt(f) >= recentStart).length;

        // Snippet-only findings carry real but weaker evidence, so they are
        // weighted down rather than dropped — an average that treats a snippet
        // like a full article overstates what we actually read.
        const weightOf = (f: (typeof scoreable)[number]) =>
          f.source.snippetOnly ? SNIPPET_ONLY_CONFIDENCE_FACTOR : 1;
        const weightedAvg = (pick: (f: (typeof scoreable)[number]) => number) => {
          let num = 0;
          let den = 0;
          for (const f of scoreable) {
            const w = weightOf(f);
            num += pick(f) * w;
            den += w;
          }
          return den === 0 ? 0 : num / den;
        };
        // Effective source count also discounts snippets, so a trend supported
        // only by snippets does not reach the verification threshold on volume.
        const effectiveSourceCount = Math.round(
          [...distinctSources].reduce((sum, id) => {
            const f = scoreable.find((x) => x.sourceId === id);
            return sum + (f ? weightOf(f) : 0);
          }, 0),
        );

        const topicKey = titleKey(keyword).replace(/ /g, '-');
        let candidate = await deps.prisma.trendCandidate.findFirst({
          where: {
            organizationId: tenant.organizationId,
            workspaceId: tenant.workspaceId,
            projectId: run.projectId,
            topicKey,
            deletedAt: null,
          },
        });
        if (!candidate) {
          candidate = await deps.prisma.trendCandidate.create({
            data: {
              organizationId: tenant.organizationId,
              workspaceId: tenant.workspaceId,
              projectId: run.projectId,
              verticalId: vertical?.id ?? null,
              topicKey,
              title: keyword,
              state: 'UNVERIFIED',
              firstSeenAt: now(),
            },
          });
        }

        const result = engine.score(
          {
            trendCandidateId: candidate.id,
            components: {
              freshness: weightedAvg((f) => f.freshnessScore ?? 0),
              velocity: velocityScore(recentCount, scoreable.length),
              sourceDiversity: sourceDiversityScore(diversityUnits.size, scoreable.length),
              sourceCredibility: weightedAvg((f) => f.credibilityScore ?? 0.5),
            },
            sourceCount: effectiveSourceCount,
          },
          now,
        );

        const config = deps.scoringConfig ?? DEFAULT_TREND_SCORING_CONFIG;
        const canVerify = effectiveSourceCount >= config.minimumSourceCount;
        const nextState =
          candidate.state === 'UNVERIFIED' &&
          canVerify &&
          canTransitionTrend('UNVERIFIED', 'EMERGING')
            ? 'EMERGING'
            : candidate.state;

        await deps.prisma.trendCandidate.update({
          where: { id: candidate.id },
          data: {
            title: keyword,
            summary: `${topicFindings.length} finding(s) from ${distinctSources.size} source(s) in the last ${TREND_WINDOW_DAYS} days`,
            state: nextState,
            normalizedScore: result.normalizedScore,
            latestScore: result as unknown as Prisma.InputJsonValue,
            scoringConfigId: result.configId,
            scoringConfigVersion: result.configVersion,
            findingIds: topicFindings.slice(0, 100).map((f) => f.id),
            sourceIds: [...distinctSources].slice(0, 100),
            lastSeenAt: now(),
          },
        });

        // Alert on lifecycle transitions so reviewers notice new signal.
        if (nextState !== candidate.state) {
          await deps.prisma.trendAlert.create({
            data: {
              organizationId: tenant.organizationId,
              workspaceId: tenant.workspaceId,
              trendCandidateId: candidate.id,
              alertType: 'STATE_CHANGE',
              message: `Trend "${keyword}" moved ${candidate.state} → ${nextState} (${distinctSources.size} distinct sources, score ${result.displayScore.toFixed(1)})`,
            },
          });
        }

        // Watchlists: alert when a watched topic FIRST crosses its threshold.
        const previousScore = candidate.normalizedScore;
        for (const watchlist of watchlists) {
          const watched = watchlist.keywords.some(
            (k) =>
              k.toLowerCase() === keyword.toLowerCase() ||
              titleKey(k).replace(/ /g, '-') === topicKey,
          );
          const crossed =
            result.normalizedScore >= watchlist.threshold &&
            (previousScore === null || previousScore < watchlist.threshold);
          if (watched && crossed) {
            await deps.prisma.trendAlert.create({
              data: {
                organizationId: tenant.organizationId,
                workspaceId: tenant.workspaceId,
                trendCandidateId: candidate.id,
                alertType: 'SCORE_THRESHOLD',
                message: `Watchlist "${watchlist.name}": "${keyword}" crossed ${(watchlist.threshold * 100).toFixed(0)} (score ${result.displayScore.toFixed(1)})`,
              },
            });
          }
        }

        // EVIDENCE_PACK_GENERATION: one living pack per topic per project.
        const topicFindingIds = topicFindings.map((f) => f.id);
        // Only claims that may ground content enter a pack. BLOCKED claims
        // (no support at all, or reviewer-rejected) and REQUIRES_REVIEW claims
        // (contradicted or stale) are deliberately excluded — a pack is the
        // contract handed to generation, and it must not contain evidence the
        // system has already judged unusable (ADR-0032).
        const packClaims = await deps.prisma.extractedClaim.findMany({
          where: {
            organizationId: tenant.organizationId,
            projectId: run.projectId,
            supportingFindingIds: { hasSome: topicFindingIds },
            eligibility: { in: ['ELIGIBLE', 'WEAK'] },
          },
          select: { id: true, eligibility: true },
          orderBy: [{ eligibility: 'asc' }, { independentSourceCount: 'desc' }],
        });
        const packCitations = await deps.prisma.citation.findMany({
          where: {
            organizationId: tenant.organizationId,
            projectId: run.projectId,
            findingId: { in: topicFindingIds },
          },
          select: { id: true },
        });
        await deps.prisma.evidencePack.upsert({
          where: { projectId_topicKey: { projectId: run.projectId, topicKey } },
          create: {
            organizationId: tenant.organizationId,
            workspaceId: tenant.workspaceId,
            projectId: run.projectId,
            trendCandidateId: candidate.id,
            topicKey,
            title: `Evidence — ${keyword}`,
            summary: `${topicFindingIds.length} finding(s), ${packClaims.length} claim(s), ${packCitations.length} citation(s)`,
            status: 'READY',
            findingIds: topicFindingIds.slice(0, 100),
            claimIds: packClaims.map((c) => c.id).slice(0, 100),
            citationIds: packCitations.map((c) => c.id).slice(0, 100),
          },
          update: {
            trendCandidateId: candidate.id,
            title: `Evidence — ${keyword}`,
            summary: `${topicFindingIds.length} finding(s), ${packClaims.length} claim(s), ${packCitations.length} citation(s)`,
            status: 'READY',
            findingIds: topicFindingIds.slice(0, 100),
            claimIds: packClaims.map((c) => c.id).slice(0, 100),
            citationIds: packCitations.map((c) => c.id).slice(0, 100),
          },
        });
      }
      await setStage('EVIDENCE_PACK_GENERATION', 88);
    }

    // ----- Finalize ---------------------------------------------------------
    const anySuccess = stats.queriesExecuted > 0;
    const status: RunOutcome['status'] =
      feedErrors.length === 0 ? 'SUCCEEDED' : anySuccess ? 'PARTIALLY_SUCCEEDED' : 'FAILED';

    await deps.prisma.researchRun.update({
      where: { id: run.id },
      data: {
        status,
        currentStage: 'HUMAN_REVIEW',
        completedAt: now(),
        stats: stats as unknown as Prisma.InputJsonValue,
        failureReason: feedErrors.length > 0 ? feedErrors.join(' | ').slice(0, 3900) : null,
      },
    });
    // Real usage is now in the ledger; stop the hold double-counting it.
    await reconcile(deps.prisma, tenant, `research-run-${run.id}`, logger);
    await input.onProgress?.(100, 'HUMAN_REVIEW');
    logger.info({ status, ...stats }, 'Research run completed');
    return { status, stats };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.prisma.researchRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        completedAt: now(),
        stats: stats as unknown as Prisma.InputJsonValue,
        failureReason: message.slice(0, 3900),
      },
    });
    // Partial spend is already metered; the hold must not keep counting on top.
    await reconcile(deps.prisma, tenant, `research-run-${run.id}`, logger);
    logger.error({ err: message }, 'Research run failed');
    throw error;
  }
}
