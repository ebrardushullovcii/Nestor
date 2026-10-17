import type { ResumeImportRun } from "@nestor/contracts";

/**
 * The one text stage that is deterministic by design. It never had a model
 * call to lose, so counting it as an "AI stage" would overstate the
 * denominator of the quality hint.
 */
const DETERMINISTIC_TEXT_STAGE = "shared_memory";

export interface ResumeImportStageFallbackSummary {
  /** Stages that ran the built-in reader after losing their model call. */
  fallbackStageCount: number;
  /** Stages that were meant to use the configured model at all. */
  modelStageCount: number;
  /** Short, countable status hint, e.g. `2 of 3 AI stages used the built-in reader`. */
  hint: string;
}

/**
 * Summarizes how much of an import fell back to the built-in reader, using the
 * run's own recorded stage timings. Returns `null` when the run has no stage
 * data or when nothing degraded: a hint is only worth showing when it says
 * something the user did not already assume, and a count that is not backed by
 * recorded stages is not a count worth printing.
 */
export function getResumeImportStageFallbackSummary(
  run: ResumeImportRun | null | undefined,
): ResumeImportStageFallbackSummary | null {
  const stages = run?.timing?.textStages ?? [];
  const modelStages = stages.filter(
    (stage) => stage.stage !== DETERMINISTIC_TEXT_STAGE,
  );

  if (modelStages.length === 0) {
    return null;
  }

  const fallbackStageCount = modelStages.filter(
    (stage) => stage.fallbackKind !== null,
  ).length;

  if (fallbackStageCount === 0) {
    return null;
  }

  return {
    fallbackStageCount,
    modelStageCount: modelStages.length,
    // "1 of 3 AI stages" asked the reader to picture a pipeline; this says
    // what it means for them.
    hint:
      fallbackStageCount === modelStages.length
        ? "The built-in reader handled this import instead of AI, so check the imported details closely"
        : `The built-in reader handled ${fallbackStageCount} of ${modelStages.length} import steps instead of AI`,
  };
}
