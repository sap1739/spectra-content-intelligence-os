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
  /** Turns PDF/DOCX/TXT bytes into anchored text (Phase 5G). */
  'document-extraction',
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
  /** Raw item HTML (content:encoded / description / atom content) when present. */
  contentHtml?: string;
  publishedAt?: string;
  author?: string;
  language?: string;
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

// ---------------------------------------------------------------------------
// Document extraction (Phase 5G — ADR-0031)
// ---------------------------------------------------------------------------

/** Document formats the pipeline can turn into evidence. */
export type ExtractableDocumentType = 'PDF' | 'DOCX' | 'TXT' | 'MARKDOWN';

/** Where a citation points inside a document. */
export type DocumentAnchorKind = 'PAGE' | 'SECTION' | 'LINE' | 'CHARACTER_RANGE';

/**
 * A precise, re-locatable position inside an extracted document.
 *
 * The whole point of extracting a PDF rather than keeping a snippet is that a
 * claim can be traced back to the page it came from. An anchor always carries a
 * character range (so the exact text can be re-read) plus the human-meaningful
 * locator for its document type.
 */
export interface DocumentCitationAnchor {
  kind: DocumentAnchorKind;
  /** 1-based, PDF only. */
  pageNumber?: number;
  /** 0-based section index, DOCX/Markdown. */
  sectionOrder?: number;
  /** 1-based inclusive line range, plain text. */
  lineStart?: number;
  lineEnd?: number;
  /** Offsets into `ExtractedDocument.text`; always present. */
  charStart: number;
  charEnd: number;
  /** Display form, e.g. "p. 12" or "§ Methodology". */
  label: string;
}

export interface ExtractedPage {
  /** 1-based. */
  pageNumber: number;
  text: string;
  charStart: number;
  charEnd: number;
}

export interface ExtractedSection {
  /** 0-based position in reading order. */
  order: number;
  heading?: string;
  /** 1 = top-level heading. Absent for body-only sections. */
  level?: number;
  text: string;
  charStart: number;
  charEnd: number;
}

export interface ExtractedDocumentMetadata {
  title?: string;
  author?: string;
  /** ISO-8601 UTC, when the document states one. */
  createdAt?: string;
  modifiedAt?: string;
  pageCount?: number;
  mimeType: string;
  sizeBytes: number;
  /** Producing application, when stated (PDF Producer/Creator). */
  producer?: string;
  language?: string;
}

export interface ExtractedDocument {
  documentType: ExtractableDocumentType;
  /** Full plain text; anchors index into this string. */
  text: string;
  /** PDFs only; empty for formats without pagination. */
  pages: ExtractedPage[];
  /** DOCX/Markdown; empty when the format has no section structure. */
  sections: ExtractedSection[];
  metadata: ExtractedDocumentMetadata;
  /** Ready-made anchors, one per page or section. */
  anchors: DocumentCitationAnchor[];
  /** MANDATORY: extracted document text is untrusted external content. */
  injectionRisk?: PromptInjectionRisk;
  /**
   * Non-fatal problems (e.g. some pages yielded no text). The document is still
   * usable; the warnings say what is missing so partial extraction is never
   * presented as complete.
   */
  warnings: string[];
}

export type DocumentExtractionFailureCode =
  | 'UNSUPPORTED_MIME'
  | 'FILE_TOO_LARGE'
  | 'ENCRYPTED'
  | 'CORRUPT'
  | 'NO_TEXT_LAYER'
  | 'PARSER_ERROR';

/**
 * A truthful extraction failure. Returned, not thrown, so the pipeline can keep
 * the source with an honest reason rather than dropping it or silently
 * degrading it to a snippet with no explanation.
 */
export interface DocumentExtractionFailure {
  code: DocumentExtractionFailureCode;
  /** Operator-facing, specific. */
  message: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface DocumentExtractionInput {
  bytes: Uint8Array;
  /** Content-Type as served, or inferred from the filename. */
  mimeType: string;
  /** Origin URL or an object-storage reference. Recorded as provenance. */
  sourceRef: string;
  /** Original filename, when known. */
  filename?: string;
}

export type DocumentExtractionResult =
  { ok: true; document: ExtractedDocument } | { ok: false; failure: DocumentExtractionFailure };

/**
 * Turns document bytes into anchored, injection-scanned text.
 *
 * Implementations MUST enforce their own MIME and size limits and MUST run the
 * prompt-injection scan — extracted document text reaches prompts exactly like
 * scraped web content and is no more trustworthy.
 */
export interface DocumentExtractionProvider extends ProviderIdentity {
  readonly kind: 'document-extraction';
  /** Whether this provider will attempt the given type at all. */
  supports(mimeType: string, filename?: string): boolean;
  extract(input: DocumentExtractionInput, tenant: TenantScope): Promise<DocumentExtractionResult>;
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
