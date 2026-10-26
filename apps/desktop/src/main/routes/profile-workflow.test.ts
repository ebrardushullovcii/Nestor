import { describe, expect, it, vi } from "vitest";
import {
  ProfileWorkflowCheckSiteInputSchema,
  ProfileWorkflowCommandSchema,
  type SourceDebugRunRecord,
} from "@nestor/contracts";

vi.mock("../services/job-store", () => ({ getJobStore: vi.fn() }));
const { describeResumeImport, describeSiteCheck } =
  await import("./profile-workflow");

const run = (state: string, extra: object = {}) =>
  ({
    id: `run_${state}`,
    targetId: "7",
    state,
    updatedAt: "2026-10-26T12:00:00.000Z",
    finalSummary: null,
    manualPrerequisiteSummary: null,
    ...extra,
  }) as unknown as SourceDebugRunRecord;

describe("profile workflow commands", () => {
  it("accepts only the listed commands, each with its own input", () => {
    expect(
      ProfileWorkflowCommandSchema.safeParse({ type: "read" }).success,
    ).toBe(true);
    for (const command of [
      { type: "save_profile", profile: {} },
      { type: "read", extra: true },
      { type: "save_setup_state", state: { status: "done" } },
      { type: "apply_review_action", input: { reviewItemId: "x" } },
      {},
      null,
    ])
      expect(ProfileWorkflowCommandSchema.safeParse(command).success).toBe(
        false,
      );
    expect(
      ProfileWorkflowCheckSiteInputSchema.safeParse({
        targetId: "7",
        requestId: "r",
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe("describeSiteCheck", () => {
  it.each([
    [null, "The site check finished without saving reusable guidance."],
    [run("idle"), "Checking this site now."],
    [run("running"), "Still checking this site."],
    [
      run("paused_manual", { manualPrerequisiteSummary: "Sign in first." }),
      "Sign in first.",
    ],
    [
      run("failed", { finalSummary: "Blocked by a sign-in." }),
      "Blocked by a sign-in.",
    ],
    [run("cancelled"), "The site check was cancelled before it could finish."],
    [run("completed", { finalSummary: "Saved guidance." }), "Saved guidance."],
  ])("%#", (checked, sentence) => {
    expect(describeSiteCheck(checked)).toBe(sentence);
  });
});

describe("describeResumeImport", () => {
  const imported = (extractionStatus: string, errorMessage?: string) =>
    ({
      profile: { baseResume: { fileName: "cv.pdf", extractionStatus } },
      latestResumeImportRun: errorMessage ? { errorMessage } : null,
    }) as unknown as Parameters<typeof describeResumeImport>[0];

  it("only a ready import claims extracted details", () => {
    expect(describeResumeImport(imported("ready"))).toContain(
      "Review the extracted details",
    );
    expect(describeResumeImport(imported("needs_text"))).toContain(
      "no text could be read",
    );
    expect(describeResumeImport(imported("failed", "It broke."))).toBe(
      "It broke.",
    );
    expect(describeResumeImport(imported("not_started"))).toContain(
      "not been extracted yet",
    );
  });
});
