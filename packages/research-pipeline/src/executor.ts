import type { EmbeddingProvider } from '@spectra/ai-core';
import type { ResearchRunStats } from '@spectra/contracts';
import { PgVectorStore, type Prisma, type SpectraPrismaClient } from '@spectra/database';
import {
  HashingEmbeddingProvider,
  LEXICAL_EMBEDDING_COLLECTION,
  type VectorStoreProvider,
} from '@spectra/knowledge-core';
import type { Logger } from '@spectra/logging';
import { buildObjectKey, type ObjectStorageProvider } from '@spectra/storage';

import { extractClaims } from './claims';
import {
  DEFAULT_TREND_SCORING_CONFIG,
  WeightedTrendScoringEngine,
  canTransitionTrend,
} from '@spectra/trend-core';

import { HtmlExtractionProvider } from './extraction';
import { sha256Hex, titleKey, urlHash } from './hashing';
import { FirstPartyRssProvider } from './rss';
import { assertSafeUrl, type SafeFetchOptions } from './safe-fetch';
import {
  credibilityScore,
  domainOf,
  freshnessScore,
  sourceDiversityScore,
  velocityScore,
} from './signals';

export const PIPELINE_VERSION = 'rss-pipeline/1.0.0';
const MAX_ITEMS_PER_FEED = 50;
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
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger.child({ runId: input.runId });
  const rss = new FirstPartyRssProvider(deps.fetchOptions);
  const extraction = new HtmlExtractionProvider();
  const engine = new WeightedTrendScoringEngine(deps.scoringConfig ?? DEFAULT_TREND_SCORING_CONFIG);
  const embedder = deps.embedder ?? new HashingEmbeddingProvider();
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
    if (feedUrls.length === 0) {
      throw new Error('Run has no feed URLs in its query plan');
    }
    stats.queriesPlanned = feedUrls.length;

    // ----- SOURCE_DISCOVERY / RETRIEVAL / EXTRACTION ----------------------
    await setStage('SOURCE_DISCOVERY', 10);
    const seenTitleKeys = new Map<string, string>(); // titleKey → sourceId (near-dup in run)

    for (const [feedIndex, feedUrl] of feedUrls.entries()) {
      checkAbort();
      try {
        const { feedTitle, items } = await rss.fetchFeedWithMeta(feedUrl);
        stats.queriesExecuted += 1;

        for (const item of items.slice(0, MAX_ITEMS_PER_FEED)) {
          checkAbort();
          try {
            assertSafeUrl(item.url, deps.fetchOptions?.allowPrivateHosts ?? false);
          } catch {
            continue; // hostile/invalid item link — skip silently
          }
          const domain = domainOf(item.url);
          if (blockedDomains.some((b) => domain === b || domain.endsWith(`.${b}`))) {
            continue;
          }
          stats.sourcesDiscovered += 1;

          // Exact duplicate: URL already ingested in this workspace.
          const uHash = urlHash(item.url);
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

          const rawHtml = item.contentHtml ?? item.summary ?? item.title ?? '';
          const extracted = await extraction.extract(
            { html: rawHtml, sourceUrl: item.url },
            tenant,
          );
          const text = extracted.text;
          const fullText = `${item.title ?? ''}\n${text}`;

          if (excludedKeywords.length > 0 && matchKeywords(fullText, excludedKeywords).length > 0) {
            continue; // vertical explicitly excludes this content
          }

          const publishedAt = item.publishedAt ? new Date(item.publishedAt) : null;
          const contentHash = sha256Hex(text || item.url);
          const credibility = credibilityScore(domain, trustedDomains);
          const freshness = freshnessScore(publishedAt, now());
          const blocked = extracted.injectionRisk?.disposition === 'BLOCK';

          // Near-duplicates: identical extracted content anywhere in the
          // workspace, or same normalized title within this run.
          const tKey = item.title ? titleKey(item.title) : null;
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

          const source = await deps.prisma.researchSource.create({
            data: {
              organizationId: tenant.organizationId,
              workspaceId: tenant.workspaceId,
              projectId: run.projectId,
              runId: run.id,
              url: item.url,
              urlHash: uHash,
              title: item.title ?? null,
              publisher: feedTitle ?? domain,
              author: item.author ?? null,
              publishedAt,
              retrievedAt: now(),
              language: item.language ?? null,
              category: 'NEWS',
              credibilityScore: credibility,
              freshnessScore: freshness,
              contentHash,
              duplicateOfSourceId: nearDupOfId,
              duplicateClusterKey: nearDupOfId ? contentHash : null,
              provenance: {
                providerId: rss.id,
                providerKind: rss.kind,
                requestRef: feedUrl,
                retrievedAt: now().toISOString(),
                pipelineVersion: PIPELINE_VERSION,
              },
              processingStatus: blocked ? 'SKIPPED' : nearDupOfId ? 'DEDUPLICATED' : 'EXTRACTED',
              metadata: blocked ? { injectionRiskLevel: extracted.injectionRisk?.riskLevel } : {},
            },
          });
          if (tKey && !nearDupOfId) seenTitleKeys.set(tKey, source.id);

          // Immutable snapshot of the raw item content → object storage.
          const storageKey = buildObjectKey({
            organizationId: tenant.organizationId,
            workspaceId: tenant.workspaceId,
            domain: 'research-snapshots',
            resourceId: source.id,
            filename: 'item.html',
          });
          await deps.storage.putObject({
            key: storageKey,
            body: rawHtml || item.url,
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
              sizeBytes: Buffer.byteLength(rawHtml || item.url, 'utf8'),
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
              summary: item.title ?? text.slice(0, 180) ?? item.url,
              excerpt: text.slice(0, 800) || null,
              credibilityScore: credibility,
              freshnessScore: freshness,
              language: item.language ?? null,
              sourceCategory: 'NEWS',
              topics,
              entities: [],
              provenance: {
                providerId: rss.id,
                providerKind: rss.kind,
                requestRef: feedUrl,
                retrievedAt: now().toISOString(),
                pipelineVersion: PIPELINE_VERSION,
              },
              status: 'PENDING_REVIEW',
              processingStage: 'HUMAN_REVIEW',
            },
          });
          await deps.prisma.researchSource.update({
            where: { id: source.id },
            data: { processingStatus: 'ANALYZED' },
          });
          stats.findingsExtracted += 1;

          // CLAIM_EXTRACTION: heuristic claims, corroborated across sources.
          const heuristicClaims = extractClaims(`${item.title ?? ''}. ${text}`);
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
              url: item.url,
              title: item.title ?? null,
              publisher: feedTitle ?? domain,
              publishedAt,
              retrievedAt: now(),
              excerpt: text.slice(0, excerptLength) || null,
              startOffset: 0,
              endOffset: excerptLength,
            },
          });

          // KNOWLEDGE_BASE_STORAGE: lexical embedding → pgvector.
          const embedText = `${item.title ?? ''}\n${text.slice(0, 1500)}`.trim();
          if (embedText.length > 0) {
            const [vector] = await embedder.embed([embedText], tenant);
            await vectorStore.upsertChunks({
              tenant,
              collection: LEXICAL_EMBEDDING_COLLECTION,
              chunks: [
                {
                  chunk: {
                    id: finding.id,
                    organizationId: tenant.organizationId,
                    workspaceId: tenant.workspaceId,
                    documentId: source.id,
                    index: 0,
                    text: `${item.title ?? ''} — ${text.slice(0, 500)}`.trim(),
                    headingPath: [],
                    metadata: {
                      kind: 'RESEARCH_FINDING',
                      findingId: finding.id,
                      projectId: run.projectId,
                      sourceUrl: item.url,
                      title: item.title ?? null,
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        feedErrors.push(`${feedUrl}: ${message}`);
        logger.warn({ feedUrl, err: message }, 'Feed processing failed');
      }
      await setStage(
        'CONTENT_EXTRACTION',
        10 + Math.round(((feedIndex + 1) / feedUrls.length) * 50),
      );
    }

    // ----- DUPLICATE_DETECTION marker (work happened inline above) --------
    await setStage('DUPLICATE_DETECTION', 65);

    // ----- TREND_SCORING ---------------------------------------------------
    await setStage('TREND_SCORING', 75);
    if (keywords.length > 0) {
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
          source: { select: { publishedAt: true, publisher: true } },
        },
      });

      for (const keyword of keywords) {
        checkAbort();
        const topicFindings = findings.filter((f) => f.topics.includes(keyword));
        if (topicFindings.length === 0) continue;

        const distinctSources = new Set(topicFindings.map((f) => f.sourceId));
        const publishers = new Set(topicFindings.map((f) => f.source.publisher ?? 'unknown'));
        const observedAt = (f: (typeof topicFindings)[number]) =>
          f.source.publishedAt ?? f.createdAt;
        const recentCount = topicFindings.filter((f) => observedAt(f) >= recentStart).length;
        const avg = (values: number[]) =>
          values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

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
              freshness: avg(topicFindings.map((f) => f.freshnessScore ?? 0)),
              velocity: velocityScore(recentCount, topicFindings.length),
              sourceDiversity: sourceDiversityScore(publishers.size, topicFindings.length),
              sourceCredibility: avg(topicFindings.map((f) => f.credibilityScore ?? 0.5)),
            },
            sourceCount: distinctSources.size,
          },
          now,
        );

        const config = deps.scoringConfig ?? DEFAULT_TREND_SCORING_CONFIG;
        const canVerify = distinctSources.size >= config.minimumSourceCount;
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

        // EVIDENCE_PACK_GENERATION: one living pack per topic per project.
        const topicFindingIds = topicFindings.map((f) => f.id);
        const packClaims = await deps.prisma.extractedClaim.findMany({
          where: {
            organizationId: tenant.organizationId,
            projectId: run.projectId,
            supportingFindingIds: { hasSome: topicFindingIds },
          },
          select: { id: true },
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
    logger.error({ err: message }, 'Research run failed');
    throw error;
  }
}
