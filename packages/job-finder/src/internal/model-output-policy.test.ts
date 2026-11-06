import { expect, test, vi } from "vitest";
import {
  createDeterministicJobFinderAiClient,
  type JobFinderAiClient,
} from "@nestor/ai-providers";
import {
  JobDiscoveryTargetSchema,
  ResumeDraftSchema,
  SourceDebugRunRecordSchema,
  SourceInstructionArtifactSchema,
} from "@nestor/contracts";
import { createSeed } from "../test-fixtures";
import { writeResumeLanguage } from "./resume-workspace-language";
import { reviewSourceInstructionArtifactWithAi } from "./source-instruction-review";

const at = "2026-11-06T00:00:00.000Z";

test("whole-resume translation keeps every field without setting a per-call output cap", async () => {
  const draft = ResumeDraftSchema.parse({
    id: "synthetic",
    jobId: "job_ready",
    templateId: "classic_ats",
    status: "draft",
    createdAt: at,
    updatedAt: at,
    sections: [
      {
        id: "summary",
        kind: "summary",
        label: "Summary",
        text: "Builds reliable interfaces",
        origin: "ai_generated",
        sortOrder: 0,
        updatedAt: at,
      },
    ],
  });
  const chatWithTools = vi.fn<NonNullable<JobFinderAiClient["chatWithTools"]>>(
    (messages) => {
      const payload = JSON.parse(messages[1]!.content) as {
        fields: Array<{ id: string; text: string }>;
      };
      return Promise.resolve({
        content: JSON.stringify({
          language: "English",
          listingLanguage: "English",
          translations: payload.fields,
        }),
      });
    },
  );
  const result = await writeResumeLanguage({
    aiClient: { chatWithTools },
    draft,
    job: createSeed().savedJobs[0]!,
  });
  expect(result.sections[0]?.text).toBe(draft.sections[0]?.text);
  expect(chatWithTools.mock.calls[0]?.[2]).not.toHaveProperty(
    "maxOutputTokens",
  );
});

test("source instruction review leaves output capacity to the configured model", async () => {
  const target = JobDiscoveryTargetSchema.parse({
    id: "source",
    label: "Synthetic careers",
    startingUrl: "https://careers.example/",
  });
  const run = SourceDebugRunRecordSchema.parse({
    id: "run",
    targetId: target.id,
    startedAt: at,
    updatedAt: at,
    targetLabel: target.label,
    targetUrl: target.startingUrl,
    targetHostname: "careers.example",
  });
  const heuristicInstruction = SourceInstructionArtifactSchema.parse({
    id: "instruction",
    targetId: target.id,
    createdAt: at,
    updatedAt: at,
    basedOnRunId: run.id,
    versionInfo: {
      promptProfileVersion: "v1",
      toolsetVersion: "v1",
      adapterVersion: "v1",
    },
  });
  const chatWithTools = vi
    .fn<NonNullable<JobFinderAiClient["chatWithTools"]>>()
    .mockResolvedValue({ content: "{}" });
  await reviewSourceInstructionArtifactWithAi({
    aiClient: { ...createDeterministicJobFinderAiClient(), chatWithTools },
    target,
    run,
    adapterKind: "target_site",
    verification: null,
    instructionUnderReview: null,
    heuristicInstruction,
    phaseContexts: [
      {
        phase: "search_filter_probe",
        phaseGoal: "Read listings",
        successCriteria: [],
        stopConditions: [],
        knownFactsAtStart: [],
        startedAt: at,
        completedAt: at,
        outcome: "succeeded",
        completionMode: "structured_finish",
        completionReason: null,
        resultSummary: "Read listings",
        blockerSummary: null,
        confirmedFacts: [],
        attemptedActions: [],
        phaseEvidence: null,
        visualEvidence: [],
        compactionState: null,
        reviewTranscript: [],
      },
    ],
    compactionPolicy: { enabled: false },
    modelContextWindowTokens: 128_000,
  });
  expect(chatWithTools).toHaveBeenCalledTimes(1);
  expect(chatWithTools.mock.calls[0]?.[2]).not.toHaveProperty(
    "maxOutputTokens",
  );
});
