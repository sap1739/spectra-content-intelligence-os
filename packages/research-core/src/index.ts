export { RESEARCH_PROVIDER_KINDS } from './providers';
export type {
  AnyResearchProvider,
  CommunityResearchProvider,
  CompetitorActivityQuery,
  CompetitorResearchProvider,
  ContentExtractionProvider,
  DiscoveredSource,
  DocumentResearchProvider,
  ExtractedContent,
  ExtractionInput,
  FactVerificationProvider,
  FeedItem,
  InternalKnowledgeHit,
  InternalKnowledgeProvider,
  NewsSearchProvider,
  ProviderIdentity,
  RSSProvider,
  ResearchProviderKind,
  SearchQueryInput,
  TrendSignalProvider,
  TrendSignalWindow,
  VerificationAssessment,
  VerificationEvidence,
  VideoResearchProvider,
  WebSearchProvider,
} from './providers';
export {
  DuplicateProviderError,
  ProviderNotFoundError,
  ResearchProviderRegistry,
} from './registry';
export { RESEARCH_STAGE_ORDER, canAdvanceStage, stageIndex } from './pipeline';
export type { PipelineStageHandler, StageExecutionContext, StageResult } from './pipeline';
export { FixtureWebSearchProvider } from './fixtures';
