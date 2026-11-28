import type {
  AiAccountNeed,
  ProfileSetupStep,
  ResumeImportRun,
  ResumeImportTextStage,
} from "@nestor/contracts";

/**
 * Which setup step shows what each section of the resume read fills in.
 * Basics holds the header (name, contact, summary); Work history holds
 * both the jobs and the records under them (education, skills, projects);
 * Extras holds the reusable evidence and answers.
 */
const STEP_BY_TEXT_STAGE: Record<ResumeImportTextStage, ProfileSetupStep> = {
  identity_summary: "essentials",
  experience: "background",
  background: "background",
  shared_memory: "extras",
};

/**
 * The setup steps whose part of the last resume read never finished. A
 * stage the AI was refused or that stopped is not "Ready to review": the
 * step holds only what the built-in reader found, or nothing.
 *
 * A read the AI refused outright fails before any stage is recorded. While
 * an AI account is refusing calls, that read waits on it for every section
 * the AI reads, so those steps say so too. Without a refusal the failed run
 * says nothing per section, and the steps keep what they said.
 */
export function getUnreadImportSetupSteps(
  run: ResumeImportRun | null | undefined,
  options: { aiAccountRefusing?: boolean } = {},
): ProfileSetupStep[] {
  if (
    run?.status === "failed" &&
    run.failureKind === "ai_unavailable" &&
    options.aiAccountRefusing
  )
    return ["essentials", "background"];
  const stages = run?.timing?.textStages ?? [];
  return [
    ...new Set(
      stages
        .filter((stage) => stage.status !== "completed")
        .map((stage) => STEP_BY_TEXT_STAGE[stage.stage]),
    ),
  ];
}

/**
 * The stepper's word for a step whose section was not read. When an AI
 * account is refusing calls right now, the read waits on it, so the step
 * says what it is waiting on, in the same terms as the import notice.
 */
export function formatUnreadImportStepLabel(
  aiAccount: Pick<AiAccountNeed, "owner"> | null | undefined,
): string {
  if (!aiAccount) return "Not read yet";
  return aiAccount.owner === "nestor"
    ? "Waiting on Nestor's AI"
    : "Waiting on your AI account";
}
