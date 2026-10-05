export { assessEvidence, cautionGuidance, isWritable } from './evidence-gate';
export type { GateInput, GateOptions, GateSource } from './evidence-gate';
export { CTA_LIBRARY, STRATEGY_ENGINE_VERSION, buildStrategy } from './strategy-engine';
export type {
  EnginePersonaRecord,
  EngineTrend,
  EngineVertical,
  StrategyEngineInput,
} from './strategy-engine';
export { buildPlan, orchestrationRunKey } from './plan';
export type { PlanInput } from './plan';
export { executeOrchestration } from './executor';
export type { OrchestrationContext, OrchestrationDeps, OrchestrationResult } from './executor';
