import { describe, expect, test } from "vitest";

import { describeResumeImportStageFallback } from "./internal/resume-import-workflow";
import {
  createAiClient,
  createSeed,
  createProfileServiceHarness,
} from "./profile-service.test-support";
import {
  createStageCandidate,
  createTestBundle,
} from "./resume-import.test-support";

const RESUME_TEXT = ["Jamie Rivers", "Staff Frontend Engineer"].join("\n");

/**
 * A stage that loses its model call still returns usable candidates, so every
 * other signal in the run looks identical to a clean model run. These tests pin
 * the only two places the degradation is observable: the structured stage
 * timing, and the plain-language warning the user is shown.
 */
describe("degraded resume import stages", () => {
  test("records a truthful reason for each stage that fell back to the built-in reader", async () => {
    const seed = createSeed();
    const { profileWork } = createProfileServiceHarness({
      seed,
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage(input) {
          const degraded =
            input.stage === "identity_summary" || input.stage === "experience";

          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "deterministic" as const,
            analysisProviderLabel: "Test AI",
            candidates:
              input.stage === "identity_summary"
                ? [
                    createStageCandidate({
                      target: {
                        section: "identity",
                        key: "fullName",
                        recordId: null,
                      },
                      label: "Full name",
                      value: "Jamie Rivers",
                      sourceBlockIds: ["page_1_block_1"],
                      confidence: 0.95,
                    }),
                  ]
                : [],
            notes: [],
            ...(degraded
              ? {
                  fallback: {
                    kind:
                      input.stage === "identity_summary"
                        ? ("timeout" as const)
                        : ("provider_error" as const),
                    reason:
                      input.stage === "identity_summary"
                        ? "Model request timed out after 25s"
                        : "upstream stage failure",
                  },
                }
              : {}),
          });
        },
      },
    });

    const snapshot = await profileWork.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_stage_fallback",
        fileName: "resume.txt",
        textContent: RESUME_TEXT,
      },
      documentBundle: createTestBundle({ fullText: RESUME_TEXT }),
    });

    const run = snapshot.latestResumeImportRun;
    expect(run).toBeTruthy();

    const stageTimings = new Map(
      (run?.timing?.textStages ?? []).map((stage) => [stage.stage, stage]),
    );

    expect(stageTimings.get("identity_summary")?.fallbackKind).toBe("timeout");
    expect(stageTimings.get("identity_summary")?.fallbackReason).toBe(
      "Model request timed out after 25s",
    );
    expect(stageTimings.get("experience")?.fallbackKind).toBe("provider_error");
    expect(stageTimings.get("experience")?.fallbackReason).toBe(
      "upstream stage failure",
    );
    // A stage that reached the model must not be reported as degraded.
    expect(stageTimings.get("background")?.fallbackKind ?? null).toBeNull();
    expect(stageTimings.get("background")?.fallbackReason ?? null).toBeNull();

    // The run and the profile must both carry a non-null, plain-language
    // reason. Before this, both `warning` and `errorMessage` stayed null and
    // the user was told nothing at all.
    const identityMessage = describeResumeImportStageFallback({
      stage: "identity_summary",
      kind: "timeout",
    });
    const experienceMessage = describeResumeImportStageFallback({
      stage: "experience",
      kind: "provider_error",
    });

    expect(run?.warnings).toContain(identityMessage);
    expect(run?.warnings).toContain(experienceMessage);
    expect(run?.modelRoles?.text.warning).toBeTruthy();
    expect(snapshot.profile.baseResume.analysisWarnings).toContain(
      identityMessage,
    );
  });

  test("says nothing about a fallback when every stage reached the model", async () => {
    const seed = createSeed();
    const { profileWork } = createProfileServiceHarness({
      seed,
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage(input) {
          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "openai_compatible" as const,
            analysisProviderLabel: "Test AI",
            candidates: [],
            notes: [],
          });
        },
      },
    });

    const snapshot = await profileWork.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_stage_clean",
        fileName: "resume.txt",
        textContent: RESUME_TEXT,
      },
      documentBundle: createTestBundle({ fullText: RESUME_TEXT }),
    });

    const run = snapshot.latestResumeImportRun;
    expect(
      (run?.timing?.textStages ?? []).every(
        (stage) => stage.fallbackKind === null,
      ),
    ).toBe(true);
    expect(
      (run?.warnings ?? []).some((warning) =>
        warning.startsWith("Job Finder could not use the AI model for"),
      ),
    ).toBe(false);
  });

  test("names the affected part of the resume and what the reader can do", () => {
    expect(
      describeResumeImportStageFallback({
        stage: "experience",
        kind: "timeout",
      }),
    ).toBe(
      "Job Finder could not use the AI model for your work history because the model did not answer in time. It filled that part with its built-in text reader instead, so check those details before you rely on them, or import the file again to retry.",
    );
    expect(
      describeResumeImportStageFallback({
        stage: "identity_summary",
        kind: "provider_error",
      }),
    ).toBe(
      "Job Finder could not use the AI model for your name, contact details, and summary because the model call failed. It filled that part with its built-in text reader instead, so check those details before you rely on them, or import the file again to retry.",
    );
  });
});
