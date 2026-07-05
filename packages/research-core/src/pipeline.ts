import {
  RESEARCH_PIPELINE_STAGES,
  type ResearchPipelineStage,
  type ResearchRun,
  type TenantScope,
} from '@spectra/contracts';

/**
 * Pipeline stage sequencing. The 22-stage research pipeline is defined in
 * @spectra/contracts; this module encodes ordering rules and the stage
 * handler port that Phase 2 workers will implement.
 */

export const RESEARCH_STAGE_ORDER: readonly ResearchPipelineStage[] = RESEARCH_PIPELINE_STAGES;

export function stageIndex(stage: ResearchPipelineStage): number {
  return RESEARCH_STAGE_ORDER.indexOf(stage);
}

/** A stage may only advance forward; retries re-enter the same stage. */
export function canAdvanceStage(
  from: ResearchPipelineStage | null,
  to: ResearchPipelineStage,
): boolean {
  if (from === null) return to === RESEARCH_STAGE_ORDER[0];
  const fromIdx = stageIndex(from);
  const toIdx = stageIndex(to);
  return toIdx === fromIdx || toIdx === fromIdx + 1;
}

export interface StageExecutionContext {
  runId: string;
  tenant: TenantScope;
  correlationId: string;
  signal: AbortSignal;
}

export interface StageResult {
  stage: ResearchPipelineStage;
  status: 'COMPLETED' | 'FAILED' | 'SKIPPED';
  itemsProcessed?: number;
  detail?: string;
}

/** Implemented per stage by Phase 2 research workers. */
export interface PipelineStageHandler {
  readonly stage: ResearchPipelineStage;
  execute(run: ResearchRun, context: StageExecutionContext): Promise<StageResult>;
}
