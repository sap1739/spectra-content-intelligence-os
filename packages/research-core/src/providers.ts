import type {
  ExtractedClaim,
  PromptInjectionRisk,
  SourceCategory,
  TenantScope,
  TrendSignal,
} from '@spectra/contracts';

/**
 * Provider-neutral research provider contracts.
 *
 * NO paid provider is implemented in Phase 1 — these ports define what any
 * future adapter (search APIs, news APIs, RSS, community sources, …) must
 * satisfy. Fixture implementations exist solely for tests and offline dev.
 * See docs/RESEARCH_PROVIDER_STRATEGY.md.
 */

export const RESEARCH_PROVIDER_KINDS = [
  'web-search',
  'news-search',
  'trend-signal',
  'rss',
  'community-research',
  'video-research',
  'competitor-research',
  'document-research',
  'internal-knowledge',
  'content-extraction',
  'fact-verification',
] as const;
export type ResearchProviderKind = (typeof RESEARCH_PROVIDER_KINDS)[number];

/** Common identity every provider adapter exposes. */
export interface ProviderIdentity {
  readonly id: string;
  readonly kind: ResearchProviderKind;
  readonly displayName: string;
  /** True for fixture/dev providers that must never run in production. */
  readonly isFixture?: boolean;
}

export interface SearchQueryInput {
  queryText: string;
  language?: string;
  geography?: string;
  maxResults?: number;
  publishedAfter?: string;
  publishedBefore?: string;
}

/** A discovered source before retrieval — the raw output of discovery. */
export interface DiscoveredSource {
  url: string;
  title?: string;
  snippet?: string;
  publisher?: string;
  publishedAt?: string;
  language?: string;
  category: SourceCategory;
  providerRank?: number;
}

export interface WebSearchProvider extends ProviderIdentity {
  readonly kind: 'web-search';
  search(query: SearchQueryInput, tenant: TenantScope): Promise<DiscoveredSource[]>;
}

export interface NewsSearchProvider extends ProviderIdentity {
  readonly kind: 'news-search';
  searchNews(query: SearchQueryInput, tenant: TenantScope): Promise<DiscoveredSource[]>;
}

export interface TrendSignalWindow {
  from: string;
  to: string;
  granularity?: 'hour' | 'day' | 'week' | 'month';
}

export interface TrendSignalProvider extends ProviderIdentity {
  readonly kind: 'trend-signal';
  fetchSignals(
    topic: string,
    window: TrendSignalWindow,
    tenant: TenantScope,
  ): Promise<TrendSignal[]>;
}

export interface FeedItem {
  url: string;
  title?: string;
  summary?: string;
  publishedAt?: string;
  author?: string;
}

export interface RSSProvider extends ProviderIdentity {
  readonly kind: 'rss';
  fetchFeed(feedUrl: string, tenant: TenantScope): Promise<FeedItem[]>;
}

export interface CommunityResearchProvider extends ProviderIdentity {
  readonly kind: 'community-research';
  searchDiscussions(query: SearchQueryInput, tenant: TenantScope): Promise<DiscoveredSource[]>;
}

export interface VideoResearchProvider extends ProviderIdentity {
  readonly kind: 'video-research';
  searchVideos(query: SearchQueryInput, tenant: TenantScope): Promise<DiscoveredSource[]>;
}

export interface CompetitorActivityQuery {
  competitorName: string;
  websiteUrl?: string;
  window: { from: string; to: string };
}

export interface CompetitorResearchProvider extends ProviderIdentity {
  readonly kind: 'competitor-research';
  findCompetitorActivity(
    query: CompetitorActivityQuery,
    tenant: TenantScope,
  ): Promise<DiscoveredSource[]>;
}

export interface DocumentResearchProvider extends ProviderIdentity {
  readonly kind: 'document-research';
  searchDocuments(query: SearchQueryInput, tenant: TenantScope): Promise<DiscoveredSource[]>;
}

export interface InternalKnowledgeHit {
  documentId: string;
  chunkId?: string;
  title?: string;
  excerpt?: string;
  score: number;
}

export interface InternalKnowledgeProvider extends ProviderIdentity {
  readonly kind: 'internal-knowledge';
  /** Tenant scope is mandatory: internal documents never cross tenants. */
  search(query: SearchQueryInput, tenant: TenantScope): Promise<InternalKnowledgeHit[]>;
}

export interface ExtractionInput {
  /** Either raw bytes reference (object storage key) or inline HTML/text. */
  storageKey?: string;
  html?: string;
  text?: string;
  sourceUrl?: string;
}

export interface ExtractedContent {
  text: string;
  title?: string;
  author?: string;
  publishedAt?: string;
  language?: string;
  /** Injection assessment MUST run on all extracted external content. */
  injectionRisk?: PromptInjectionRisk;
}

export interface ContentExtractionProvider extends ProviderIdentity {
  readonly kind: 'content-extraction';
  extract(input: ExtractionInput, tenant: TenantScope): Promise<ExtractedContent>;
}

export interface VerificationEvidence {
  findingIds: string[];
  sourceUrls: string[];
}

export interface VerificationAssessment {
  claimText: string;
  verdict: 'SUPPORTED' | 'PARTIALLY_SUPPORTED' | 'UNSUPPORTED' | 'CONTRADICTED' | 'INCONCLUSIVE';
  confidence: number;
  rationale?: string;
  supportingSourceUrls: string[];
}

export interface FactVerificationProvider extends ProviderIdentity {
  readonly kind: 'fact-verification';
  verify(
    claim: Pick<ExtractedClaim, 'text' | 'claimType'>,
    evidence: VerificationEvidence,
    tenant: TenantScope,
  ): Promise<VerificationAssessment>;
}

export type AnyResearchProvider =
  | WebSearchProvider
  | NewsSearchProvider
  | TrendSignalProvider
  | RSSProvider
  | CommunityResearchProvider
  | VideoResearchProvider
  | CompetitorResearchProvider
  | DocumentResearchProvider
  | InternalKnowledgeProvider
  | ContentExtractionProvider
  | FactVerificationProvider;
